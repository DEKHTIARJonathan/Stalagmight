"""Tests for log_run.py — run with `python3 -m unittest scripts.review.test_log_run`.

Each test builds a throwaway git repo (tempfile + `git init`) so repo-root
resolution (`git rev-parse --show-toplevel`) is actually exercised, not mocked.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import log_run  # noqa: E402

VALID_RECORD = {
    "verdict": "nits",
    "findings": [
        {"lens": 3, "severity": "yellow", "file": "src/main.rs:42", "verified": True},
    ],
    "lenses_run": [1, 2, 3],
    "lenses_skipped": [{"lens": 8, "why": "no security trigger"}],
}


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    )


class TempRepo:
    """A throwaway git repo with a `.claude/` dir, for cwd-independent testing."""

    def __enter__(self) -> Path:
        self._tmp = tempfile.TemporaryDirectory()
        repo = Path(self._tmp.name)
        _git(repo, "init", "-q")
        _git(repo, "config", "user.email", "test@example.com")
        _git(repo, "config", "user.name", "Test")
        (repo / "README.md").write_text("test repo\n")
        _git(repo, "add", "README.md")
        _git(repo, "commit", "-q", "-m", "initial")
        _git(repo, "checkout", "-q", "-b", "feature/test-branch")
        self.repo = repo
        return repo

    def __exit__(self, *exc: object) -> None:
        self._tmp.cleanup()


def run_script(repo: Path, arg: str | None, *, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(Path(__file__).resolve().parent / "log_run.py")]
    if arg is not None:
        cmd.append(arg)
    return subprocess.run(
        cmd, cwd=repo, capture_output=True, text=True,
        input=stdin, check=False,
    )


class LogRunScriptTests(unittest.TestCase):
    def test_valid_record_appends_one_line_with_defaults_filled(self) -> None:
        with TempRepo() as repo:
            proc = run_script(repo, json.dumps(VALID_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            log_path = repo / ".claude" / "review-log.jsonl"
            lines = log_path.read_text("utf-8").splitlines()
            self.assertEqual(len(lines), 1)

            logged = json.loads(lines[0])
            self.assertEqual(logged["branch"], "feature/test-branch")
            self.assertRegex(logged["date"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertEqual(logged["verdict"], "nits")

    def test_append_twice_yields_two_lines_first_unchanged(self) -> None:
        with TempRepo() as repo:
            proc1 = run_script(repo, json.dumps(VALID_RECORD))
            self.assertEqual(proc1.returncode, 0, proc1.stderr)
            log_path = repo / ".claude" / "review-log.jsonl"
            first_line = log_path.read_text("utf-8").splitlines()[0]

            second = {**VALID_RECORD, "verdict": "block"}
            proc2 = run_script(repo, json.dumps(second))
            self.assertEqual(proc2.returncode, 0, proc2.stderr)

            lines = log_path.read_text("utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(lines[0], first_line)
            self.assertEqual(json.loads(lines[1])["verdict"], "block")

    def test_stdin_form_works(self) -> None:
        with TempRepo() as repo:
            proc = run_script(repo, None, stdin=json.dumps(VALID_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            log_path = repo / ".claude" / "review-log.jsonl"
            self.assertEqual(len(log_path.read_text("utf-8").splitlines()), 1)

    def _assert_rejected(self, repo: Path, payload: str) -> None:
        log_path = repo / ".claude" / "review-log.jsonl"
        before = log_path.read_bytes() if log_path.exists() else b""
        proc = run_script(repo, payload)
        self.assertEqual(proc.returncode, 1)
        self.assertNotEqual(proc.stderr.strip(), "")
        after = log_path.read_bytes() if log_path.exists() else b""
        self.assertEqual(before, after)

    def test_bad_verdict_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "verdict": "reject-with-prejudice"}
            self._assert_rejected(repo, json.dumps(bad))

    def test_lens_out_of_range_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 11, "severity": "red", "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_unknown_top_level_key_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "reviewer": "someone"}
            self._assert_rejected(repo, json.dumps(bad))

    def test_malformed_json_rejected(self) -> None:
        with TempRepo() as repo:
            self._assert_rejected(repo, "{not valid json")

    def test_first_reject_then_valid_appends_only_one_line(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "verdict": "nope"}
            self._assert_rejected(repo, json.dumps(bad))
            proc = run_script(repo, json.dumps(VALID_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            log_path = repo / ".claude" / "review-log.jsonl"
            self.assertEqual(len(log_path.read_text("utf-8").splitlines()), 1)

    def test_unhashable_verdict_rejected_cleanly(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "verdict": ["block"]}
            self._assert_rejected(repo, json.dumps(bad))

    def test_unhashable_severity_rejected_cleanly(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 3, "severity": ["red"], "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_non_zero_padded_date_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "date": "2026-1-1"}
            self._assert_rejected(repo, json.dumps(bad))

    def test_lens_bool_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": True, "severity": "red", "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_lens_float_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 1.0, "severity": "red", "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_not_a_git_repo_exits_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            proc = run_script(repo, json.dumps(VALID_RECORD))
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertNotEqual(proc.stderr.strip(), "")

    def test_detached_head_branch_falls_back_to_short_sha(self) -> None:
        with TempRepo() as repo:
            sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
            short_sha = _git(repo, "rev-parse", "--short", "HEAD").stdout.strip()
            _git(repo, "checkout", "-q", sha)

            record = {**VALID_RECORD}
            del record["lenses_skipped"]
            proc = run_script(repo, json.dumps(record))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            log_path = repo / ".claude" / "review-log.jsonl"
            logged = json.loads(log_path.read_text("utf-8").splitlines()[0])
            self.assertEqual(logged["branch"], short_sha)
            self.assertNotEqual(logged["branch"], "HEAD")

    def test_omitted_lenses_skipped_defaults_to_empty_list_in_output(self) -> None:
        with TempRepo() as repo:
            record = {**VALID_RECORD}
            del record["lenses_skipped"]
            proc = run_script(repo, json.dumps(record))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            log_path = repo / ".claude" / "review-log.jsonl"
            logged = json.loads(log_path.read_text("utf-8").splitlines()[0])
            self.assertIn("lenses_skipped", logged)
            self.assertEqual(logged["lenses_skipped"], [])


if __name__ == "__main__":
    unittest.main()
