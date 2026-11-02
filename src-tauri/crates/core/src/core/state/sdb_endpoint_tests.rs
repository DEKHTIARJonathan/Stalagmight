//! [#576 B5 / NF-AN3-3] How the SpeleoDB verbs classify what the server answered.
//!
//! The action on a `SpeleoErrorDto` is derived from the endpoint the error came
//! from (`contract::map_status`), and the endpoint was hand-picked at each call
//! site - so a write mapped as a read reported a 5xx as "already retried, try
//! again" over a request that ran once, and a retried call reported "never
//! retried". These drive the real verbs against a loopback stub that answers
//! every request the same way and records what it was asked.

use std::sync::{Arc, Mutex};

use super::speleodb::{editing_fixture, REMOTE_ID};
use crate::speleodb::{SpeleoDbAction, SpeleoDbError};

/// A loopback server answering EVERY request with `status` and a `{}` body,
/// recording each request line. The listener is returned so the caller keeps
/// the port bound for the whole test.
fn status_stub(status: u16) -> (String, std::net::TcpListener, Arc<Mutex<Vec<String>>>) {
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let accept_on = listener.try_clone().expect("clone listener");
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = accept_on.accept() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(150)));
            let mut req = Vec::new();
            let mut chunk = vec![0u8; 8 * 1024];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                req.extend_from_slice(chunk.get(..n).unwrap_or_default());
            }
            let text = String::from_utf8_lossy(&req).into_owned();
            if let Ok(mut lines) = log.lock() {
                lines.push(text.lines().next().unwrap_or_default().to_owned());
            }
            let resp = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                 Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    (format!("http://127.0.0.1:{port}"), listener, seen)
}

fn requests(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    seen.lock().expect("request log").clone()
}

#[test]
fn a_metadata_patch_that_fails_with_a_5xx_is_a_write_failure_not_a_retried_read() {
    // [#576 B5] `patch_project` runs once (a PATCH must not double-apply), but its
    // errors were mapped as `GetProject` - a read - so a 503 came back as `Retry`
    // ("the transport already retried this read") over a write it never retried.
    let (base, _listener, seen) = status_stub(503);
    let (_temp, state) = editing_fixture(&base);

    let err = state
        .speleodb_set_exclude_geojson(false)
        .expect_err("the server refused the PATCH");

    let seen = requests(&seen);
    println!(
        "metadata PATCH answered 503 -> action {:?} after {} request(s)",
        err.action,
        seen.len()
    );
    assert_eq!(seen.len(), 1, "the PATCH runs once: {seen:?}");
    assert_eq!(
        err.action,
        SpeleoDbAction::StayDirty,
        "a write that may or may not have landed is StayDirty, not a retried read"
    );
}

#[test]
fn release_all_that_fails_with_a_5xx_says_it_was_retried() {
    // [#576 B5] `release_all_locks` IS retried (releasing when nothing is held is a
    // no-op), but its errors were mapped through `Release`, whose 5xx row is
    // StayDirty - "writes are never auto-retried" - after three attempts.
    let (base, _listener, seen) = status_stub(503);
    let (_temp, state) = editing_fixture(&base);

    let err = state
        .speleodb_release_all_locks()
        .expect_err("the server refused the release");

    let seen = requests(&seen);
    println!(
        "release-all answered 503 -> action {:?} after {} request(s)",
        err.action,
        seen.len()
    );
    assert_eq!(seen.len(), 3, "an idempotent call is retried: {seen:?}");
    assert_eq!(
        err.action,
        SpeleoDbAction::Retry,
        "an exhausted retry of an idempotent call is Retry"
    );
}

#[test]
fn deleting_a_project_the_server_already_deleted_unlinks_the_local_copy() {
    // [#576 NF-AN3-3] A delete whose reply was lost leaves the project gone on the
    // server; the next attempt (the user's, or the transport's own retry) gets 404.
    // That was a hard error, and the unlink only ran on success - so the local copy
    // stayed linked to a project the server no longer has.
    let (base, _listener, seen) = status_stub(404);
    let (_temp, state) = editing_fixture(&base);

    let result = state.speleodb_delete_project();

    let seen = requests(&seen);
    let deletes = seen
        .iter()
        .filter(|r| r.starts_with(&format!("DELETE /api/v2/projects/{REMOTE_ID}/")))
        .count();
    let still_linked = state.speleodb_open_link().is_ok();
    println!(
        "delete answered 404 -> {:?}; local copy still linked: {still_linked}",
        result.as_ref().map_err(|e| e.message.clone())
    );
    assert_eq!(deletes, 1, "one DELETE reached the server: {seen:?}");
    assert!(
        result.is_ok(),
        "a 404 from the DELETE means it is already gone"
    );
    assert!(
        matches!(
            state.speleodb_open_link(),
            Err(SpeleoDbError::NoRemoteProject)
        ),
        "and the copy is unlinked, like any other successful delete"
    );
}
