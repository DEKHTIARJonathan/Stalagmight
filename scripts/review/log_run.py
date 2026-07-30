#!/usr/bin/env python3
"""Review-run logger - validate and append one JSONL record to review-log.jsonl.

Rejects a malformed record outright rather than letting bad data reach the log,
and resolves the log path from the repo root so it does not depend on being run
from any particular subdirectory.

WHICH repo, however, is decided by cwd: the path comes from `git rev-parse
--show-toplevel`, so running this from inside a checkout writes to THAT
checkout's log - including a sibling clone or a git worktree, each of which has
its own log. The file is gitignored, so a stray write is invisible to
`git status`. Set STALAGMIGHT_REVIEW_LOG to an absolute path to redirect the
write (intended for tests and ad-hoc probing; six independent review agents
polluted a real log before this existed).

Input is one run record as JSON - a single positional argument, or on stdin
(`-` or no argument). Prefer stdin from a FILE over a shell-quoted argument:
a record embeds file paths taken from the diff under review, and splicing those
into a quoted shell word is injectable. On success, exactly one compact JSON
line (keys sorted) is appended to `<repo-root>/.claude/review-log.jsonl`
(created if absent) and a one-line confirmation is printed to stdout. On any
failure the file is left untouched and the reason is printed to stderr; the run
is not logged until this script exits 0. Exit codes distinguish the two failure
classes:
    1 - the record itself was rejected (bad verdict, malformed JSON, etc.) -
        fix the record and re-run.
    2 - an environment/usage problem (not inside a git repo, empty or absent
        stdin, git missing or failing, the log path unwritable or a symlink) -
        the record may be fine; fix how the script was run.

Usage:
    log_run.py < record.json   # preferred
    log_run.py -               # explicit stdin
    log_run.py '<json>'        # only for a record you constructed yourself

Record shape:
    {"date": "YYYY-MM-DD",              # optional; defaults to today (UTC)
     "branch": "chore/x",               # optional; defaults to current branch
     "verdict": "block|nits|needs-work",
     "findings": [{"lens": 1-10, "severity": "red|yellow|green",
                   "file": "path:line", "verified": true}],
     "lenses_run": [1, 2, 3],
     "lenses_skipped": [{"lens": 8, "why": "no security trigger"}]}

`lenses_run` and `lenses_skipped` must together account for every lens exactly
once: disjoint, no duplicates, union == all lens ids. Every findings[].lens
must appear in `lenses_run`. Those cross-field rules are the whole point - a
record that cannot say which lenses ran cannot support a retire decision.

A supplied `date`/`branch` is recorded AS GIVEN and is not checked against git
or the clock; omit both and let this script fill them.

Importable:  validate(record, *, repo) -> dict ;  append(repo, record) -> Path
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
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
# The lens vocabulary, in one place: `_is_lens` bounds every lens field against
# it AND `validate` requires run+skipped to cover it exactly. Changing the lens
# count means changing this alone.
LENS_IDS = frozenset(range(1, 11))
_LOG_OVERRIDE_ENV = "STALAGMIGHT_REVIEW_LOG"
_DATE_FMT = "%Y-%m-%d"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ValidationError(ValueError):
    """The run record itself was rejected; message is safe to print as-is. Exit 1."""


class EnvironmentFailure(RuntimeError):
    """The script couldn't run in this environment (no repo, no stdin, git failed,
    etc). Not a content problem - the record may be fine. Exit 2."""


def _git(repo: Path | None, *args: str) -> subprocess.CompletedProcess[str]:
    # argv list, never shell=True: a branch name can contain shell metacharacters.
    # OSError here means git is missing or unrunnable, which is an environment
    # problem (exit 2), not a bad record - without this it escaped as a traceback
    # and the interpreter's default exit 1 read as "fix your JSON".
    try:
        return subprocess.run(
            ["git", *args], cwd=repo, capture_output=True, text=True, check=False
        )
    except OSError as e:
        raise EnvironmentFailure(f"could not run git: {e}") from e


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
    return isinstance(v, int) and not isinstance(v, bool) and v in LENS_IDS


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
    # Deliberately NOT "must be non-empty": a review where every lens was
    # legitimately skipped is a real outcome, and the completeness check in
    # `validate` is what actually stops a record from under-reporting.
    _require(isinstance(lenses_run, list), "`lenses_run` must be a list")
    _require(all(_is_lens(v) for v in lenses_run), "`lenses_run` entries must be ints 1-10")
    _require(
        len(set(lenses_run)) == len(lenses_run),
        "`lenses_run` must not contain duplicates (a duplicate inflates the ran count)",
    )


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

    lenses_run = record.get("lenses_run", [])
    _validate_lenses_run(lenses_run)
    lenses_skipped = record.get("lenses_skipped", [])
    _validate_lenses_skipped(lenses_skipped)

    # Cross-field accounting. Each list validates fine in isolation while the
    # record as a whole says something impossible, and the consumer keys its
    # keep/retire recommendation off exactly these counts - so a lens claimed as
    # both run and skipped, an unaccounted lens, or a finding from a lens that
    # never ran all corrupt the decision this log exists to inform.
    run_set = set(lenses_run)
    skipped_set = {s["lens"] for s in lenses_skipped}
    both = run_set & skipped_set
    _require(
        not both,
        f"lens(es) {sorted(both)} appear in both `lenses_run` and `lenses_skipped`",
    )
    _require(
        len(skipped_set) == len(lenses_skipped),
        "`lenses_skipped` must not list the same lens twice",
    )
    missing = LENS_IDS - run_set - skipped_set
    _require(
        not missing,
        f"lens(es) {sorted(missing)} are in neither `lenses_run` nor `lenses_skipped`; "
        "every lens must be accounted for or ran-clean and never-ran stay indistinguishable",
    )
    orphaned = sorted({f["lens"] for f in record["findings"]} - run_set)
    _require(
        not orphaned,
        f"findings cite lens(es) {orphaned} that are not in `lenses_run`",
    )

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

    # Both lens lists are written back explicitly, not just the one that has a
    # default. `lenses_run` is required, so it is always in `record` today - but
    # relying on that would mean every line on disk carries the full schema only
    # by accident, and a reader that indexes `rec["lenses_run"]` instead of
    # `rec.get(...)` would KeyError on the first record that ever omits it.
    return {
        **record,
        "date": date,
        "branch": branch,
        "lenses_run": lenses_run,
        "lenses_skipped": lenses_skipped,
    }


def log_path_for(repo: Path) -> Path:
    """Where the log lives, honouring the scratch override."""
    override = os.environ.get(_LOG_OVERRIDE_ENV)
    if override:
        path = Path(override)
        if not path.is_absolute():
            raise EnvironmentFailure(f"{_LOG_OVERRIDE_ENV} must be an absolute path, got {override!r}")
        return path
    return repo / ".claude" / "review-log.jsonl"


def append(repo: Path, record: dict[str, Any]) -> Path:
    """Append exactly one compact, sorted-key JSON line to the review log."""
    log_path = log_path_for(repo)
    # A symlink here would silently redirect the append outside the repo, and
    # gitignoring the path does not stop a *tracked* symlink from being checked
    # out at it. Refuse rather than follow.
    if log_path.is_symlink():
        raise EnvironmentFailure(f"refusing to write through a symlink at {log_path}")
    line = json.dumps(record, sort_keys=True, separators=(",", ":"))
    # mkdir/open/write are all environment faults, not record faults: an
    # unwritable .claude/, a directory at the log path, or a full disk must not
    # tell the caller to go and edit its JSON.
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as e:
        raise EnvironmentFailure(f"could not append to {log_path}: {e}") from e
    return log_path


def _read_input(arg: str | None) -> str:
    if arg is None or arg == "-":
        if sys.stdin.isatty():
            raise EnvironmentFailure("no JSON given and stdin is a tty")
        raw = sys.stdin.read()
        # Empty stdin is a usage problem (nothing was piped), not a malformed
        # record; without this it fell through to json.loads and reported as
        # "invalid JSON", i.e. exit 1 telling the caller to fix a record it
        # never sent.
        if not raw.strip():
            raise EnvironmentFailure("stdin was empty; pipe or redirect a JSON record")
        return raw
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
