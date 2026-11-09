//! Automatic SpeleoDB transport policy. No DNS-based exceptions or overrides.
use super::SpeleoDbError;

/// Validate transport before credentials or requests leave the application.
pub fn validate_endpoint(endpoint: &str) -> Result<(), SpeleoDbError> {
    let rejected = || SpeleoDbError::InsecureEndpoint {
        endpoint: endpoint.to_owned(),
    };
    let _url = reqwest::Url::parse(endpoint).map_err(|_| rejected())?;
    let uri: http::Uri = endpoint.parse().map_err(|_| rejected())?;
    let host = uri.host().ok_or_else(rejected)?;
    if uri.authority().is_none() || uri.authority().is_some_and(|a| a.as_str().contains('@')) {
        return Err(rejected());
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
        _ => Err(rejected()),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_endpoint;
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
