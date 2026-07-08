#!/usr/bin/env python3
"""Layer-0 pre-flight — deterministic landmine checks over a diff, zero model $.

Scans the added lines of `git diff <base>...HEAD` (falling back to staged, then
unstaged) for known "landmine" patterns and emits a FLAGS section. Deterministic
checks never tire of the same rule, so they belong before any model wakes — this
is the Layer-0 engine behind /pre-pr (.claude/commands/pre-pr.md). It is also
the FLAGS source that review_pack.py prepends to the shared review pack.

Rules come from an optional repo config (default `.claude/review.toml`); a small
set of genuinely-generic built-ins (focused tests, `debugger;`, leaked private
keys, new Rust `unsafe`) runs even with no config so the tool is useful in a
repo that hasn't written rules yet.

A rule may request the `ast-grep` engine (syntactic match, not text). When the
`sg`/`ast-grep` binary is absent — as it often is — the rule transparently falls
back to its `pattern` regex and the run notes which engine was used. No hard dep.

Usage:
    preflight.py [--base REF] [--config PATH] [--repo DIR] [--json]
                 [--no-builtin] [--run-commands]

    --base REF       diff base (default: auto — origin/HEAD, else master/main)
    --config PATH    rules file (default: <repo>/.claude/review.toml)
    --repo DIR       repo root (default: cwd)
    --json           emit structured flags instead of the markdown FLAGS section
    --no-builtin     skip the generic built-in landmines (config rules only)
    --run-commands   also run any [[command]] entries (fmt/clippy/tests); off by
                     default because they can be slow

Exit code: 2 if any `fail`-severity flag fired, else 0 (so it can gate a hook).

Why: most of a "project landmines" review lens is mechanically checkable. Moving
it to a script replaces a whole Opus finder with an exit code, and makes the
check more reliable than a model that re-reads the same rule every PR.

Importable:  collect(repo, base, config, ...) -> PreflightResult
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path

SEVERITIES = ("fail", "security-trigger", "flag")


@dataclass
class Landmine:
    name: str
    pattern: str
    message: str
    paths: list[str] = field(default_factory=list)  # globs; empty = any path
    on: str = "added"  # "added" (diff only) | "all" (whole changed file)
    severity: str = "flag"
    engine: str = "regex"  # "regex" | "ast-grep"
    ast_grep_pattern: str | None = None
    ast_grep_lang: str | None = None


@dataclass
class Command:
    label: str
    run: str
    severity: str = "flag"
    timeout: int = 300


@dataclass
class Flag:
    rule: str
    severity: str
    path: str
    line: int
    text: str
    message: str


@dataclass
class PreflightResult:
    flags: list[Flag]
    diff_mode: str
    notes: list[str]  # engine fallbacks, config load issues, command outcomes

    @property
    def security_triggered(self) -> bool:
        return any(f.severity == "security-trigger" for f in self.flags)

    @property
    def failed(self) -> bool:
        return any(f.severity == "fail" for f in self.flags)


# Generic, low-false-positive landmines that apply to almost any repo.
BUILTINS: list[Landmine] = [
    Landmine(
        name="focused-test",
        pattern=r"\b(?:describe|it|test|context)\.only\s*\(",
        message="Focused test left in (`.only`) — would silently skip the rest of the suite.",
        severity="fail",
    ),
    Landmine(
        name="debugger-statement",
        pattern=r"(?<![\w.])debugger\s*;",
        paths=["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        message="`debugger;` statement left in source.",
        severity="flag",
    ),
    Landmine(
        name="leaked-private-key",
        pattern=r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----",
        message="Private key material added to the tree.",
        severity="security-trigger",
    ),
    Landmine(
        name="aws-access-key",
        pattern=r"\bAKIA[0-9A-Z]{16}\b",
        message="Looks like an AWS access key id.",
        severity="security-trigger",
    ),
    Landmine(
        name="rust-unsafe-block",
        pattern=r"\bunsafe\s*\{",
        paths=["**/*.rs"],
        message="New `unsafe` block — security review should look.",
        severity="security-trigger",
        engine="ast-grep",
        ast_grep_pattern="unsafe { $$$ }",
        ast_grep_lang="rust",
    ),
]

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(?P<start>\d+)(?:,\d+)? @@")


# ---------------------------------------------------------------------------
# git plumbing
# ---------------------------------------------------------------------------
def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=False
    )


def _ref_exists(repo: Path, ref: str) -> bool:
    return _git(repo, "rev-parse", "--verify", "--quiet", ref).returncode == 0


def resolve_base(repo: Path, explicit: str | None) -> str | None:
    if explicit:
        return explicit
    head = _git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if head.returncode == 0 and head.stdout.strip():
        return head.stdout.strip()
    for cand in ("origin/master", "origin/main", "master", "main"):
        if _ref_exists(repo, cand):
            return cand
    return None


def compute_diff(repo: Path, base: str | None) -> tuple[str, str]:
    """Return (diff_text, mode). Prefer base...HEAD, then staged, then unstaged."""
    if base and _ref_exists(repo, base):
        txt = _git(repo, "diff", f"{base}...HEAD").stdout
        if txt.strip():
            return txt, f"{base}...HEAD"
    staged = _git(repo, "diff", "--cached").stdout
    if staged.strip():
        return staged, "staged"
    return _git(repo, "diff").stdout, "unstaged"


def iter_added(diff_text: str):
    """Yield (path, new_lineno, text) for every added (`+`) line in a unified diff."""
    path = ""
    lineno = 0
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            p = line[4:]
            path = "" if p == "/dev/null" else p[2:] if p[:2] in ("a/", "b/") else p
            continue
        if line.startswith("@@"):
            m = _HUNK.match(line)
            lineno = int(m.group("start")) if m else 0
            continue
        if line.startswith("+") and not line.startswith("+++"):
            if path:
                yield path, lineno, line[1:]
            lineno += 1
        elif not line.startswith("-"):
            lineno += 1  # context line advances the new-file counter


def changed_files(diff_text: str) -> list[str]:
    out: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("+++ ") and line[4:] != "/dev/null":
            p = line[4:]
            out.append(p[2:] if p[:2] in ("a/", "b/") else p)
    return out


# ---------------------------------------------------------------------------
# glob + config
# ---------------------------------------------------------------------------
def glob_to_re(pat: str) -> re.Pattern[str]:
    out: list[str] = []
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if pat[i : i + 2] == "**":
                out.append(".*")
                i += 2
                if i < n and pat[i] == "/":  # `**/` also matches zero dirs
                    out.append("/?")
                    i += 1
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "$")


def path_matches(path: str, globs: list[str]) -> bool:
    if not globs:
        return True
    return any(glob_to_re(g).match(path) for g in globs)


def load_config(path: Path) -> tuple[list[Landmine], list[Command], list[str]]:
    notes: list[str] = []
    if not path.is_file():
        return [], [], notes
    try:
        data = tomllib.loads(path.read_text("utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        return [], [], [f"config {path}: {e}"]

    mines: list[Landmine] = []
    for raw in data.get("landmine", []):
        try:
            mines.append(Landmine(**raw))
        except TypeError as e:
            notes.append(f"landmine {raw.get('name', '?')}: {e}")
    cmds: list[Command] = []
    for raw in data.get("command", []):
        try:
            cmds.append(Command(**raw))
        except TypeError as e:
            notes.append(f"command {raw.get('label', '?')}: {e}")
    return mines, cmds, notes


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------
_AST_GREP = shutil.which("ast-grep") or shutil.which("sg")


def _ast_grep_flags(
    repo: Path, mine: Landmine, files: list[str], added_index: dict[str, set[int]]
) -> list[Flag] | None:
    """Run ast-grep for a rule. Return flags, or None if the engine is unusable.

    For `on="added"` the syntactic matches are intersected with the diff's added
    lines, so switching engines changes match *precision*, never *which* lines
    fire (a pre-existing unsafe block in a touched file is not a new landmine).
    """
    if not _AST_GREP or not mine.ast_grep_pattern:
        return None
    targets = [f for f in files if path_matches(f, mine.paths) and (repo / f).is_file()]
    if not targets:
        return []
    cmd = [_AST_GREP, "run", "--pattern", mine.ast_grep_pattern, "--json"]
    if mine.ast_grep_lang:
        cmd += ["--lang", mine.ast_grep_lang]
    cmd += targets
    proc = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=False)
    if proc.returncode not in (0, 1) or not proc.stdout.strip():
        return None
    try:
        matches = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    flags: list[Flag] = []
    for m in matches:
        rel = _rel_path(m.get("file", "?"), repo)
        line = int(m.get("range", {}).get("start", {}).get("line", 0)) + 1  # ast-grep is 0-indexed
        if mine.on == "added" and line not in added_index.get(rel, set()):
            continue
        flags.append(
            Flag(
                rule=mine.name,
                severity=mine.severity,
                path=rel,
                line=line,
                text=(m.get("lines") or "").strip()[:160],
                message=mine.message,
            )
        )
    return flags


def _rel_path(path: str, repo: Path) -> str:
    """ast-grep echoes the path as given; normalize to repo-relative like regex flags."""
    p = Path(path)
    if not p.is_absolute():
        return path  # already relative (we run ast-grep with cwd=repo)
    try:
        return str(p.resolve().relative_to(repo.resolve()))
    except ValueError:
        return path


def _regex_flags(mine: Landmine, added, whole) -> list[Flag]:
    rx = re.compile(mine.pattern)
    flags: list[Flag] = []
    source = whole if mine.on == "all" else added
    for path, lineno, text in source:
        if path_matches(path, mine.paths) and rx.search(text):
            flags.append(Flag(mine.name, mine.severity, path, lineno, text.strip()[:160], mine.message))
    return flags


def _iter_whole(repo: Path, files: list[str]):
    for path in files:
        fp = repo / path
        if not fp.is_file():
            continue
        for i, line in enumerate(fp.read_text("utf-8", errors="replace").splitlines(), 1):
            yield path, i, line


def collect(
    repo: Path,
    base: str | None,
    config: Path,
    *,
    use_builtin: bool = True,
    run_commands: bool = False,
) -> PreflightResult:
    diff_text, mode = compute_diff(repo, base)
    added = list(iter_added(diff_text))
    files = changed_files(diff_text)

    added_index: dict[str, set[int]] = {}
    for path, lineno, _ in added:
        added_index.setdefault(path, set()).add(lineno)

    mines, cmds, notes = load_config(config)
    rules = ([*BUILTINS] if use_builtin else []) + mines
    whole = list(_iter_whole(repo, files)) if any(m.on == "all" for m in rules) else []

    flags: list[Flag] = []
    ast_unavailable_noted = False
    for mine in rules:
        if mine.engine == "ast-grep":
            got = _ast_grep_flags(repo, mine, files, added_index)
            if got is not None:
                flags.extend(got)
                continue
            if not ast_unavailable_noted:
                notes.append("ast-grep engine unavailable — those rules fell back to regex")
                ast_unavailable_noted = True
        flags.extend(_regex_flags(mine, added, whole))

    if run_commands:
        for cmd in cmds:
            notes.append(_run_command(repo, cmd, flags))

    order = {s: i for i, s in enumerate(SEVERITIES)}
    flags.sort(key=lambda f: (order.get(f.severity, 9), f.path, f.line))
    return PreflightResult(flags, mode, notes)


def _run_command(repo: Path, cmd: Command, flags: list[Flag]) -> str:
    try:
        proc = subprocess.run(
            shlex.split(cmd.run), cwd=repo, capture_output=True, text=True,
            timeout=cmd.timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        flags.append(Flag(cmd.label, cmd.severity, cmd.run, 0, str(e), "pre-flight command failed to run"))
        return f"command `{cmd.label}`: error ({e})"
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
        flags.append(Flag(cmd.label, cmd.severity, cmd.run, 0, tail[0][:160], f"`{cmd.run}` exited {proc.returncode}"))
        return f"command `{cmd.label}`: FAIL (exit {proc.returncode})"
    return f"command `{cmd.label}`: ok"


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
_ICON = {"fail": "⛔", "security-trigger": "🔐", "flag": "⚠️"}


def render_md(res: PreflightResult) -> str:
    lines = [f"## FLAGS — Layer-0 pre-flight (`{res.diff_mode}`)", ""]
    if res.security_triggered:
        lines.append("> **security trigger set** — run the security finder (Layer 2, lens L8).")
        lines.append("")
    if not res.flags:
        lines.append("_No landmines fired._")
    else:
        for f in res.flags:
            loc = f"`{f.path}:{f.line}`" if f.line else f"`{f.path}`"
            lines.append(f"- {_ICON.get(f.severity, '•')} **{f.rule}** {loc} — {f.message}")
            if f.text:
                lines.append(f"  `{f.text}`")
    if res.notes:
        lines += ["", "_notes: " + "; ".join(res.notes) + "_"]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Layer-0 deterministic pre-flight landmine scan.")
    ap.add_argument("--base", help="diff base ref (default: auto-detect)")
    ap.add_argument("--config", help="rules TOML (default: <repo>/.claude/review.toml)")
    ap.add_argument("--repo", default=".", help="repo root (default: cwd)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--no-builtin", action="store_true", help="config rules only")
    ap.add_argument("--run-commands", action="store_true", help="also run [[command]] checks")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists() and _git(repo, "rev-parse", "--git-dir").returncode != 0:
        print(f"not a git repo: {repo}", file=sys.stderr)
        return 1
    config = Path(args.config) if args.config else repo / ".claude" / "review.toml"
    base = resolve_base(repo, args.base)

    res = collect(repo, base, config, use_builtin=not args.no_builtin, run_commands=args.run_commands)
    if args.json:
        print(json.dumps({
            "diff_mode": res.diff_mode,
            "security_triggered": res.security_triggered,
            "failed": res.failed,
            "notes": res.notes,
            "flags": [asdict(f) for f in res.flags],
        }, indent=2))
    else:
        print(render_md(res), end="")
    return 2 if res.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
