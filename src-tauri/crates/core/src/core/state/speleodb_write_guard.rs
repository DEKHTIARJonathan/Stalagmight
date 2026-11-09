//! Fresh server ownership checks for remote writes. Local offline editing uses
//! the acquired session gate; uploads and metadata writes require connectivity.
use super::speleodb::{local_dto, lock_held_by_me};
use super::AppState;
use crate::models::SpeleoLink;
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::{client, Permission, SpeleoDbError, SpeleoErrorDto};

impl AppState {
    pub(super) fn speleodb_require_owned_lock(
        &self,
        link: &SpeleoLink,
    ) -> Result<(), SpeleoErrorDto> {
        if !self.edit_enabled() {
            return Err(local_dto(SpeleoDbError::Io(
                "acquire the editing lock before changing this project".to_owned(),
            )));
        }
        let generation = self.speleodb_session_generation();
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let project = self
            .speleodb_handle_auth(
                Endpoint::GetProject,
                client::get_project(
                    &endpoint,
                    &token,
                    self.speleodb_insecure_http(),
                    &link.project_id,
                ),
            )
            .map_err(|error| dto_for_error(Endpoint::GetProject, &error))?;
        let (now_endpoint, now_token) = self.speleodb_active_token().map_err(local_dto)?;
        if self.speleodb_session_generation() != generation
            || now_endpoint != endpoint
            || now_token != token
            || !self.edit_enabled()
        {
            return Err(local_dto(SpeleoDbError::Io(
                "the project or account changed; retry in the current session".to_owned(),
            )));
        }
        let holder = project
            .active_mutex
            .as_ref()
            .map(|mutex| mutex.user.as_str());
        let email = self.speleodb_my_email();
        if !project
            .permission
            .is_some_and(|permission| permission >= Permission::ReadAndWrite)
            || !lock_held_by_me(holder, email.as_deref())
        {
            self.set_edit_enabled(false);
            return Err(local_dto(SpeleoDbError::Io(
                "write permission or the editing lock was lost; resume editing before uploading"
                    .to_owned(),
            )));
        }
        Ok(())
    }
}
