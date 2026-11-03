//! [#576 RV4-R-S7, decision RV4-R-S7-D1] A SpeleoDB download a NEWER Stalagmight
//! saved is refused before it replaces anything.
//!
//! A pull, the Start editing fast-forward and a revision View / Restore used to
//! install such a file over the cache copy and then leave it unlinked (this build
//! never stamps a newer file). Start editing then failed with the Retry-class
//! "session moved" error, and a View or Restore dropped the open copy's SpeleoDB
//! identity mid-session: BASE, the un-pushed mark and the Unwind position gone,
//! with no way back to the tip. Now each fails with the newer-version refusal
//! (`NEWER_FILE_READ_ONLY`) and the linked copy - its file, BASE, un-pushed mark
//! and Unwind position - stays exactly as it was.
//!
//! Driven end to end against a loopback stub that answers like SpeleoDB: the
//! revision history (a tip on top of our BASE), the lock, and every dump with a
//! ZIP built in this test around a project this build saves and then stamps one
//! schema version above itself - which is what a newer build's file looks like
//! to this one.
//!
//! The verbs resolve the cache path through the process-wide app dirs, a
//! `OnceLock` other tests in this binary rely on staying unset, so the body runs
//! in a process of its own (as `take_remote_success_tests` does): each test below
//! re-runs this test binary on the ignored, env-gated body with its scenario.
//!
//! All data is synthetic, built in code.

use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tempfile::TempDir;

use super::speleodb::{authed_session_at, REMOTE_ID};
use super::AppState;
use crate::models::{CommandErrorCode, Project, SectionData, ShotData, SpeleoLink, UndoMode};
use crate::persistence::Database;

/// The environment variable that carries the child's scenario.
const CHILD_ENV: &str = "STALAGMIGHT_NEWER_DOWNLOAD_CHILD";
/// The body's full test name, for the child's exact filter.
const CHILD_TEST: &str =
    "core::state::newer_download_refusal_tests::newer_download_body_in_a_process_of_its_own";

/// Our BASE, the tip on top of it, and an older revision to view / restore.
const BASE_SHA: &str = "abc1230000000000000000000000000000000000";
const TIP_SHA: &str = "def4560000000000000000000000000000000000";
const OLD_SHA: &str = "0123450000000000000000000000000000000000";
/// Where the copy's Unwind chain stands before the call.
const UNWOUND_FROM: &str = "fedcba0000000000000000000000000000000000";

/// Every JSON request: the project (our own account holds its lock) and its
/// revision history.
fn project_json() -> String {
    format!(
        r#"{{"id":"{REMOTE_ID}","name":"Remote","active_mutex":{{"user":"u@x"}},
            "commits":[{{"id":"{TIP_SHA}","parent_ids":["{BASE_SHA}"],"author_email":"other@x"}},
                       {{"id":"{BASE_SHA}","parent_ids":["{OLD_SHA}"],"author_email":"u@x"}},
                       {{"id":"{OLD_SHA}","parent_ids":[],"author_email":"u@x"}}]}}"#
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

/// The server's tree as a newer build saved it: one `.stalx` entry, stamped one
/// schema version above this build's, zipped as SpeleoDB zips it.
fn newer_dump() -> Vec<u8> {
    let temp = TempDir::new().expect("temp");
    let server = temp.path().join("server.stalx");
    project_file(&server, "Server Copy", "ServerSection");
    let conn = rusqlite::Connection::open(&server).expect("open the server copy directly");
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("read the stamp");
    conn.execute_batch(&format!(
        "UPDATE project SET schema_version = {newer}; PRAGMA user_version = {newer};",
        newer = current + 1
    ))
    .expect("stamp it newer");
    drop(conn);
    let bytes = std::fs::read(&server).expect("read the server project");
    let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer
        .start_file("misc/project.stalx", opts)
        .expect("start entry");
    writer.write_all(&bytes).expect("write entry");
    writer.finish().expect("finish zip").into_inner()
}

/// A loopback stub routing by path - every dump gets `zip`, everything else
/// [`project_json`] - and recording every request line. Keep the listener bound
/// for the whole test.
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
            let (content_type, body): (&str, &[u8]) = if line.contains("/download/") {
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

/// Re-run this test binary on the child body with `scenario`.
fn run_child(scenario: &str) {
    let exe = std::env::current_exe().expect("this test binary");
    let output = std::process::Command::new(exe)
        .args([
            CHILD_TEST,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, scenario)
        .output()
        .expect("run the body in a process of its own");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    println!("{stdout}");
    assert!(
        output.status.success(),
        "the {scenario} body failed:\n{stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("1 passed"),
        "the body ran (and was not filtered out): {stdout}"
    );
}

#[test]
fn a_pull_of_a_newer_file_is_refused_and_the_linked_copy_is_untouched() {
    run_child("pull");
}

#[test]
fn a_start_editing_fast_forward_to_a_newer_file_is_refused_and_the_copy_is_untouched() {
    run_child("start_editing");
}

#[test]
fn viewing_a_newer_revision_is_refused_and_the_copy_keeps_its_identity() {
    run_child("view");
}

#[test]
fn restoring_a_newer_revision_is_refused_and_the_copy_keeps_its_identity() {
    run_child("restore");
}

/// The cache copy as it stands on disk at `path`.
#[derive(Debug, PartialEq, Eq)]
struct CopyOnDisk {
    project: String,
    /// The link's BASE and un-pushed mark; `None` when the file is not linked.
    link: Option<(Option<String>, bool)>,
    unwound_from: Option<String>,
}

fn copy_on_disk(path: &Path) -> CopyOnDisk {
    let db = Database::open_for_metadata(path).expect("read the cache copy");
    CopyOnDisk {
        project: db.load_metadata(path.to_path_buf()).expect("metadata").name,
        link: db
            .load_speleo_link()
            .expect("link row")
            .map(|link| (link.base_commit_sha, link.has_unpushed_edits)),
        unwound_from: db.load_speleo_undo_chain().expect("chain row"),
    }
}

#[test]
#[ignore = "the child-process body of the newer-download refusal tests: it sets the \
            process-wide app dirs, so it runs only in a process of its own"]
fn newer_download_body_in_a_process_of_its_own() {
    let Some(scenario) = std::env::var_os(CHILD_ENV) else {
        println!("not in the child process ({CHILD_ENV} unset): nothing to do");
        return;
    };
    let scenario = scenario.to_string_lossy().into_owned();
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

    // The canonical cache copy, linked at BASE, clean, with an Unwind position.
    let (base, _listener, seen) = routing_stub(newer_dump());
    project_file(&dest, "Local Copy", "LocalSection");
    let db = Database::open_existing(&dest).expect("reopen");
    db.save_speleo_link(Some(&SpeleoLink {
        endpoint: base.clone(),
        project_id: REMOTE_ID.to_owned(),
        project_name: "Remote".to_owned(),
        base_commit_sha: Some(BASE_SHA.to_owned()),
        has_unpushed_edits: false,
        last_edit_at: None,
        last_verify_at: Some(chrono::Utc::now().to_rfc3339()),
        undo_mode: Some(UndoMode::Full),
    }))
    .expect("link");
    db.save_speleo_undo_chain(Some(UNWOUND_FROM))
        .expect("unwind position");
    drop(db);
    let before = copy_on_disk(&dest);

    let state = AppState::new().expect("state");
    state.set_event_sink(Arc::new(NoListener));
    *state.speleodb.lock() = authed_session_at(&base);

    let answer = match scenario.as_str() {
        "pull" => state
            .speleodb_open_project(
                REMOTE_ID.to_owned(),
                "Remote".to_owned(),
                Some(TIP_SHA.to_owned()),
                None,
            )
            .map(|_| ()),
        "start_editing" => {
            assert!(state.open_project(dest.clone()).success, "open the copy");
            state.speleodb_start_editing().map(|_| ())
        }
        "view" | "restore" => {
            assert!(state.open_project(dest.clone()).success, "open the copy");
            let restore = scenario == "restore";
            if restore {
                state.set_edit_enabled(true);
                state.speleodb_note_lock_acquired(Some(REMOTE_ID));
            }
            state
                .speleodb_restore_revision(
                    REMOTE_ID.to_owned(),
                    "Remote".to_owned(),
                    OLD_SHA.to_owned(),
                    restore,
                    false,
                    None,
                    false,
                    false,
                    false,
                )
                .map(|_| ())
        }
        other => panic!("unknown scenario {other}"),
    };

    let after = copy_on_disk(&dest);
    let open_name = state.get_project_state().map(|p| p.name);
    let open_link = state.speleodb_open_link().ok().map(|l| l.base_commit_sha);
    let downloads = seen
        .lock()
        .expect("request log")
        .iter()
        .filter(|r| r.contains("/download/"))
        .count();
    println!(
        "[RV4-R-S7] {scenario} of a newer-format file -> {:?}; downloads {downloads}; \
         cache copy (name, BASE, un-pushed, Unwind position) before {before:?}, after \
         {after:?}; open project {open_name:?}, open link BASE {open_link:?}",
        answer.as_ref().map_err(|e| (e.code, e.message.clone()))
    );

    assert_eq!(downloads, 1, "the newer file was downloaded once");
    let err = answer.expect_err("a newer-format download is refused");
    assert_eq!(
        err.code,
        CommandErrorCode::NewerFileReadOnly,
        "the newer-version refusal, by its code: {}",
        err.message
    );
    assert_eq!(
        after, before,
        "the linked copy, its BASE, un-pushed mark and Unwind position are untouched"
    );
    if scenario != "pull" {
        assert_eq!(
            open_name.as_deref(),
            Some("Local Copy"),
            "the open project is still the linked copy"
        );
        assert_eq!(
            open_link,
            Some(Some(BASE_SHA.to_owned())),
            "and it is still linked, at its BASE"
        );
        assert!(
            scenario == "restore" || !state.edit_enabled(),
            "no edit session was opened over it"
        );
    }
}
