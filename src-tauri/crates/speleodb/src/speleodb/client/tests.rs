//! Contract tests for only the operations Stalagmight calls.
#![expect(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "test setup and assertions"
)]
use super::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const ID: &str = "11111111-1111-1111-1111-111111111111";
const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

fn project_json() -> Value {
    json!({"id": ID, "name":"Synthetic cave", "description":"SDK test", "country":"US",
        "type":"STALAGMIGHT", "visibility":"PRIVATE", "permission":"ADMIN",
        "color":"#123456", "commit_count":0, "created_by":"test@example.com",
        "creation_date":"2026-01-01T00:00:00Z", "modified_date":"2026-01-01T00:00:00Z",
        "exclude_geojson":false, "fork_from":null, "is_active":true,
        "active_mutex":null, "latest_commit":null})
}
fn user_json() -> Value {
    json!({"email":"test@example.com", "name":"Test", "country":"US",
        "email_on_projects_updates":false, "email_on_speleodb_updates":false})
}

struct Server {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn replies(replies: Vec<(u16, Vec<u8>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        listener.set_nonblocking(true).expect("nonblocking");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            for (status, body) in replies {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(_) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                };
                stream
                    .set_nonblocking(false)
                    .expect("blocking accepted stream");
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .expect("timeout");
                let mut request = Vec::new();
                let mut buf = [0_u8; 4096];
                loop {
                    let n = stream.read(&mut buf).expect("request bytes");
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|h| {
                                h.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                captured
                    .lock()
                    .expect("requests")
                    .push(String::from_utf8_lossy(&request).into_owned());
                let content_type = if body.starts_with(b"SQLite") || body.first() == Some(&0) {
                    "application/octet-stream"
                } else {
                    "application/json"
                };
                let header = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",body.len());
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self {
            base,
            requests,
            worker: Some(worker),
        }
    }
    fn json(value: Value) -> Self {
        Self::replies(vec![(200, value.to_string().into_bytes())])
    }
    fn finish(mut self) -> Vec<String> {
        self.worker.take().expect("worker").join().expect("server");
        self.requests.lock().expect("requests").clone()
    }
}

#[test]
fn both_authentication_paths_use_the_sdk_contract() {
    let s = Server::json(json!({"token":"test-token","user":"test@example.com"}));
    assert_eq!(
        login(&s.base, false, "test@example.com", "test-password").unwrap(),
        "test-token"
    );
    let requests = s.finish();
    assert!(requests[0].starts_with("POST /api/v2/user/auth-token/ "));
    let body: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"email":"test@example.com","password":"test-password"})
    );
    let s = Server::json(user_json());
    assert_eq!(
        fetch_user_email(&s.base, "test-token", false).unwrap(),
        "test@example.com"
    );
    let r = s.finish();
    assert!(r[0].starts_with("GET /api/v2/user/ "));
    assert!(r[0]
        .to_lowercase()
        .contains("authorization: bearer test-token"));
}

#[test]
fn project_operations_preserve_permissions_locks_and_patch_nulls() {
    let mut projects: Vec<Value> = [
        "ARIANE",
        "COMPASS",
        "STICKMAPS",
        "THERION",
        "WALLS",
        "OTHER",
    ]
    .into_iter()
    .map(|kind| {
        let mut p = project_json();
        p["type"] = json!(kind);
        p
    })
    .collect();
    projects.insert(2, project_json());
    let s = Server::json(json!(projects));
    let listed = list_projects(&s.base, "t", false).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, "stalagmight");
    assert_eq!(listed[0].permission, Some(Permission::Admin));
    assert!(s.finish()[0].starts_with("GET /api/v2/projects/ "));
    let mut p = project_json();
    p["permission"] = json!("READ_ONLY");
    p["active_mutex"] = json!("other@example.com");
    for probe in [false, true] {
        let s = Server::json(p.clone());
        let result = if probe {
            get_project_probe(&s.base, "t", false, ID)
        } else {
            get_project(&s.base, "t", false, ID)
        }
        .unwrap();
        assert_eq!(result.permission, Some(Permission::ReadOnly));
        assert_eq!(result.active_mutex.unwrap().user, "other@example.com");
        assert!(s.finish()[0].starts_with(&format!("GET /api/v2/projects/{ID}/ ")));
    }
    let s = Server::replies(vec![(201, project_json().to_string().into_bytes())]);
    create_project_with(
        &s.base,
        "t",
        false,
        &json!({"name":"Synthetic","description":"Test","country":"US","type":"STALAGMIGHT"})
            .to_string(),
    )
    .unwrap();
    assert!(s.finish()[0].starts_with("POST /api/v2/projects/ "));
    let s = Server::json(project_json());
    patch_project(
        &s.base,
        "t",
        false,
        ID,
        r#"{"name":"Renamed","latitude":null,"longitude":null}"#,
    )
    .unwrap();
    let r = s.finish();
    let body: Value = serde_json::from_str(r[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"name":"Renamed","latitude":null,"longitude":null})
    );
    for (acquire, route) in [(true, "acquire"), (false, "release")] {
        let s = Server::json(project_json());
        if acquire {
            acquire_lock(&s.base, "t", false, ID)
        } else {
            release_lock(&s.base, "t", false, ID)
        }
        .unwrap();
        assert!(s.finish()[0].starts_with(&format!("POST /api/v2/projects/{ID}/{route}/ ")));
    }
}

#[test]
fn revisions_and_native_file_routes_are_exact() {
    let commit = json!({"id":SHA,"parent_ids":[],"author_email":"test@example.com","author_name":"Test","authored_date":"2026/01/01 00:00","dt_since":"now","message":"Test","formats":[],"tree":[],"url":null});
    let s = Server::json(json!({"project":project_json(),"commits":[commit]}));
    assert_eq!(
        get_revisions(&s.base, "t", false, ID).unwrap().commits[0].id,
        SHA
    );
    assert!(s.finish()[0].starts_with(&format!("GET /api/v2/projects/{ID}/revisions/ ")));
    let bytes = b"SQLite format 3\0synthetic bytes";
    for revision in [None, Some(SHA)] {
        let s = Server::replies(vec![(200, bytes.to_vec())]);
        let native = if let Some(sha) = revision {
            download_stalx_at_hash(&s.base, "t", false, ID, sha)
        } else {
            download_stalx(&s.base, "t", false, ID)
        }
        .unwrap();
        assert_eq!(std::fs::read(native.path()).unwrap(), bytes);
        let path = native.path().to_owned();
        drop(native);
        assert!(!path.exists());
        let suffix = revision.map(|sha| format!("/{sha}")).unwrap_or_default();
        assert!(s.finish()[0].starts_with(&format!(
            "GET /api/v2/projects/{ID}/download/stalagmight{suffix}/ "
        )));
    }
    let f = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(f.path(), bytes).unwrap();
    let s = Server::json(
        json!({"project":project_json(),"hexsha":SHA,"files":["project.stalx"],"geojson_status":"skipped","message":"Saved","browser_url":null}),
    );
    assert_eq!(
        upload_stalx(&s.base, "t", false, ID, f.path(), "My commit")
            .unwrap()
            .latest_commit
            .unwrap()
            .id,
        SHA
    );
    let r = s.finish();
    assert!(r[0].starts_with(&format!("PUT /api/v2/projects/{ID}/upload/stalagmight/ ")));
    assert_eq!(r[0].matches("filename=").count(), 1);
    assert!(r[0].contains("filename=\"project.stalx\""));
    assert!(r[0].contains("My commit"));
    assert!(r[0].contains("SQLite format 3\0synthetic bytes"));
}

#[test]
fn status_errors_and_malformed_success_remain_distinct() {
    for status in [304, 400, 401, 403, 404, 409, 429, 500] {
        let s = Server::replies(vec![(status, br#"{"detail":"Test failure"}"#.to_vec())]);
        let err = release_lock(&s.base, "t", false, ID).unwrap_err();
        assert!(matches!(err,SpeleoDbError::Status {status:s,..} if s==status));
        assert_eq!(s.finish().len(), 1, "mutations must never retry");
    }
    let s = Server::json(json!({"unexpected":"sensitive response text"}));
    let err = get_project(&s.base, "t", false, ID).unwrap_err();
    assert!(matches!(err, SpeleoDbError::Parse(_)));
    assert!(!err.to_string().contains("sensitive"));
    assert_eq!(s.finish().len(), 1);
    for status in [400, 401] {
        let s = Server::replies(vec![(status, b"{}".to_vec())]);
        assert!(login(&s.base, false, "bad@example.com", "bad").is_err());
        assert_eq!(s.finish().len(), 1);
    }
}

#[test]
fn reads_retry_transient_failures_and_native_streams_enforce_a_limit() {
    let s = Server::replies(vec![
        (503, b"{}".to_vec()),
        (200, user_json().to_string().into_bytes()),
    ]);
    assert!(fetch_user_email(&s.base, "t", false).is_ok());
    assert_eq!(s.finish().len(), 2);
    let s = Server::replies(vec![(200, vec![0; 1024])]);
    let c = SdkClient::new(
        &s.base,
        Some("t"),
        false,
        READ_TIMEOUT,
        Settings {
            native_limit: 10,
            ..Settings::default()
        },
    )
    .unwrap();
    assert!(matches!(c.download(ID, None), Err(SpeleoDbError::Parse(_))));
    assert_eq!(s.finish().len(), 1);
}

#[test]
#[expect(
    clippy::print_stderr,
    clippy::panic,
    reason = "opt-in live-test diagnostics and missing-credential assertions"
)]
fn live_used_api_calls_with_email_and_token() {
    // Read .env without mutating process-wide environment or making it an app config.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
    let file: std::collections::HashMap<String, String> = match dotenvy::from_path_iter(path) {
        Ok(values) => values.map(|v| v.expect("valid .env entry")).collect(),
        Err(_) => Default::default(),
    };
    let value = |name: &str| std::env::var(name).ok().or_else(|| file.get(name).cloned());
    if value("SPELEODB_API_TEST_ENABLED").as_deref() != Some("true") {
        eprintln!("live SpeleoDB API tests disabled; set SPELEODB_API_TEST_ENABLED=true");
        return;
    }
    let required = |name: &str| {
        value(name)
            .filter(|v| !v.trim().is_empty() && !v.contains("<placeholder>"))
            .unwrap_or_else(|| panic!("missing {name}; both authentication paths are required"))
    };
    let base = required("SPELEODB_INSTANCE_URL");
    let provided_token = required("SPELEODB_OAUTH_TOKEN");
    let email = required("SPELEODB_EMAIL");
    let password = required("SPELEODB_PASSWORD");
    let timeout = required("SPELEODB_API_TIMEOUT_MS")
        .parse::<u64>()
        .expect("timeout milliseconds");
    let retries = required("SPELEODB_API_RETRY_COUNT")
        .parse::<u32>()
        .expect("retry count");
    let settings = Settings {
        timeout: Some(Duration::from_millis(timeout)),
        retries,
        ..Settings::default()
    };
    let _settings = TestSettings::install(settings);
    let login_token = login(&base, false, &email, &password).expect("EMAIL authentication");
    assert!(fetch_user_email(&base, &login_token, false)
        .expect("EMAIL profile")
        .eq_ignore_ascii_case(&email));
    assert!(fetch_user_email(&base, &provided_token, false)
        .expect("TOKEN profile")
        .eq_ignore_ascii_case(&email));
    for (label, token) in [("EMAIL", login_token), ("TOKEN", provided_token)] {
        let project=create_project_with(&base,&token,false,&json!({"name":format!("Stalagmight SDK test {}",uuid::Uuid::new_v4()),"description":"Synthetic native-file API test; retained intentionally","country":"US","type":"STALAGMIGHT","visibility":"PRIVATE"}).to_string()).expect("create test-owned project");
        let id = &project.id;
        eprintln!("{label}: retained test project {id}");
        let result = std::panic::catch_unwind(|| {
            (|| -> Result<(), SpeleoDbError> {
                assert!(list_projects(&base, &token, false)?
                    .iter()
                    .any(|p| p.id == *id));
                get_project(&base, &token, false, id)?;
                get_project_probe(&base, &token, false, id)?;
                patch_project(
                    &base,
                    &token,
                    false,
                    id,
                    r#"{"description":"Native SQLite round trip"}"#,
                )?;
                acquire_lock(&base, &token, false, id)?;
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("project.stalx");
                {
                    let mut db =
                        stalagmight_persistence::persistence::Database::open(&path).unwrap();
                    db.save_project(&crate::models::Project::new(
                        "Synthetic first revision".into(),
                        None,
                    ))
                    .unwrap();
                }
                let first_bytes = std::fs::read(&path).unwrap();
                eprintln!("{label}: uploading first native file");
                let first =
                    upload_stalx(&base, &token, false, id, &path, "First synthetic revision")?
                        .latest_commit
                        .expect("first SHA")
                        .id;
                assert_eq!(
                    std::fs::read(download_stalx(&base, &token, false, id)?.path()).unwrap(),
                    first_bytes
                );
                assert!(matches!(
                    upload_stalx(&base, &token, false, id, &path, "No changes"),
                    Err(SpeleoDbError::Status { status: 304, .. })
                ));
                {
                    let mut db =
                        stalagmight_persistence::persistence::Database::open(&path).unwrap();
                    db.save_project(&crate::models::Project::new(
                        "Synthetic second revision".into(),
                        None,
                    ))
                    .unwrap();
                }
                eprintln!("{label}: uploading second native file");
                let second =
                    upload_stalx(&base, &token, false, id, &path, "Second synthetic revision")?
                        .latest_commit
                        .expect("second SHA")
                        .id;
                assert_ne!(first, second);
                let history = get_revisions(&base, &token, false, id)?;
                assert!(history.commits.iter().any(|c| c.id == first));
                assert!(history.commits.iter().any(|c| c.id == second));
                assert_eq!(
                    std::fs::read(download_stalx_at_hash(&base, &token, false, id, &first)?.path())
                        .unwrap(),
                    first_bytes
                );
                Ok(())
            })()
        });
        // Only the project this test just created is released. No remote deletion.
        let released = release_lock(&base, &token, false, id);
        result
            .expect("round-trip assertion")
            .expect("native-file round trip");
        released.expect("release test-owned lock");
    }
}

#[test]
fn profile_accepts_unset_country_but_rejects_other_invalid_profiles() {
    let mut profile = user_json();
    profile["country"] = json!("");
    let s = Server::json(profile.clone());
    assert_eq!(
        fetch_user_email(&s.base, "t", false).unwrap(),
        "test@example.com"
    );
    assert_eq!(s.finish().len(), 1);
    for country in ["invalid", ""] {
        profile["country"] = json!(country);
        profile["email"] = json!("");
        let s = Server::json(profile.clone());
        assert!(fetch_user_email(&s.base, "t", false).is_err());
        assert_eq!(s.finish().len(), 1);
    }
}
