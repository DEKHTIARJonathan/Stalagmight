//! Authentication publication and rejection are backend ownership boundaries.
use super::speleodb::local_dto;
use super::AppState;
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::{client, SpeleoDbError, SpeleoErrorDto, SpeleoLoginResult};

impl AppState {
    pub(super) fn speleodb_forget(&self) {
        let _project = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Ends a SpeleoDB edit session by construction (`speleodb_edit_gate`): the
        // bump leaves any claim's binding stale and the forgotten account matches no
        // claim, so the gate of an open linked project shuts - while an open LOCAL
        // project, which a dead token surfacing as a 401 on ANY SpeleoDB call (e.g. a
        // background list_projects / refresh) reaches too, stays editable without
        // this having to ask which one is open. The claims themselves survive: each
        // is still the only pointer to a mutex the account may hold, for after the
        // next sign-in.
        self.bump_speleodb_session();
        if let Ok(mut session) = self.speleodb_session_lock() {
            session.forget();
        }
        if let Err(error) = self.speleodb_clear_saved_token() {
            tracing::warn!(error = %error.message, "Failed to remove rejected SpeleoDB token");
        }
    }

    /// Log in: exchange email+password for a token (or accept a pasted `token`),
    /// store it backend-side, and record the session. The token never crosses
    /// back to the webview - only the account email and instance.
    pub fn speleodb_login(
        &self,
        override_endpoint: Option<String>,
        email: Option<String>,
        password: Option<String>,
        token: Option<String>,
    ) -> Result<SpeleoLoginResult, SpeleoErrorDto> {
        let entry_generation = {
            let _project = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.speleodb_session_generation()
        };
        let endpoint = self
            .speleodb_resolve_endpoint(override_endpoint.as_deref())
            .ok_or(SpeleoDbError::NoEndpoint)
            .map_err(local_dto)?;
        // [Track A] #187: read the override and thread it into every client call.
        let insecure_http = self.speleodb_insecure_http();

        let (token, email) =
            if let Some(t) = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
                let email = client::fetch_user_email(&endpoint, &t, insecure_http)
                    .map_err(|e| dto_for_error(Endpoint::User, &e))?;
                (t, email)
            } else {
                let email = email.map(|e| e.trim().to_owned()).unwrap_or_default();
                let password = password.unwrap_or_default();
                // Reject blank credentials at the boundary rather than POSTing them
                // and relying on the server to 400.
                if email.is_empty() || password.is_empty() {
                    return Err(local_dto(SpeleoDbError::MissingCredentials));
                }
                let token = client::login(&endpoint, insecure_http, &email, &password)
                    .map_err(|e| dto_for_error(Endpoint::Login, &e))?;
                (token, email)
            };

        let _lock_ops = self.speleodb_lock_ops_guard();
        // Match cache-install lock ordering; never acquire project under config.
        let _project = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.speleodb_session_generation() != entry_generation {
            return Err(local_dto(SpeleoDbError::SessionMoved));
        }
        // Persist before publishing a successful login. A failed write must be
        // visible, rather than silently losing the session on the next launch.
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = config.speleodb.clone();
        config.speleodb.endpoint = Some(endpoint.clone());
        config.speleodb.email = Some(email.clone());
        config.speleodb.token.0 = Some(token.clone());
        config.speleodb.preserve_unreadable_file = false;
        if config.save_speleodb().is_err() {
            config.speleodb = previous;
            return Err(local_dto(SpeleoDbError::Io(
                "Could not save SpeleoDB configuration".to_owned(),
            )));
        }
        let mut session = self.speleodb_session_lock().map_err(local_dto)?;
        // A new identity/token must verify ownership before editing resumes: the
        // bump leaves any claim's edit binding stale, which shuts a linked
        // project's gate (`speleodb_edit_gate`) until Start Editing binds again.
        self.bump_speleodb_session();
        session.token_store.store(&endpoint, &email, &token);
        session.endpoint = Some(endpoint.clone());
        session.email = Some(email.clone());
        session.rehydrate_attempted = true;
        Ok(SpeleoLoginResult {
            user_email: email,
            endpoint,
        })
    }
}
