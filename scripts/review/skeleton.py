#!/usr/bin/env python3
"""Signature skeleton generator — collapse a source file to its declarations.

Regex-extracts top-level (and nested) declarations with line numbers from Rust,
TypeScript/JavaScript, and Python files. One ~500-line file becomes ~30 lines of
`Lnnn: signature`, which is what a review-pack or a fresh-session brief wants
instead of the whole file. Stdlib only; no parser, no build step.

v1 signature skeleton: good enough to feed the review pack. A tree-sitter v2 with the
same output shape can replace it later without changing any consumer.

Usage:
    skeleton.py [PATH ...] [--include-private] [--json] [--max-sig N]
    git diff --name-only master...HEAD | skeleton.py         # paths on stdin

    PATH               files or directories (dirs recurse known extensions);
                       if none given, read newline-separated paths from stdin
    --include-private  also show non-exported/private decls (default: public +
                       structural only)
    --json             emit machine-readable JSON instead of the markdown map
    --max-sig N        truncate each signature to N chars (default 120)

Why: agentic grep is great for one-off "how does X work?", but a fan-out review
runs the same cold discovery N times. A cheap, deterministic skeleton lets every
finder read structure once instead of re-deriving it, which makes the
Layer-1 review pack (see review_pack.py) affordable.

Importable:  extract(path) -> FileSkeleton ;  render_md(fs) -> str ;
             exported_names(fs) -> list[str]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

EXT_LANG: dict[str, str] = {
    ".rs": "rust",
    ".ts": "ts",
    ".tsx": "ts",
    ".js": "js",
    ".jsx": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".py": "python",
    ".pyi": "python",
}

# Directories never worth skeletonizing (generated / vendored / deps).
SKIP_DIRS = {
    "node_modules", "target", "dist", "build", ".git", "vendor",
    "__pycache__", ".venv", "venv", ".next", "coverage", "generated",
}

# Line-based matchers: catch nested items (methods inside impls, indented) too.
_RUST = re.compile(
    r"^(?P<vis>pub(?:\([^)]*\))?\s+)?"
    r"(?P<quals>(?:(?:async|unsafe|const|default|extern(?:\s+\"[^\"]*\")?)\s+)*)"
    r"(?P<kw>fn|struct|enum|trait|impl|mod|type|union|static|const|macro_rules!)\b"
    r"\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)?"
)
_TS = re.compile(
    r"^(?P<vis>export\s+(?:default\s+)?)?"
    r"(?P<quals>(?:(?:declare|abstract|async)\s+)*)"
    r"(?P<kw>function\*?|class|interface|type|enum|const|let|var|namespace)\b"
    r"\s*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)?"
)
_PY = re.compile(
    r"^(?P<quals>(?:async\s+)?)"
    r"(?P<kw>def|class)\b"
    r"\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)?"
)

_WS = re.compile(r"\s+")


@dataclass
class Decl:
    line: int
    indent: int
    kind: str
    name: str
    text: str
    public: bool


@dataclass
class FileSkeleton:
    path: str
    lang: str
    n_lines: int
    decls: list[Decl] = field(default_factory=list)
    error: str | None = None


def detect_lang(path: Path) -> str | None:
    return EXT_LANG.get(path.suffix.lower())


def _sig(raw: str, max_sig: int) -> str:
    """Trim a declaration line to a compact signature."""
    s = raw.strip()
    for cut in (" {", "{", " =>", " where ", " = ", ";"):
        idx = s.find(cut)
        if idx > 0:
            s = s[:idx]
            break
    s = _WS.sub(" ", s).strip().rstrip("=").strip()
    if len(s) > max_sig:
        s = s[: max_sig - 1].rstrip() + "…"
    return s


def _decl_from_match(lang: str, line: str, lineno: int, m: re.Match[str], max_sig: int) -> Decl | None:
    """Build a Decl, deciding structural-keep and public visibility per language."""
    kw = m.group("kw")
    name = m.group("name") or ""
    if lang in ("ts", "js"):
        public = bool(m.group("vis"))
        if kw in ("const", "let", "var") and not public:
            return None  # bare in-scope local: noise unless exported
    elif lang == "rust":
        public = bool(m.group("vis"))
        if kw in ("const", "static") and not (name[:1].isupper() or public):
            return None  # skip in-fn `const x`; keep SCREAMING_CASE / pub items
    else:  # python
        public = not name.startswith("_")
    return Decl(
        line=lineno,
        indent=len(line) - len(line.lstrip()),
        kind=kw,
        name=name,
        text=_sig(line, max_sig),
        public=public,
    )


def extract(path: Path, text: str | None = None, *, max_sig: int = 120) -> FileSkeleton:
    """Parse a file into its declaration skeleton. `text` overrides reading from disk."""
    lang = detect_lang(path)
    if lang is None:
        return FileSkeleton(str(path), "unknown", 0, error="unsupported extension")
    try:
        src = text if text is not None else path.read_text("utf-8", errors="replace")
    except OSError as e:
        return FileSkeleton(str(path), lang, 0, error=str(e))

    matcher = {"rust": _RUST, "ts": _TS, "js": _TS, "python": _PY}[lang]
    decls: list[Decl] = []
    lines = src.splitlines()
    for i, line in enumerate(lines, 1):
        m = matcher.match(line.lstrip())
        if not m:
            continue
        d = _decl_from_match(lang, line, i, m, max_sig)
        if d is not None:
            decls.append(d)
    return FileSkeleton(str(path), lang, len(lines), decls)


STRUCTURAL_KINDS = {"impl", "mod", "trait"}  # context containers are never `pub`


def render_md(fs: FileSkeleton, *, include_private: bool = False) -> str:
    if fs.error:
        return f"## {fs.path}\n_(skipped: {fs.error})_\n"
    decls = fs.decls if include_private else [
        d for d in fs.decls if d.public or d.kind in STRUCTURAL_KINDS
    ]
    head = f"## {fs.path}  ({fs.lang}, {len(decls)} decls / {fs.n_lines} lines)"
    if not decls:
        return head + "\n_(no matching declarations)_\n"
    body = "\n".join(f"  L{d.line}: {'  ' * (d.indent // 4)}{d.text}" for d in decls)
    return f"{head}\n{body}\n"


def exported_names(fs: FileSkeleton) -> list[str]:
    """Public symbol names for a consumer map (order-preserving dedup)."""
    seen: set[str] = set()
    out: list[str] = []
    for d in fs.decls:
        if d.public and d.name and d.name not in seen:
            seen.add(d.name)
            out.append(d.name)
    return out


def iter_paths(inputs: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            out.extend(
                child
                for child in sorted(p.rglob("*"))
                if child.is_file() and detect_lang(child) and not (set(child.parts) & SKIP_DIRS)
            )
        elif detect_lang(p):  # allow not-yet-existing paths (e.g. from a diff list)
            out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Signature skeleton generator (Rust/TS/JS/Python).")
    ap.add_argument("paths", nargs="*", help="files or dirs; stdin if omitted")
    ap.add_argument("--include-private", action="store_true", help="also show non-exported/private decls")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--max-sig", type=int, default=120, help="signature truncation width")
    args = ap.parse_args()

    raw = args.paths
    if not raw:
        if sys.stdin.isatty():
            ap.error("no paths given and stdin is a tty")
        raw = [ln.strip() for ln in sys.stdin if ln.strip()]

    paths = iter_paths(raw)
    if not paths:
        print("no supported source files found", file=sys.stderr)
        return 1

    skeletons = [extract(p, max_sig=args.max_sig) for p in paths]
    if args.json:
        print(json.dumps([asdict(s) for s in skeletons], indent=2))
    else:
        for fs in skeletons:
            print(render_md(fs, include_private=args.include_private))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
