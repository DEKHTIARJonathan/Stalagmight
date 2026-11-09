//! SpeleoDB settings. Persisted with the backend-only token in speleodb.conf.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SpeleoDbConfig {
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    /// Backend-only token. Excluded from IPC and from ordinary config serialization.
    #[serde(skip)]
    #[ts(skip)]
    pub token: super::auth::AuthToken,
    /// A failed auth-file load must survive unrelated preference saves.
    #[serde(skip)]
    #[ts(skip)]
    pub preserve_unreadable_file: bool,
    /// [Track C] (#187/D-B10/D-B19): allow an `http://` endpoint to a PUBLIC host.
    /// Off by default. Relaxes ONLY the public-http scheme block in
    /// `speleodb::tls::enforce` (Track A #187) - NEVER TLS cert verification
    /// (self-signed / internal CAs stay rejected). Pre-wired for #205 Settings;
    /// D-B19's scheme reject lives in `tls.rs`, not here.
    #[serde(default)]
    pub insecure_http: bool,
    /// [#303] Default undo policy for SpeleoDB-linked projects, under any
    /// per-project `speleo_link.undo_mode` override. Default
    /// [`UndoMode::Full`] - the hybrid stack the issue exists to deliver.
    ///
    /// This is the GLOBAL half of the two-level setting: it seeds projects that
    /// carry no override, so switching it changes every such project at once. It
    /// says nothing about local-only projects, which always keep the fixed window.
    #[serde(default)]
    pub undo_mode: crate::models::UndoMode,
}

impl Default for SpeleoDbConfig {
    fn default() -> Self {
        Self {
            endpoint: None,
            email: None,
            token: super::auth::AuthToken::default(),
            preserve_unreadable_file: false,
            insecure_http: false,
            undo_mode: crate::models::UndoMode::Full,
        }
    }
}
