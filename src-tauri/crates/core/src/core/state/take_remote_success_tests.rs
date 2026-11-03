//! [#576 E10] "Take remote" lands the server tip and discards the local edits.
//!
//! Driven end to end against a loopback stub that answers like SpeleoDB - the
//! revision history (a tip another account pushed on top of our BASE), the lock
//! release, and the dump at the tip, a ZIP built in this test around a synthetic
//! server project. The open project is the canonical cache copy, mid edit
//! session, with a local edit: after the call BASE is the tip, the dirty bit is
//! cleared, the project is read-only, the abandoning release went out, and the
//! local edit is gone (the open project is the server's).
//!
//! The verb resolves the cache path through the process-wide app dirs, a
//! `OnceLock` the other tests in this binary rely on staying unset (several
//! accept a linked file only because no cache root exists). So the body runs in a
//! process of its own: the test below re-runs this test binary on the ignored,
//! env-gated body, which points the app dirs at a private temp dir.
//!
//! All data is synthetic, built in code.

use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tempfile::TempDir;

use super::speleodb::{authed_session_at, REMOTE_ID};
use super::AppState;
use crate::core::Command;
use crate::models::{Project, SectionData, ShotData, SpeleoLink, UndoMode};
use crate::persistence::Database;

/// The environment variable that lets the child-process body run.
const CHILD_ENV: &str = "STALAGMIGHT_TAKE_REMOTE_CHILD";
/// The body's full test name, for the child's exact filter.
const CHILD_TEST: &str =
    "core::state::take_remote_success_tests::take_remote_body_in_a_process_of_its_own";

/// Our BASE, and the tip another account pushed on top of it (revision ids are
/// 40-hex shas: anything else is not pinned, and the dump comes from HEAD).
const BASE_SHA: &str = "abc1230000000000000000000000000000000000";
const TIP_SHA: &str = "def4560000000000000000000000000000000000";

/// Every JSON request: the project, its revision history and the release answer.
/// Our own account (`u@x`, `authed_session_at`) holds the lock.
fn project_json() -> String {
    format!(
        r#"{{"id":"{REMOTE_ID}","name":"Remote","active_mutex":{{"user":"u@x"}},
            "commits":[{{"id":"{TIP_SHA}","parent_ids":["{BASE_SHA}"],"author_email":"other@x"}},
                       {{"id":"{BASE_SHA}","parent_ids":[],"author_email":"u@x"}}]}}"#
    )
}

/// A project file holding one section named `section`.
fn project_file(path: &Path, name: &str, section: &str) {
    let mut project = Project::new(name.to_owned(), None);
    project.add_section(SectionData {
        name: Some(section.to_owned()),
        color: "#123456".to_owned(),
        shots: vec![ShotData {
            length: 4.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    Database::open(path)
        .expect("create")
        .save_project(&project)
        .expect("write");
}

/// The server's working tree at the tip: one `.stalx` entry, as SpeleoDB zips it.
fn dump_at_tip() -> Vec<u8> {
    let temp = TempDir::new().expect("temp");
    let server = temp.path().join("server.stalx");
    project_file(&server, "Server Copy", "ServerSection");
    let bytes = std::fs::read(&server).expect("read the server project");
    let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer
        .start_file("misc/project.stalx", opts)
        .expect("start entry");
    writer.write_all(&bytes).expect("write entry");
    writer.finish().expect("finish zip").into_inner()
}

/// A loopback stub routing by path - the dump at a hash gets `zip`, everything
/// else [`project_json`] - and recording every request line. Keep the listener
/// bound for the whole test.
fn routing_stub(zip: Vec<u8>) -> (String, std::net::TcpListener, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let accept_on = listener.try_clone().expect("clone listener");
    let log = Arc::clone(&seen);
    let json = project_json();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = accept_on.accept() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(150)));
            let mut request = Vec::new();
            let mut chunk = vec![0u8; 8 * 1024];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                request.extend_from_slice(chunk.get(..n).unwrap_or_default());
            }
            let line = String::from_utf8_lossy(&request)
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            let (content_type, body): (&str, &[u8]) = if line.contains("/download/dump/") {
                ("application/zip", &zip)
            } else {
                ("application/json", json.as_bytes())
            };
            if let Ok(mut lines) = log.lock() {
                lines.push(line);
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
            let _ = stream.flush();
        }
    });
    (format!("http://127.0.0.1:{port}"), listener, seen)
}

struct NoListener;

impl crate::core::events::EventSink for NoListener {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    fn with_app_state(&self, _f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        false
    }
}

#[test]
fn take_remote_lands_the_server_tip_and_discards_the_local_edits() {
    let exe = std::env::current_exe().expect("this test binary");
    let output = std::process::Command::new(exe)
        .args([
            CHILD_TEST,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, "1")
        .output()
        .expect("run the body in a process of its own");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    println!("{stdout}");
    assert!(
        output.status.success(),
        "the take-remote body failed:\n{stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("1 passed"),
        "the body ran (and was not filtered out): {stdout}"
    );
}

#[test]
#[ignore = "the child-process body of take_remote_lands_the_server_tip_and_discards_the_local_edits: \
            it sets the process-wide app dirs, so it runs only in a process of its own"]
fn take_remote_body_in_a_process_of_its_own() {
    if std::env::var_os(CHILD_ENV).is_none() {
        println!("not in the child process ({CHILD_ENV} unset): nothing to do");
        return;
    }
    let _cfg = crate::test_helpers::isolated_config();
    let dirs = TempDir::new().expect("app dirs");
    crate::app_dirs::init_paths(
        dirs.path().join("data"),
        dirs.path().join("config"),
        dirs.path().join("cache"),
        None,
    );
    let cache = super::speleodb_local_state::cache_root().expect("a cache root in this process");
    let dest = super::speleodb_local_state::cache_path_in(&cache, REMOTE_ID);
    std::fs::create_dir_all(dest.parent().expect("cache dir")).expect("create cache dir");

    // The canonical cache copy, linked at BASE, opened mid edit session.
    project_file(&dest, "Local Copy", "LocalSection");
    Database::open_existing(&dest)
        .expect("reopen")
        .save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://placeholder.invalid/".to_owned(),
            project_id: REMOTE_ID.to_owned(),
            project_name: "Remote".to_owned(),
            base_commit_sha: Some(BASE_SHA.to_owned()),
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: Some(chrono::Utc::now().to_rfc3339()),
            undo_mode: Some(UndoMode::Full),
        }))
        .expect("link");
    let (base, _listener, seen) = routing_stub(dump_at_tip());
    let state = AppState::new().expect("state");
    state.set_event_sink(Arc::new(NoListener));
    assert!(
        state.open_project(dest.clone()).success,
        "open the cache copy"
    );
    *state.speleodb.lock() = authed_session_at(&base);
    state.set_edit_enabled(true);
    state.speleodb_note_lock_acquired(Some(REMOTE_ID));
    let edit = state.execute(Command::CreateSection {
        name: Some("LocalEdit".to_owned()),
        surveyor: None,
        date: None,
        color: "#abcdef".to_owned(),
        direction: None,
        shots: vec![ShotData {
            length: 2.0,
            ..Default::default()
        }],
    });
    assert!(edit.success, "the local edit: {:?}", edit.error);
    assert!(
        state.speleodb_open_link().expect("link").has_unpushed_edits,
        "precondition: the copy holds a local edit"
    );

    let taken = state.speleodb_take_remote();

    let link = state
        .speleodb_open_link()
        .expect("the reloaded copy is linked");
    let project = state.get_project_state().expect("a project is open");
    let sections: Vec<Option<String>> = project.sections.iter().map(|s| s.name.clone()).collect();
    let requests = seen.lock().expect("request log").clone();
    let released = requests
        .iter()
        .any(|r| r.starts_with("POST") && r.contains(&format!("/projects/{REMOTE_ID}/release/")));
    println!(
        "take remote -> {taken:?}; BASE {:?}, dirty {}, last edit {:?}; editable {}; project \
         {:?} sections {sections:?}; undo offered {}; release issued {released}; requests \
         {requests:?}",
        link.base_commit_sha,
        link.has_unpushed_edits,
        link.last_edit_at,
        state.edit_enabled(),
        project.name,
        state.can_undo(),
    );
    assert_eq!(
        taken.as_deref().ok(),
        dest.to_str(),
        "answers the reloaded cache path"
    );
    assert_eq!(link.base_commit_sha.as_deref(), Some(TIP_SHA), "BASE = tip");
    assert!(!link.has_unpushed_edits, "the dirty bit is cleared");
    assert!(link.last_edit_at.is_none());
    assert!(!state.edit_enabled(), "the project is read-only");
    assert!(released, "the held lock was released: {requests:?}");
    assert!(
        requests
            .iter()
            .any(|r| r.contains(&format!("/download/dump/{TIP_SHA}/"))),
        "the dump was fetched at the tip: {requests:?}"
    );
    assert_eq!(
        sections,
        [Some("ServerSection".to_owned())],
        "the local edit is gone; the server's tree is open"
    );
    assert_eq!(project.name, "Server Copy");
    assert!(!state.can_undo(), "no history over the server tip");
}
