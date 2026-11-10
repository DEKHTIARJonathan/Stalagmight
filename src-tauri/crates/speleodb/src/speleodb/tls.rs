//! Automatic SpeleoDB transport policy. No DNS-based exceptions or overrides.
use super::SpeleoDbError;

/// Characters that copy-paste carries around an address without the user seeing
/// them: zero-width space/joiners, word joiner, BOM, soft hyphen and the bidi
/// marks/embeddings/isolates. None of them is Unicode `White_Space`, so
/// `str::trim` keeps them.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Clean an endpoint as the user entered it (typed or pasted): strip leading and
/// trailing whitespace and invisible format characters. `None` when nothing is
/// left. Interior characters are kept, so a genuinely malformed address still
/// fails [`validate_endpoint`] - this only removes what the user cannot see and
/// did not mean. Every place an endpoint enters the app (settings save, settings
/// reload, login override, `DEV_SPELEODB_URL`) runs it before validating, and
/// the cleaned value is what gets stored.
pub fn clean_endpoint_input(input: &str) -> Option<String> {
    let cleaned = input.trim_matches(|c: char| c.is_whitespace() || is_invisible_format(c));
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

/// Validate transport before credentials or requests leave the application.
///
/// Strict on purpose: this is the transport security boundary, so it does not
/// clean its input - callers run [`clean_endpoint_input`] first. An address that
/// does not parse as an absolute `scheme://host` URL is
/// [`SpeleoDbError::InvalidEndpoint`]; a well-formed one whose scheme/host fails
/// the policy is [`SpeleoDbError::InsecureEndpoint`].
pub fn validate_endpoint(endpoint: &str) -> Result<(), SpeleoDbError> {
    let invalid = || SpeleoDbError::InvalidEndpoint {
        endpoint: endpoint.to_owned(),
    };
    let insecure = || SpeleoDbError::InsecureEndpoint {
        endpoint: endpoint.to_owned(),
    };
    let _url = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
    let uri: http::Uri = endpoint.parse().map_err(|_| invalid())?;
    let host = uri.host().ok_or_else(invalid)?;
    if uri.scheme_str().is_none()
        || uri.authority().is_none()
        || uri.authority().is_some_and(|a| a.as_str().contains('@'))
    {
        return Err(invalid());
    }
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http")
            if host.eq_ignore_ascii_case("localhost")
                || host == "127.0.0.1"
                || host
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.octets()[..2] == [192, 168]) =>
        {
            Ok(())
        }
        _ => Err(insecure()),
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_endpoint_input, validate_endpoint};
    use crate::speleodb::SpeleoDbError;

    #[test]
    fn clean_strips_only_what_the_user_cannot_see_at_the_ends() {
        for (input, expected) in [
            ("https://www.speleodb.org", Some("https://www.speleodb.org")),
            ("  https://www.speleodb.org \r\n", Some("https://www.speleodb.org")),
            ("\u{00A0}https://www.speleodb.org\u{3000}", Some("https://www.speleodb.org")),
            ("\u{200B}\u{FEFF}https://www.speleodb.org\u{2060}", Some("https://www.speleodb.org")),
            ("\u{200E}https://www.speleodb.org\u{202C}\u{00AD}", Some("https://www.speleodb.org")),
            // Interior characters are the user's; validation decides about them.
            ("https://www.speleo db.org", Some("https://www.speleo db.org")),
            ("https://www.speleo\u{200B}db.org", Some("https://www.speleo\u{200B}db.org")),
            ("", None),
            (" \t\n\u{200B}\u{FEFF} ", None),
        ] {
            assert_eq!(clean_endpoint_input(input).as_deref(), expected, "{input:?}");
        }
    }

    #[test]
    fn malformed_is_invalid_and_policy_failure_is_insecure() {
        for endpoint in [
            "https://www.speleodb.org ",
            " https://www.speleodb.org",
            "https://www.speleo db.org",
            "localhost:8000",
            "www.speleodb.org",
            "http://localhost@evil.com",
            "",
        ] {
            assert!(
                matches!(validate_endpoint(endpoint), Err(SpeleoDbError::InvalidEndpoint { .. })),
                "{endpoint:?}"
            );
        }
        for endpoint in ["http://example.com", "http://10.0.0.1", "ftp://localhost"] {
            assert!(
                matches!(validate_endpoint(endpoint), Err(SpeleoDbError::InsecureEndpoint { .. })),
                "{endpoint:?}"
            );
        }
    }

    #[test]
    fn rejection_message_quotes_and_escapes_the_endpoint() {
        let msg = validate_endpoint("https://www.speleodb.org\u{200B}")
            .unwrap_err()
            .to_string();
        assert!(msg.starts_with("\"https://www.speleodb.org\\u{200b}\""), "{msg}");
        let msg = validate_endpoint("http://example.com").unwrap_err().to_string();
        assert!(msg.ends_with("Rejected endpoint: \"http://example.com\""), "{msg}");
    }
    #[test]
    fn allowed_patterns() {
        for endpoint in [
            "http://localhost",
            "http://LOCALHOST:8000/",
            "http://127.0.0.1:80",
            "http://192.168.0.0",
            "http://192.168.255.255:8000/",
            "https://example.com",
        ] {
            assert!(validate_endpoint(endpoint).is_ok(), "{endpoint}");
        }
    }
    #[test]
    fn rejected_patterns() {
        for endpoint in [
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://127.0.0.2",
            "http://[::1]",
            "http://169.254.1.1",
            "http://localhost.evil.com",
            "http://sub.localhost",
            "http://localhost.",
            "http://localhost@evil.com",
            "http://192.168.1.256",
            "http://192.168.example.com",
            "http://192.169.0.1",
            "http://192.167.255.255",
            "http://127.1",
            "http://2130706433",
            "http://192.168.001.1",
            "ftp://localhost",
            "localhost:8000",
            "http://example.com",
            "http://localhost:65536",
            "http://localhost:bad",
        ] {
            assert!(validate_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }
}
