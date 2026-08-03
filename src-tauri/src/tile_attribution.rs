//! Live data-source attribution for tile providers.
//!
//! Esri requires the *names of the sources* behind its imagery to stay visible
//! wherever that imagery is drawn, and tells integrators to read those names
//! from the service at runtime rather than hard-coding them, because the list
//! changes. See
//! <https://developers.arcgis.com/documentation/esri-and-data-attribution/interactive-maps/>.
//!
//! This module does exactly that: it GETs the provider's service-metadata
//! endpoint (`service_info_url`) and reads `copyrightText`. The result is cached
//! in memory with a long TTL - the string changes on the order of once a year,
//! so re-asking more often than daily is pure noise.
//!
//! **It never fails outward.** Offline, timed out, or malformed, the caller gets
//! the registry's own `attribution` string with `live: false`. Attribution that
//! degrades to a slightly stale-but-correct list beats attribution that
//! disappears when the network does, and this app is expected to run offline in
//! the field.
//!
//! The separate "Powered by Esri" notice is carried here too, but only so the
//! frontend can fetch both in one call - that one is allowed to live behind a
//! menu or button, and the app credits it in the About dialog.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::tile_providers;

/// HTTP request timeout for the service-metadata fetch.
///
/// Deliberately short: this is decoration on a map that is already drawing, and
/// the fallback is a correct string. Blocking a worker thread for longer buys
/// nothing.
const ATTRIBUTION_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a fetched attribution string is trusted before it is re-fetched.
const ATTRIBUTION_TTL: Duration = Duration::from_hours(24);

/// How long a *failed* fetch suppresses further attempts.
///
/// Without this, a map panning offline re-attempts (and re-blocks for the
/// timeout) on every call. The fallback string is already being displayed, so
/// there is nothing to gain from retrying tightly.
const ATTRIBUTION_FAILURE_BACKOFF: Duration = Duration::from_mins(5);

/// Ceiling on the attribution string, in characters.
///
/// `copyrightText` is remote text that ends up in a DOM node and a `title=`
/// tooltip. React escapes it, so this is not an injection guard - it is a size
/// guard: a compromised or misconfigured endpoint should not be able to put
/// megabytes into the layout, or into the `split(',')` the collapsed chip runs
/// over it. Esri's own line is ~66 characters, so the cap is ~8x the real thing.
const MAX_ATTRIBUTION_CHARS: usize = 512;

/// Attribution for one tile provider, as handed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TileAttribution {
    /// Provider this describes (e.g. "esri").
    pub provider: String,
    /// Data-source names. MUST be displayed wherever the imagery is drawn.
    pub text: String,
    /// Provider notice ("Powered by Esri"), which may live behind a button.
    pub notice: Option<String>,
    /// Brand URL for `notice`.
    pub notice_url: Option<String>,
    /// `true` when `text` came from the provider's live service metadata,
    /// `false` when it is the compiled-in fallback.
    pub live: bool,
}

/// Service-metadata response. ArcGIS returns a large document; the only field
/// that matters here is the copyright line.
#[derive(Deserialize)]
struct ServiceInfo {
    #[serde(rename = "copyrightText")]
    copyright_text: Option<String>,
}

/// What the cache remembers about one provider.
enum CacheEntry {
    /// A live string, good until `fetched_at + ATTRIBUTION_TTL`.
    Live { text: String, fetched_at: Instant },
    /// A failed attempt; do not retry until `failed_at + ATTRIBUTION_FAILURE_BACKOFF`.
    Failed { failed_at: Instant },
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read `copyrightText` from a provider's service-metadata endpoint.
fn fetch_copyright_text(url: &str) -> Result<String, String> {
    tracing::debug!(url = %url, "Fetching tile attribution");

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(ATTRIBUTION_FETCH_TIMEOUT))
        .build()
        .new_agent();

    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Attribution network error: {e}"))?;

    let body = response
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("Failed to read attribution response: {e}"))?;

    parse_copyright_text(&body)
}

/// Parse `copyrightText` out of a service-metadata body.
///
/// Split from the network call so the parse is testable without a server.
fn parse_copyright_text(body: &[u8]) -> Result<String, String> {
    let info: ServiceInfo = serde_json::from_slice(body)
        .map_err(|e| format!("Failed to parse attribution JSON: {e}"))?;

    // Control characters stripped and length capped before the string goes
    // anywhere near the UI: this is untrusted remote text.
    let text: String = info
        .copyright_text
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_ATTRIBUTION_CHARS)
        .collect();
    let text = text.trim().to_string();

    if text.is_empty() {
        // An empty copyright line is not an attribution - fall back rather than
        // display nothing where names are required.
        return Err("Service metadata carried no copyrightText".to_string());
    }

    Ok(text)
}

/// Resolve the attribution for `provider_name`.
///
/// Blocking: run it off the UI thread. Returns the compiled-in fallback for an
/// unknown provider, an offline machine, or a provider with no metadata
/// endpoint - never an error.
pub fn get_attribution(provider_name: &str) -> TileAttribution {
    let Some(provider) = tile_providers::get_provider(provider_name) else {
        // Unknown provider: nothing to attribute, but the caller still gets a
        // well-formed answer rather than an error to render around.
        return TileAttribution {
            provider: provider_name.to_string(),
            text: String::new(),
            notice: None,
            notice_url: None,
            live: false,
        };
    };

    let fallback = |live_text: Option<String>| TileAttribution {
        provider: provider.name.clone(),
        live: live_text.is_some(),
        text: live_text.unwrap_or_else(|| provider.attribution.clone()),
        notice: provider.attribution_notice.clone(),
        notice_url: provider.attribution_url.clone(),
    };

    let Some(url) = provider.service_info_url.as_ref() else {
        return fallback(None);
    };

    // Cache hit, or a recent failure we agreed not to retry yet.
    {
        // A poisoned lock means some other thread panicked mid-update. The cache
        // holds nothing that cannot be re-fetched, so treat it as a miss rather
        // than propagating the panic into every future call.
        if let Ok(guard) = cache().lock() {
            match guard.get(&provider.name) {
                Some(CacheEntry::Live { text, fetched_at })
                    if fetched_at.elapsed() < ATTRIBUTION_TTL =>
                {
                    return fallback(Some(text.clone()));
                }
                Some(CacheEntry::Failed { failed_at })
                    if failed_at.elapsed() < ATTRIBUTION_FAILURE_BACKOFF =>
                {
                    return fallback(None);
                }
                _ => {}
            }
        }
    }

    match fetch_copyright_text(url) {
        Ok(text) => {
            if let Ok(mut guard) = cache().lock() {
                guard.insert(
                    provider.name.clone(),
                    CacheEntry::Live {
                        text: text.clone(),
                        fetched_at: Instant::now(),
                    },
                );
            }
            tracing::debug!(provider = %provider.name, attribution = %text, "Live tile attribution");
            fallback(Some(text))
        }
        Err(e) => {
            if let Ok(mut guard) = cache().lock() {
                guard.insert(
                    provider.name.clone(),
                    CacheEntry::Failed {
                        failed_at: Instant::now(),
                    },
                );
            }
            tracing::debug!(
                provider = %provider.name,
                error = %e,
                "Tile attribution fetch failed; using compiled-in source names"
            );
            fallback(None)
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_copyright_text() {
        let body = br#"{"currentVersion":11.4,"copyrightText":"Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community","serviceDescription":"..."}"#;
        assert_eq!(
            parse_copyright_text(body).unwrap(),
            "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community"
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let body = br#"{"copyrightText":"  Source: Esri  "}"#;
        assert_eq!(parse_copyright_text(body).unwrap(), "Source: Esri");
    }

    #[test]
    fn rejects_missing_copyright_text() {
        // Well-formed metadata that simply carries no copyright line must fall
        // back, not display an empty attribution.
        let body = br#"{"currentVersion":11.4}"#;
        assert!(parse_copyright_text(body).is_err());
    }

    #[test]
    fn rejects_empty_copyright_text() {
        let body = br#"{"copyrightText":"   "}"#;
        assert!(parse_copyright_text(body).is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_copyright_text(b"not json at all").is_err());
    }

    #[test]
    fn unknown_provider_yields_empty_attribution_not_an_error() {
        let attribution = get_attribution("no_such_provider_12345");
        assert_eq!(attribution.provider, "no_such_provider_12345");
        assert!(attribution.text.is_empty());
        assert!(attribution.notice.is_none());
        assert!(!attribution.live);
    }

    /// The fallback is the thing that renders offline, so it has to be a real
    /// attribution on its own - not a placeholder waiting for the network.
    #[test]
    fn esri_fallback_names_the_sources() {
        let provider = tile_providers::get_provider("esri").unwrap();
        assert!(provider.attribution.contains("Esri"));
        assert!(provider.attribution.starts_with("Source:"));
        assert_eq!(
            provider.attribution_notice.as_deref(),
            Some("Powered by Esri")
        );
        assert_eq!(
            provider.attribution_url.as_deref(),
            Some("https://www.esri.com")
        );
        assert!(provider
            .service_info_url
            .as_ref()
            .is_some_and(|u| u.contains("f=json")));
    }

    #[test]
    fn attribution_serializes_with_every_field_the_ui_reads() {
        let attribution = TileAttribution {
            provider: "esri".to_string(),
            text: "Source: Esri".to_string(),
            notice: Some("Powered by Esri".to_string()),
            notice_url: Some("https://www.esri.com".to_string()),
            live: true,
        };
        let json = serde_json::to_value(&attribution).unwrap();
        assert_eq!(json["provider"], "esri");
        assert_eq!(json["text"], "Source: Esri");
        assert_eq!(json["notice"], "Powered by Esri");
        assert_eq!(json["notice_url"], "https://www.esri.com");
        assert_eq!(json["live"], true);
    }

    #[test]
    fn a_huge_copyright_line_is_capped_before_it_reaches_the_ui() {
        // Remote text that ends up in a DOM node and a title tooltip. React
        // escapes it, so this is a size guard, not an injection one.
        let huge = "A".repeat(100_000);
        let body = format!(r#"{{"copyrightText":"{huge}"}}"#);
        let text = parse_copyright_text(body.as_bytes()).unwrap();
        assert_eq!(text.chars().count(), MAX_ATTRIBUTION_CHARS);
    }

    #[test]
    fn control_characters_are_stripped_from_the_attribution() {
        let body = "{\"copyrightText\":\"Source: Esri\\u0000\\u0007, Vantor\"}";
        assert_eq!(
            parse_copyright_text(body.as_bytes()).unwrap(),
            "Source: Esri, Vantor"
        );
    }

    #[test]
    fn a_line_of_only_control_characters_is_not_an_attribution() {
        // Stripping must not turn junk into an empty string we then display.
        let body = "{\"copyrightText\":\"\\u0000\\u0001\\u0002\"}";
        assert!(parse_copyright_text(body.as_bytes()).is_err());
    }
}
