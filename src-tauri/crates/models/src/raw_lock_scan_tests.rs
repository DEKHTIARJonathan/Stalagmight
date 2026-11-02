//! [#576 RV5-PI-5] No raw `std::sync::Mutex` / `RwLock` in backend production code.
//!
//! #576 A11 made every lock in the backend crates a `RecoveringMutex`
//! (`poison_policy.rs`): it has no method that hands back the std `LockResult`, so
//! the silent-skip idiom A11 removed - `if let Ok(g) = m.lock() { .. }`, which
//! quietly does nothing after a crash poisoned the lock - does not compile on it,
//! and every recovery raises the internal-error banner. That held only for the
//! cells that exist: a NEW std `Mutex` with the old idiom compiles, passes clippy
//! (`unwrap_used` does not fire on `if let Ok`) and passes
//! `every_lock_the_state_holds_is_a_recovering_cell` unless it is an `AppState`
//! field. The repo bans `clippy.toml`, so `disallowed_types` is not available
//! (docs/linting.md); this source scan is the guard instead, and runs with the
//! workspace tests like every other tripwire.
//!
//! Scanned: `src-tauri/src` and every `src-tauri/crates/*/src`. Not scanned: test
//! code - `*tests.rs` files, anything declared or defined under a
//! `#[cfg(test)]` / `#[cfg(any(test, ..))]` / `#[cfg(all(test, ..))]` attribute
//! (an inline module, a `mod x;` and the files under it, a single item) - and
//! `poison_policy.rs`, which wraps the std type by design. Comments and string
//! literals are blanked before matching, so prose that names the type is not a hit.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Files allowed to name the std lock types in production code, with why.
const ALLOWED: &[(&str, &str)] = &[(
    "crates/models/src/poison_policy.rs",
    "RecoveringMutex itself: the one wrapper around the std Mutex",
)];

/// `src-tauri`.
fn backend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `src` with every comment and string/char literal replaced by spaces (newlines
/// kept), so offsets stay those of the source and only code is matched.
fn code_only(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for c in &mut out[from..to.min(b.len())] {
            if *c != b'\n' {
                *c = b' ';
            }
        }
    };
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < b.len() {
        let rest = &b[i..];
        if rest.starts_with(b"//") {
            let end = rest
                .iter()
                .position(|&c| c == b'\n')
                .map_or(b.len(), |n| i + n);
            blank(&mut out, i, end);
            i = end;
        } else if rest.starts_with(b"/*") {
            let (mut depth, mut j) = (1, i + 2);
            while j < b.len() && depth > 0 {
                if b[j..].starts_with(b"/*") {
                    depth += 1;
                    j += 2;
                } else if b[j..].starts_with(b"*/") {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j);
            i = j;
        } else if (rest.starts_with(b"r\"") || rest.starts_with(b"r#") || rest.starts_with(b"br"))
            && (i == 0 || !ident(b[i - 1]))
            && {
                let after = if rest[0] == b'b' { &rest[1..] } else { rest };
                after.len() > 1
                    && after[0] == b'r'
                    && after[1..].iter().find(|&&c| c != b'#') == Some(&b'"')
            }
        {
            let start = i;
            let mut j = i + if rest[0] == b'b' { 2 } else { 1 };
            let hashes = b[j..].iter().take_while(|&&c| c == b'#').count();
            j += hashes + 1;
            let close: Vec<u8> = std::iter::once(b'"')
                .chain(std::iter::repeat_n(b'#', hashes))
                .collect();
            while j < b.len() && !b[j..].starts_with(&close) {
                j += 1;
            }
            j = (j + close.len()).min(b.len());
            blank(&mut out, start, j);
            i = j;
        } else if rest[0] == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            blank(&mut out, i, j + 1);
            i = j + 1;
        } else if rest[0] == b'\'' {
            // A char literal ('x', '\n', '\''), not a lifetime ('a).
            let len = if rest.get(1) == Some(&b'\\') {
                rest[2..].iter().position(|&c| c == b'\'').map(|n| n + 3)
            } else if rest.get(2) == Some(&b'\'') {
                Some(3)
            } else {
                None
            };
            if let Some(len) = len {
                blank(&mut out, i, i + len);
                i += len;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

/// The index just past the bracket that closes the one at `open` (any of `([{`).
fn matching_close(code: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    for (j, &c) in code.iter().enumerate().skip(open) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return j + 1;
                }
            }
            _ => {}
        }
    }
    code.len()
}

/// A `#[cfg(..)]` that turns the item off outside tests.
fn is_test_cfg(attr: &str) -> bool {
    let attr: String = attr.chars().filter(|c| !c.is_whitespace()).collect();
    !attr.contains("not(")
        && (attr == "#[cfg(test)]"
            || attr.starts_with("#[cfg(any(test,")
            || attr.starts_with("#[cfg(all(test,"))
}

/// Byte ranges of the test-gated items in `code`, and the names of the `mod x;`
/// declarations among them.
fn test_gated(code: &[u8]) -> (Vec<(usize, usize)>, Vec<String>) {
    let text = String::from_utf8_lossy(code);
    let mut ranges = Vec::new();
    let mut child_mods = Vec::new();
    for (at, _) in text.match_indices("#[cfg(") {
        let attr_end = matching_close(code, at + 1);
        if !is_test_cfg(&text[at..attr_end]) {
            continue;
        }
        // Skip the attributes that follow, then the item runs to its first `;` or
        // its brace-matched `{ .. }`, whichever opens first.
        let mut j = attr_end;
        loop {
            while j < code.len() && code[j].is_ascii_whitespace() {
                j += 1;
            }
            if code[j..].starts_with(b"#[") {
                j = matching_close(code, j + 1);
            } else {
                break;
            }
        }
        let item_start = j;
        let mut parens = 0i32;
        let mut end = code.len();
        while j < code.len() {
            match code[j] {
                b'(' | b'[' => parens += 1,
                b')' | b']' => parens -= 1,
                b';' if parens == 0 => {
                    end = j + 1;
                    break;
                }
                b'{' if parens == 0 => {
                    end = matching_close(code, j);
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        let item = text[item_start..end].trim();
        let words: Vec<&str> = item.split_whitespace().collect();
        if let Some(pos) = words.iter().position(|w| *w == "mod") {
            if let Some(name) = words.get(pos + 1).and_then(|n| n.strip_suffix(';')) {
                child_mods.push(name.to_string());
            }
        }
        ranges.push((at, end));
    }
    (ranges, child_mods)
}

/// The files a `mod name;` in `file` resolves to.
fn child_paths(file: &Path, name: &str) -> [PathBuf; 2] {
    let dir = file.parent().unwrap();
    let stem = file.file_stem().unwrap().to_string_lossy();
    let base = if matches!(stem.as_ref(), "mod" | "lib" | "main") {
        dir.to_path_buf()
    } else {
        dir.join(stem.as_ref())
    };
    [
        base.join(format!("{name}.rs")),
        base.join(name).join("mod.rs"),
    ]
}

/// Raw std lock types named in the code of `code` outside `skip`.
fn raw_locks(code: &[u8], skip: &[(usize, usize)]) -> Vec<(usize, String)> {
    let text = String::from_utf8_lossy(code);
    let line_of = |at: usize| text[..at].matches('\n').count() + 1;
    let skipped = |at: usize| skip.iter().any(|&(a, b)| (a..b).contains(&at));
    let word_after = |at: usize| {
        text[at..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
    };
    let mut hits = Vec::new();
    for (at, _) in text.match_indices("std::sync::") {
        if skipped(at) {
            continue;
        }
        let after = at + "std::sync::".len();
        let named: Vec<String> = if text[after..].starts_with('{') {
            let close = matching_close(code, after);
            text[after + 1..close - 1]
                .split(',')
                .map(|s| s.split_whitespace().next().unwrap_or("").to_string())
                .collect()
        } else {
            vec![word_after(after)]
        };
        for ty in named {
            if ty == "Mutex" || ty == "RwLock" {
                hits.push((line_of(at), format!("std::sync::{ty}")));
            }
        }
    }
    hits
}

/// Every raw std lock in the backend's production code, as `path:line type`, and
/// how many files were read.
fn scan() -> (usize, Vec<String>) {
    let root = backend_root();
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    let Ok(crates) = std::fs::read_dir(root.join("crates")) else {
        return (0, vec!["cannot read src-tauri/crates".to_string()]);
    };
    for krate in crates.flatten() {
        rust_files(&krate.path().join("src"), &mut files);
    }
    files.sort();

    let mut test_only: BTreeSet<PathBuf> = BTreeSet::new();
    let mut parsed = Vec::new();
    for file in &files {
        let src = std::fs::read_to_string(file).unwrap();
        let code = code_only(&src);
        let (ranges, mods) = test_gated(&code);
        for name in mods {
            test_only.extend(child_paths(file, &name));
        }
        parsed.push((file.clone(), code, ranges));
    }
    let mut hits = Vec::new();
    for (file, code, ranges) in parsed {
        let rel = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let name = file.file_name().unwrap().to_string_lossy();
        // The gated module's own file, or a file of a module nested under it.
        let under_test_only = test_only.iter().any(|t| {
            let module_dir = if t.file_name().is_some_and(|n| n == "mod.rs") {
                t.parent().unwrap().to_path_buf()
            } else {
                t.with_extension("")
            };
            file == *t || file.starts_with(&module_dir)
        });
        if name.ends_with("tests.rs")
            || under_test_only
            || ALLOWED.iter().any(|(path, _)| rel == *path)
        {
            continue;
        }
        for (line, ty) in raw_locks(&code, &ranges) {
            hits.push(format!("{rel}:{line} {ty}"));
        }
    }
    (files.len(), hits)
}

#[test]
fn backend_production_code_names_no_raw_std_lock() {
    let (files, hits) = scan();
    println!(
        "scanned {files} backend source files; raw std::sync::Mutex / RwLock in \
         production code: {} {hits:?}",
        hits.len()
    );
    assert!(files > 100, "the scan read the backend sources");
    assert!(
        hits.is_empty(),
        "use models::poison_policy::RecoveringMutex instead (#576 A11): a std lock lets \
         `if let Ok(g) = m.lock()` skip silently after a crash. Found: {hits:?}"
    );
}

#[test]
fn the_scanner_sees_through_comments_strings_and_test_gates() {
    // Synthetic sources, not files: what the scan must and must not report.
    let flagged = "use std::sync::{Arc, Mutex};\nstatic A: std::sync::RwLock<u8> = \
                   std::sync::RwLock::new(0);\n";
    let ignored = "// std::sync::Mutex in a comment\nconst S: &str = \"std::sync::Mutex\";\n\
                   use std::sync::MutexGuard;\n#[cfg(test)]\nmod tests {\n    use \
                   std::sync::Mutex;\n    fn f() { let _ = \"}\"; }\n}\n#[cfg(any(test, \
                   feature = \"x\"))]\nuse std::sync::Mutex;\n#[cfg(not(test))]\nfn g() {}\n";
    let scan_one = |src: &str| {
        let code = code_only(src);
        let (ranges, _) = test_gated(&code);
        raw_locks(&code, &ranges)
    };
    let (f, i) = (scan_one(flagged), scan_one(ignored));
    println!("planted production locks found: {f:?}; in comments/strings/tests: {i:?}");
    assert_eq!(f.len(), 3, "{f:?}");
    assert!(i.is_empty(), "{i:?}");
}
