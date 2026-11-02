//! [#576 RV5-RL-1] Every ts-rs export test writes into `src-tauri/bindings/`,
//! and the app crate hosts none.
//!
//! A `#[ts(export)]` derive makes ts-rs emit an `export_bindings_*` test that
//! writes the type's `.ts` file to its `export_to`, resolved against the
//! DECLARING crate's manifest directory. Two app-crate exports said
//! `export_to = "../../src/types/ipc/"`, which from `src-tauri/` is the parent of
//! the checkout: every `cargo test` wrote `MemoryStats.ts` and
//! `ProcessMemory.ts` outside the repository (into `.claude/worktrees/src/` for a
//! worktree), and under the CI's unprivileged test user that write failed the
//! job. The rule (docs/ipc-typegen.md) is that every exporting type lives in a
//! member crate with `export_to = "../../bindings/"`, and `pnpm gen:ipc-types`
//! alone writes `src/types/ipc/`.
//!
//! A source scan, so it also covers a crate whose tests did not run: it reads
//! every `#[ts(...)]` attribute under `src-tauri/src` and
//! `src-tauri/crates/*/src`, keeps the ones that generate an export test (a bare
//! `export` among the arguments) and resolves their target the way ts-rs does.

use std::path::{Component, Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).expect("a source directory is readable");
    for entry in entries {
        let path = entry.expect("a directory entry is readable").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// `path` with `.` and `..` folded away, without touching the filesystem (the
/// target directory may not exist).
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Every `#[ts(...)]` attribute in `source` that generates an export test:
/// `(line, export_to)`, `None` when it takes ts-rs's default (`bindings/`).
fn exporting_attributes(source: &str) -> Vec<(usize, Option<String>)> {
    let mut found = Vec::new();
    let mut rest = source;
    let mut offset = 0;
    while let Some(at) = rest.find("#[ts(") {
        let start = at + "#[ts(".len();
        let mut depth = 1usize;
        let mut end = start;
        for (i, c) in rest[start..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let args = &rest[start..end];
        // An attribute starts its line; a mention in a comment or a string does not.
        let before = &source[..offset + at];
        let line_start = before.rfind('\n').map_or(0, |i| i + 1);
        let is_attribute = before[line_start..].trim().is_empty();
        let exports = args.split(',').any(|arg| arg.trim() == "export");
        if is_attribute && exports {
            let export_to = args
                .split(',')
                .map(str::trim)
                .find(|arg| arg.starts_with("export_to"))
                .and_then(|arg| arg.split('"').nth(1))
                .map(str::to_owned);
            let line = before.matches('\n').count() + 1;
            found.push((line, export_to));
        }
        offset += end;
        rest = &source[offset..];
    }
    found
}

#[test]
fn every_ts_export_test_writes_into_the_bindings_tree() {
    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bindings = lexical(&app_root.join("bindings"));
    let mut crate_roots = vec![app_root.clone()];
    let members = std::fs::read_dir(app_root.join("crates")).expect("src-tauri/crates is readable");
    for member in members {
        let member = member.expect("a member entry is readable").path();
        if member.join("Cargo.toml").is_file() {
            crate_roots.push(member);
        }
    }
    crate_roots.sort();

    let mut exports = 0;
    let mut violations = Vec::new();
    for root in &crate_roots {
        let mut files = Vec::new();
        rust_files(&root.join("src"), &mut files);
        files.sort();
        for file in files {
            // This module's own fixtures are not exports.
            if file.ends_with("src/ts_export_paths_tests.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&file).expect("a source file is readable");
            for (line, export_to) in exporting_attributes(&source) {
                exports += 1;
                let target = export_to.as_deref().unwrap_or("bindings/");
                let resolved = lexical(&root.join(target));
                let dir = if target.ends_with(".ts") {
                    resolved.parent().map(Path::to_path_buf).unwrap_or_default()
                } else {
                    resolved
                };
                let at = format!(
                    "{}:{line}",
                    file.strip_prefix(&app_root).unwrap_or(&file).display()
                );
                if dir != bindings {
                    violations.push(format!(
                        "{at}: export_to {target:?} writes into {} (outside src-tauri/bindings)",
                        dir.display()
                    ));
                }
                if root == &app_root {
                    violations.push(format!(
                        "{at}: the app crate hosts an export test; move the type to a member \
                         crate (docs/ipc-typegen.md)"
                    ));
                }
            }
        }
    }
    println!(
        "ts-rs export tests found: {exports} across {} crates; violations: {}",
        crate_roots.len(),
        violations.len()
    );
    for violation in &violations {
        println!("  {violation}");
    }
    assert!(
        exports >= 50,
        "only {exports} exporting attributes found - did the scan stop reading?"
    );
    assert!(violations.is_empty(), "{violations:#?}");
}

#[test]
fn the_attribute_scan_reads_export_and_export_to() {
    let source = "#[derive(TS)]\n#[ts(export, export_to = \"../../bindings/\")]\nstruct A;\n\
                  #[ts(export_to = \"bindings/B.ts\")]\nstruct B;\n    #[ts(rename = \"C\", export)]\n\
                  struct C;\n/// see `#[ts(export)]`\nstruct D;\n";
    assert_eq!(
        exporting_attributes(source),
        vec![(2, Some("../../bindings/".to_owned())), (6, None)]
    );
    assert_eq!(
        lexical(Path::new("/a/src-tauri/../../src/types/ipc/")),
        PathBuf::from("/src/types/ipc")
    );
}
