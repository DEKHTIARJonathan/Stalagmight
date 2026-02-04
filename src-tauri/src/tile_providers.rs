//! Tile provider registry and URL template expansion.
//!
//! Contains the static registry of known tile providers (initially ESRI only),
//! lookup functions, and URL template expansion.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Internal tile provider definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileProvider {
    /// Short identifier (e.g. "esri")
    #[serde(default)]
    pub name: String,
    /// Human-readable label (e.g. "ESRI World Imagery")
    #[serde(default)]
    pub display_label: String,
    /// URL template with `{z}`, `{y}`, `{x}` placeholders
    #[serde(default)]
    pub url_template: String,
    /// Attribution text
    #[serde(default)]
    pub attribution: String,
    /// Tile pixel size (typically 256)
    #[serde(default)]
    pub tile_size: u32,
    /// Minimum zoom level
    #[serde(default)]
    pub min_zoom: u32,
    /// Maximum zoom level
    #[serde(default)]
    pub max_zoom: u32,
    /// Expected content type hint (e.g. "image/jpeg")
    #[serde(default)]
    pub content_type_hint: String,
    /// Environment variable name holding an API key, if required
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// HTTP header name used for authentication, if required
    #[serde(default)]
    pub auth_header: Option<String>,
}

/// Response DTO returned by IPC commands — includes all `TileProvider` fields
/// plus a computed `available` flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileProviderInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_label: String,
    #[serde(default)]
    pub url_template: String,
    #[serde(default)]
    pub attribution: String,
    #[serde(default)]
    pub tile_size: u32,
    #[serde(default)]
    pub min_zoom: u32,
    #[serde(default)]
    pub max_zoom: u32,
    #[serde(default)]
    pub content_type_hint: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub auth_header: Option<String>,
    /// `true` when no API key is required, or the required env var is set.
    #[serde(default)]
    pub available: bool,
}

/// Static registry of known tile providers, initialised once via `OnceLock`.
static REGISTRY: OnceLock<HashMap<String, TileProvider>> = OnceLock::new();

/// Build the default provider map (called once).
fn init_registry() -> HashMap<String, TileProvider> {
    let mut map = HashMap::new();
    map.insert(
        "esri".to_string(),
        TileProvider {
            name: "esri".to_string(),
            display_label: "ESRI World Imagery".to_string(),
            url_template:
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    .to_string(),
            attribution: "© Esri, Maxar, Earthstar Geographics".to_string(),
            tile_size: 256,
            min_zoom: 1,
            max_zoom: 22,
            content_type_hint: "image/jpeg".to_string(),
            api_key_env: None,
            auth_header: None,
        },
    );
    map
}

/// Return a reference to the lazily-initialised registry.
fn registry() -> &'static HashMap<String, TileProvider> {
    REGISTRY.get_or_init(init_registry)
}

/// Look up a provider by name.
pub fn get_provider(name: &str) -> Option<&'static TileProvider> {
    registry().get(name)
}

/// Return info for every registered provider, with a computed `available` flag.
pub fn get_all_provider_info() -> Vec<TileProviderInfo> {
    registry()
        .values()
        .map(|p| {
            let available = match &p.api_key_env {
                None => true,
                Some(key) => std::env::var(key).is_ok(),
            };
            TileProviderInfo {
                name: p.name.clone(),
                display_label: p.display_label.clone(),
                url_template: p.url_template.clone(),
                attribution: p.attribution.clone(),
                tile_size: p.tile_size,
                min_zoom: p.min_zoom,
                max_zoom: p.max_zoom,
                content_type_hint: p.content_type_hint.clone(),
                api_key_env: p.api_key_env.clone(),
                auth_header: p.auth_header.clone(),
                available,
            }
        })
        .collect()
}

/// Expand `{z}`, `{y}`, `{x}` placeholders in a provider's URL template.
pub fn expand_url(provider: &TileProvider, z: u32, y: u32, x: u32) -> String {
    provider
        .url_template
        .replace("{z}", &z.to_string())
        .replace("{y}", &y.to_string())
        .replace("{x}", &x.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_lookup_returns_esri() {
        let provider = get_provider("esri");
        assert!(provider.is_some());
        let p = provider.unwrap();
        assert_eq!(p.name, "esri");
        assert_eq!(p.display_label, "ESRI World Imagery");
        assert_eq!(p.tile_size, 256);
        assert_eq!(p.min_zoom, 1);
        assert_eq!(p.max_zoom, 22);
        assert_eq!(p.content_type_hint, "image/jpeg");
        assert!(p.api_key_env.is_none());
        assert!(p.auth_header.is_none());
    }

    #[test]
    fn test_registry_lookup_unknown_returns_none() {
        assert!(get_provider("unknown_provider").is_none());
    }

    #[test]
    fn test_expand_url_produces_correct_url() {
        let provider = get_provider("esri").unwrap();
        let url = expand_url(provider, 10, 500, 250);
        assert_eq!(
            url,
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/500/250"
        );
    }

    #[test]
    fn test_get_all_provider_info_non_empty_with_available() {
        let infos = get_all_provider_info();
        assert!(!infos.is_empty());
        let esri = infos.iter().find(|i| i.name == "esri").unwrap();
        assert!(esri.available);
    }

    #[test]
    fn test_tile_provider_info_serializes_with_available_field() {
        let infos = get_all_provider_info();
        let esri = infos.iter().find(|i| i.name == "esri").unwrap();
        let json = serde_json::to_value(esri).unwrap();
        assert!(json.get("available").is_some());
        assert_eq!(json["available"], true);
        assert!(json.get("name").is_some());
        assert!(json.get("display_label").is_some());
        assert!(json.get("url_template").is_some());
        assert!(json.get("attribution").is_some());
        assert!(json.get("tile_size").is_some());
        assert!(json.get("min_zoom").is_some());
        assert!(json.get("max_zoom").is_some());
        assert!(json.get("content_type_hint").is_some());
    }

    #[test]
    fn test_provider_with_missing_api_key_env_not_available() {
        let provider = TileProvider {
            name: "test".to_string(),
            display_label: "Test Provider".to_string(),
            url_template: "https://example.com/{z}/{y}/{x}".to_string(),
            attribution: "Test".to_string(),
            tile_size: 256,
            min_zoom: 0,
            max_zoom: 18,
            content_type_hint: "image/png".to_string(),
            api_key_env: Some("STALAGMIGHT_TEST_MISSING_KEY_12345".to_string()),
            auth_header: None,
        };

        // Env var should not be set, so available should be false
        let available = match &provider.api_key_env {
            None => true,
            Some(key) => std::env::var(key).is_ok(),
        };
        assert!(!available);
    }
}
