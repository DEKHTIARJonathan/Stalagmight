#!/usr/bin/env python3
"""Review-run logger — validate and append one JSONL record to review-log.jsonl.

Replaces the old "hand-append a JSON line with `>>`" instruction in
.claude/commands/pre-pr.md §"Log the run": that mechanism was prose-only, had
no validation, and was cwd-dependent (a plain `>>` writes relative to wherever
the shell happened to be, not the repo root). This script fixes both: it
resolves the log path via `git rev-parse --show-toplevel` and rejects a
malformed record outright rather than letting bad data reach the log.

Input is one run record as JSON — a single positional argument, or on stdin
(`-` or no argument). On success, exactly one compact JSON line (keys sorted)
is appended to `<repo-root>/.claude/review-log.jsonl` (created if absent) and
a one-line confirmation is printed to stdout. On any failure the file is left
untouched and the reason is printed to stderr; the run is not logged until
this script exits 0. Exit codes distinguish the two failure classes (mirrors
preflight.py's convention of reserving a distinct code for "this tool can't
run here" vs. "the input is bad"):
    1 - the record itself was rejected (bad verdict, malformed JSON, etc.) —
        fix the record and re-run.
    2 - an environment/usage problem (not inside a git repo, no stdin, git
        itself failed) — the record may be fine; fix how the script was run.

Usage:
    log_run.py '<json>'
    echo '<json>' | log_run.py
    log_run.py -              # explicit stdin

Record shape:
    {"date": "YYYY-MM-DD",              # optional; defaults to today (UTC)
     "branch": "chore/x",               # optional; defaults to current branch
     "verdict": "block|nits|needs-work",
     "findings": [{"lens": 1-10, "severity": "red|yellow|green",
                   "file": "path:line", "verified": true}],
     "lenses_run": [1, 2, 3],
     "lenses_skipped": [{"lens": 8, "why": "no security trigger"}]}

Importable:  validate(record) -> dict ;  append(repo, record) -> Path
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

VERDICTS = {"block", "nits", "needs-work"}
SEVERITIES = {"red", "yellow", "green"}
TOP_LEVEL_KEYS = {
    "date", "branch", "verdict", "findings", "lenses_run", "lenses_skipped",
}
_DATE_FMT = "%Y-%m-%d"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ValidationError(ValueError):
    """The run record itself was rejected; message is safe to print as-is. Exit 1."""


class EnvironmentFailure(RuntimeError):
    """The script couldn't run in this environment (no repo, no stdin, git failed,
    etc). Not a content problem — the record may be fine. Exit 2."""


def _git(repo: Path | None, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=False
    )


def repo_root() -> Path:
    proc = _git(None, "rev-parse", "--show-toplevel")
    if proc.returncode != 0 or not proc.stdout.strip():
        raise EnvironmentFailure(f"not inside a git repo: {proc.stderr.strip()}")
    return Path(proc.stdout.strip())


def current_branch(repo: Path) -> str:
    """Current branch name, or a short commit sha if HEAD is detached."""
    proc = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if proc.returncode != 0 or not proc.stdout.strip():
        raise EnvironmentFailure(f"could not resolve current branch: {proc.stderr.strip()}")
    branch = proc.stdout.strip()
    if branch != "HEAD":
        return branch
    sha = _git(repo, "rev-parse", "--short", "HEAD")
    if sha.returncode != 0 or not sha.stdout.strip():
        raise EnvironmentFailure(f"detached HEAD and could not resolve commit: {sha.stderr.strip()}")
    return sha.stdout.strip()


def _is_lens(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 10


def _require(cond: bool, message: str) -> None:
    if not cond:
        raise ValidationError(message)


def _validate_findings(findings: Any) -> None:
    _require(isinstance(findings, list), "`findings` must be a list")
    for i, f in enumerate(findings):
        _require(isinstance(f, dict), f"findings[{i}] must be an object")
        _require(_is_lens(f.get("lens")), f"findings[{i}].lens must be an int 1-10")
        _require(
            isinstance(f.get("severity"), str) and f["severity"] in SEVERITIES,
            f"findings[{i}].severity must be one of {sorted(SEVERITIES)}",
        )
        _require(
            isinstance(f.get("file"), str) and f["file"],
            f"findings[{i}].file must be a non-empty string",
        )
        _require(
            isinstance(f.get("verified"), bool),
            f"findings[{i}].verified must be a bool",
        )


def _validate_lenses_run(lenses_run: Any) -> None:
    _require(
        isinstance(lenses_run, list) and len(lenses_run) > 0,
        "`lenses_run` must be a non-empty list",
    )
    _require(all(_is_lens(v) for v in lenses_run), "`lenses_run` entries must be ints 1-10")


def _validate_lenses_skipped(lenses_skipped: Any) -> None:
    _require(isinstance(lenses_skipped, list), "`lenses_skipped` must be a list")
    for i, s in enumerate(lenses_skipped):
        _require(isinstance(s, dict), f"lenses_skipped[{i}] must be an object")
        _require(_is_lens(s.get("lens")), f"lenses_skipped[{i}].lens must be an int 1-10")
        _require(
            isinstance(s.get("why"), str) and s["why"],
            f"lenses_skipped[{i}].why must be a non-empty string",
        )


def validate(record: dict[str, Any], *, repo: Path) -> dict[str, Any]:
    """Validate `record` and fill in `date`/`branch` defaults. Raises ValidationError."""
    _require(isinstance(record, dict), "run record must be a JSON object")

    unknown = set(record) - TOP_LEVEL_KEYS
    _require(not unknown, f"unknown top-level key(s): {sorted(unknown)}")

    _require("verdict" in record, "`verdict` is required")
    _require(
        isinstance(record["verdict"], str) and record["verdict"] in VERDICTS,
        f"`verdict` must be one of {sorted(VERDICTS)}",
    )

    _require("findings" in record, "`findings` is required (may be an empty list)")
    _validate_findings(record["findings"])

    _validate_lenses_run(record.get("lenses_run", []))
    lenses_skipped = record.get("lenses_skipped", [])
    _validate_lenses_skipped(lenses_skipped)

    date = record.get("date")
    if date is None:
        date = datetime.datetime.now(datetime.timezone.utc).strftime(_DATE_FMT)
    else:
        _require(isinstance(date, str), "`date` must be a string")
        _require(_DATE_RE.match(date) is not None, "`date` must match YYYY-MM-DD (zero-padded)")
        try:
            datetime.datetime.strptime(date, _DATE_FMT)
        except ValueError as e:
            raise ValidationError(f"`date` must be a valid calendar date: {e}") from e

    branch = record.get("branch")
    if branch is None:
        branch = current_branch(repo)
    else:
        _require(isinstance(branch, str) and branch, "`branch` must be a non-empty string")

    return {**record, "date": date, "branch": branch, "lenses_skipped": lenses_skipped}


def append(repo: Path, record: dict[str, Any]) -> Path:
    """Append exactly one compact, sorted-key JSON line to the review log."""
    log_path = repo / ".claude" / "review-log.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, sort_keys=True, separators=(",", ":"))
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return log_path


def _read_input(arg: str | None) -> str:
    if arg is None or arg == "-":
        if sys.stdin.isatty():
            raise EnvironmentFailure("no JSON given and stdin is a tty")
        return sys.stdin.read()
    return arg


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate and append a /pre-pr run record to review-log.jsonl.")
    ap.add_argument("record", nargs="?", help="run record JSON, or omit/`-` to read stdin")
    args = ap.parse_args()

    try:
        raw = _read_input(args.record)
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValidationError(f"invalid JSON: {e}") from e
        repo = repo_root()
        filled = validate(record, repo=repo)
        log_path = append(repo, filled)
    except ValidationError as e:
        print(f"review-log rejected: {e}", file=sys.stderr)
        return 1
    except EnvironmentFailure as e:
        print(f"review-log environment error: {e}", file=sys.stderr)
        return 2

    print(f"logged 1 line to {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
