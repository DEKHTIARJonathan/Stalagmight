"""Tests for log_run.py - run with `python3 -m unittest scripts.review.test_log_run`.

Each test builds a throwaway git repo (tempfile + `git init`) so repo-root
resolution (`git rev-parse --show-toplevel`) is actually exercised, not mocked.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import log_run  # noqa: E402

# Every lens accounted for exactly once: run + skipped are disjoint and their
# union is the whole vocabulary. A record that does not account for a lens is
# rejected, so a fixture cannot quietly under-report.
VALID_RECORD = {
    "verdict": "nits",
    "findings": [
        {"lens": 3, "severity": "yellow", "file": "src/main.rs:42", "verified": True},
    ],
    "lenses_run": [1, 2, 3, 4, 5, 6, 7, 9, 10],
    "lenses_skipped": [{"lens": 8, "why": "no security trigger"}],
}

# For the cases that must omit `lenses_skipped` entirely: everything ran, so the
# accounting is still complete with no skip list at all.
ALL_RUN_RECORD = {
    "verdict": "nits",
    "findings": [
        {"lens": 3, "severity": "yellow", "file": "src/main.rs:42", "verified": True},
    ],
    "lenses_run": sorted(log_run.LENS_IDS),
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
        self.assertEqual(proc.returncode, 1, proc.stderr)
        # Asserting exit 1 + non-empty stderr is NOT enough: an uncaught
        # exception also exits 1 and also prints to stderr, so a crash passed as
        # a "clean rejection". Pin the handled-path message and the absence of a
        # traceback, or every test using this helper is blind to a regression
        # that turns a graceful reject into a stack dump.
        self.assertIn("review-log rejected:", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
        after = log_path.read_bytes() if log_path.exists() else b""
        self.assertEqual(before, after)

    def _assert_environment_failure(self, repo: Path, payload: str) -> None:
        proc = run_script(repo, payload)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("review-log environment error:", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

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

            proc = run_script(repo, json.dumps(ALL_RUN_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            log_path = repo / ".claude" / "review-log.jsonl"
            logged = json.loads(log_path.read_text("utf-8").splitlines()[0])
            self.assertEqual(logged["branch"], short_sha)
            self.assertNotEqual(logged["branch"], "HEAD")

    def test_omitted_lenses_skipped_defaults_to_empty_list_in_output(self) -> None:
        with TempRepo() as repo:
            proc = run_script(repo, json.dumps(ALL_RUN_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            log_path = repo / ".claude" / "review-log.jsonl"
            logged = json.loads(log_path.read_text("utf-8").splitlines()[0])
            self.assertIn("lenses_skipped", logged)
            self.assertEqual(logged["lenses_skipped"], [])

    def test_omitted_lenses_run_still_appears_in_output(self) -> None:
        # `validate` reads it with .get("lenses_run", []), so omitting the key is
        # NOT rejected on its own - it is only rejected when the completeness
        # check has nothing to satisfy it. Skip all ten and the record is legal
        # with no `lenses_run` at all, which is the one input that distinguishes
        # an explicit write-back from `{**record}`.
        #
        # A version of this test built on VALID_RECORD was VACUOUS: that fixture
        # supplies `lenses_run`, so `{**record}` carried it and deleting the
        # write-back changed nothing. Caught by injection, 2026-07-30.
        with TempRepo() as repo:
            record = {
                "date": "2026-07-30",
                "branch": "feat/x",
                "verdict": "nits",
                "findings": [],
                "lenses_skipped": [
                    {"lens": i, "why": "trivial diff"} for i in sorted(log_run.LENS_IDS)
                ],
            }
            self.assertNotIn("lenses_run", record)
            proc = run_script(repo, json.dumps(record))
            self.assertEqual(proc.returncode, 0, proc.stderr)

            logged = json.loads(
                (repo / ".claude" / "review-log.jsonl").read_text("utf-8").splitlines()[0]
            )
            for key in ("lenses_run", "lenses_skipped"):
                self.assertIn(key, logged, f"`{key}` missing from the logged line")
            self.assertEqual(logged["lenses_run"], [])

    # --- cross-field accounting: the invariant the log's purpose rests on ---

    def test_lens_both_run_and_skipped_rejected(self) -> None:
        with TempRepo() as repo:
            # `lenses_run` is the FULL vocabulary here on purpose: the union is
            # therefore complete, so the completeness check cannot fire and only
            # the disjointness check can reject this. With a partial run list
            # this test passed via completeness and left disjointness unpinned
            # (caught by injection).
            bad = {
                **VALID_RECORD,
                "lenses_run": sorted(log_run.LENS_IDS),
                "lenses_skipped": [{"lens": 3, "why": "contradiction"}],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_unaccounted_lens_rejected(self) -> None:
        with TempRepo() as repo:
            # Lens 8 in neither list: the exact "ran-clean vs never-ran are
            # indistinguishable" hole this record shape exists to close.
            bad = {**VALID_RECORD, "lenses_skipped": []}
            self._assert_rejected(repo, json.dumps(bad))

    def test_duplicate_in_lenses_run_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {**VALID_RECORD, "lenses_run": [1, 1, 2, 3, 4, 5, 6, 7, 9, 10]}
            self._assert_rejected(repo, json.dumps(bad))

    def test_duplicate_in_lenses_skipped_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "lenses_skipped": [
                    {"lens": 8, "why": "first"},
                    {"lens": 8, "why": "again"},
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_finding_citing_a_lens_that_did_not_run_rejected(self) -> None:
        with TempRepo() as repo:
            # Lens 8 was skipped, so it cannot have produced a finding - and the
            # consumer would score it as "earns its keep" off a run it sat out.
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 8, "severity": "red", "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_all_lenses_skipped_is_loggable(self) -> None:
        with TempRepo() as repo:
            record = {
                "verdict": "nits",
                "findings": [],
                "lenses_run": [],
                "lenses_skipped": [
                    {"lens": i, "why": "trivial diff"} for i in sorted(log_run.LENS_IDS)
                ],
            }
            proc = run_script(repo, json.dumps(record))
            self.assertEqual(proc.returncode, 0, proc.stderr)

    # --- field-level gaps that had no coverage ---

    def test_omitted_lenses_run_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {k: v for k, v in VALID_RECORD.items() if k != "lenses_run"}
            self._assert_rejected(repo, json.dumps(bad))

    def test_empty_finding_file_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [{"lens": 3, "severity": "red", "file": "", "verified": True}],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_non_bool_verified_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 3, "severity": "red", "file": "x.rs:1", "verified": "yes"}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_lens_zero_rejected(self) -> None:
        with TempRepo() as repo:
            bad = {
                **VALID_RECORD,
                "findings": [
                    {"lens": 0, "severity": "red", "file": "x.rs:1", "verified": True}
                ],
            }
            self._assert_rejected(repo, json.dumps(bad))

    def test_invalid_calendar_date_rejected(self) -> None:
        with TempRepo() as repo:
            # Passes the zero-padded regex, fails as a real date.
            bad = {**VALID_RECORD, "date": "2026-02-30"}
            self._assert_rejected(repo, json.dumps(bad))

    def test_explicit_dash_reads_stdin(self) -> None:
        with TempRepo() as repo:
            proc = run_script(repo, "-", stdin=json.dumps(VALID_RECORD))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            log_path = repo / ".claude" / "review-log.jsonl"
            self.assertEqual(len(log_path.read_text("utf-8").splitlines()), 1)

    # --- environment failures must be exit 2, never exit 1 ---

    def test_empty_stdin_exits_2(self) -> None:
        with TempRepo() as repo:
            proc = run_script(repo, None, stdin="")
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertIn("review-log environment error:", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)

    def test_directory_at_log_path_exits_2(self) -> None:
        with TempRepo() as repo:
            (repo / ".claude").mkdir(parents=True, exist_ok=True)
            (repo / ".claude" / "review-log.jsonl").mkdir()
            self._assert_environment_failure(repo, json.dumps(VALID_RECORD))

    def test_symlink_at_log_path_is_refused(self) -> None:
        with TempRepo() as repo, tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "elsewhere.jsonl"
            target.write_text("PRE-EXISTING\n", encoding="utf-8")
            (repo / ".claude").mkdir(parents=True, exist_ok=True)
            (repo / ".claude" / "review-log.jsonl").symlink_to(target)

            self._assert_environment_failure(repo, json.dumps(VALID_RECORD))
            # The whole point: nothing was written through the link.
            self.assertEqual(target.read_text("utf-8"), "PRE-EXISTING\n")

    def test_git_missing_exits_2(self) -> None:
        with TempRepo() as repo:
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent / "log_run.py")],
                cwd=repo, capture_output=True, text=True,
                input=json.dumps(VALID_RECORD), check=False,
                env={"PATH": "/nonexistent-dir-for-test", "HOME": str(repo)},
            )
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)

    # --- the documented scratch override ---

    def test_log_override_redirects_the_write(self) -> None:
        with TempRepo() as repo, tempfile.TemporaryDirectory() as scratch:
            elsewhere = Path(scratch) / "scratch-log.jsonl"
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent / "log_run.py")],
                cwd=repo, capture_output=True, text=True,
                input=json.dumps(VALID_RECORD), check=False,
                env={**os.environ, log_run._LOG_OVERRIDE_ENV: str(elsewhere)},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(len(elsewhere.read_text("utf-8").splitlines()), 1)
            # And the real log was left alone.
            self.assertFalse((repo / ".claude" / "review-log.jsonl").exists())

    def test_relative_log_override_exits_2(self) -> None:
        with TempRepo() as repo:
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent / "log_run.py")],
                cwd=repo, capture_output=True, text=True,
                input=json.dumps(VALID_RECORD), check=False,
                env={**os.environ, log_run._LOG_OVERRIDE_ENV: "relative/path.jsonl"},
            )
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)

    # --- the module's own documented importable contract ---

    def test_validate_is_importable_with_the_documented_signature(self) -> None:
        with TempRepo() as repo:
            filled = log_run.validate(dict(VALID_RECORD), repo=repo)
            self.assertEqual(filled["branch"], "feature/test-branch")
            self.assertEqual(filled["lenses_skipped"], VALID_RECORD["lenses_skipped"])

    def test_validate_raises_validation_error_on_a_bad_record(self) -> None:
        with TempRepo() as repo:
            with self.assertRaises(log_run.ValidationError):
                log_run.validate({**VALID_RECORD, "verdict": "nope"}, repo=repo)


if __name__ == "__main__":
    unittest.main()
