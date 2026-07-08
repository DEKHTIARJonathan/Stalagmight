#!/usr/bin/env python3
"""Layer-1 review pack — one shared, blind-safe brief for every review finder.

Builds a single mechanical artifact so a fan-out review stops paying N finders to
independently rediscover the same diff and its surroundings. For a ~2k-LOC PR the
pack is ~20-40k tokens; each finder reads it once, then opens only what it points
at. Because it is purely mechanical, no author intent leaks through it — the
blind-briefing the pipeline depends on is preserved and strengthened (Layer 1 of
the /pre-pr gate, .claude/commands/pre-pr.md).

Contents (in order):
    1. Layer-0 FLAGS            (from preflight.py — landmines, security trigger)
    2. Risk classification      (changed files bucketed high/medium/normal by path)
    3. Signature skeletons      (from skeleton.py — changed symbols, not full files)
    4. Consumer map             (rg call-sites for each changed public symbol)
    5. The diff                 (git diff <base>...HEAD, computed once)

Usage:
    review_pack.py [--base REF] [--config PATH] [--repo DIR] [-o FILE]
                   [--max-consumers N] [--max-symbols N] [--max-diff-lines N]
                   [--no-diff]

    --base REF          diff base (default: auto — origin/HEAD, else master/main)
    --config PATH       shared review config (default: <repo>/.claude/review.toml)
    --max-consumers N   cap call-sites shown per symbol (default 12)
    --max-symbols N     cap symbols in the consumer map (default 40)
    --max-diff-lines N  truncate the appended diff (default 4000; 0 = unlimited)
    --no-diff           omit the raw diff (skeletons + consumer map only)
    -o FILE             write the pack to FILE instead of stdout

Why: the single biggest duplication cut in the review pipeline. The consumer map
directly serves the "verify consumers, not producers" rule — finders quote the
gating line instead of hunting for it.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # import sibling tools
import preflight  # noqa: E402
import skeleton  # noqa: E402

DEFAULT_RISK: dict[str, list[str]] = {
    "high": ["**/persistence*", "**/save*", "**/undo*", "**/migrat*", "**/schema*",
             "**/*.sql", "**/auth*", "**/crypto*", "**/secret*"],
    "medium": ["**/ipc*", "**/api/**", "**/store/**", "**/state*", "**/hooks/**"],
}
# Symbol names too common to chase — the consumer map would be all noise.
STOP_NAMES = {
    "main", "test", "props", "data", "value", "index", "state", "error",
    "result", "config", "default", "render", "update", "handler", "options",
    "context", "item", "name", "type", "self", "node", "child", "params",
}
# rg deliberately searches ALL text files (not just code): string-keyed
# references in SQL/docs/config are exactly the consumers the compiler misses.
RG_EXCLUDE = "!{node_modules,target,dist,build,.git,vendor,__pycache__,.next,coverage,generated}/**"


def load_risk(config: Path) -> dict[str, list[str]]:
    if config.is_file():
        try:
            risk = tomllib.loads(config.read_text("utf-8")).get("risk")
            if isinstance(risk, dict) and risk:
                return {k: list(v) for k, v in risk.items()}
        except (OSError, tomllib.TOMLDecodeError, TypeError):
            pass
    return DEFAULT_RISK


def classify(path: str, risk: dict[str, list[str]]) -> str:
    for level in ("high", "medium"):
        if preflight.path_matches(path, risk.get(level, [])):
            return level
    return "normal"


def consumer_map(repo: Path, definers: dict[str, set[str]], symbols: list[str], max_consumers: int) -> list[str]:
    lines: list[str] = []
    for name in symbols:
        proc = subprocess.run(
            ["rg", "--no-heading", "--line-number", "--word-regexp", "--fixed-strings",
             "--glob", RG_EXCLUDE, "--", name, "."],
            cwd=repo, capture_output=True, text=True, check=False,
        )
        own = definers.get(name, set())  # exclude the symbol's own definition site(s)
        hits: list[str] = []
        for raw in proc.stdout.splitlines():
            parts = raw.split(":", 2)
            if len(parts) < 3:
                continue
            fpath = parts[0].removeprefix("./")
            if fpath in own:  # a consumer inside this same PR is still worth tracing
                continue
            hits.append(f"    {fpath}:{parts[1]}: {parts[2].strip()[:120]}")
        if not hits:
            lines.append(f"- `{name}` — no external references found (new, dead, or string-keyed)")
        else:
            shown = hits[:max_consumers]
            more = f"  … +{len(hits) - len(shown)} more" if len(hits) > len(shown) else ""
            lines.append(f"- `{name}` ({len(hits)} refs){more}")
            lines.extend(shown)
    return lines


def build(repo: Path, base: str | None, config: Path, args: argparse.Namespace) -> str:
    diff_text, mode = preflight.compute_diff(repo, base)
    changed = preflight.changed_files(diff_text)
    risk = load_risk(config)

    out: list[str] = [f"# Review pack — `{mode}`  ({len(changed)} files changed)", ""]

    # 1. Layer-0 flags
    res = preflight.collect(repo, base, config, use_builtin=True)
    out.append(preflight.render_md(res))

    # 2. Risk classification
    buckets: dict[str, list[str]] = {"high": [], "medium": [], "normal": []}
    for f in changed:
        buckets[classify(f, risk)].append(f)
    out.append("## Risk classification")
    for level in ("high", "medium", "normal"):
        if buckets[level]:
            out.append(f"- **{level}**: " + ", ".join(f"`{f}`" for f in buckets[level]))
    out.append("")

    # 3. Signature skeletons of changed source files (post-image on disk)
    out.append("## Changed-file skeletons")
    symbols: list[str] = []
    definers: dict[str, set[str]] = {}
    src_changed = [f for f in changed if skeleton.detect_lang(Path(f)) and (repo / f).is_file()]
    for f in src_changed:
        fs = skeleton.extract(repo / f)
        fs.path = f  # show repo-relative, not absolute
        out.append(skeleton.render_md(fs))
        for name in skeleton.exported_names(fs):
            symbols.append(name)
            definers.setdefault(name, set()).add(f)
    if not src_changed:
        out.append("_(no changed source files to skeletonize)_\n")

    # 4. Consumer map for changed public symbols
    seen: set[str] = set()
    candidates = [
        s for s in symbols
        if len(s) >= 4 and s.lower() not in STOP_NAMES and not (s in seen or seen.add(s))
    ]
    out.append("## Consumer map  (verify the consumer, not just the producer)")
    if not candidates:
        out.append("_(no public symbols to trace)_\n")
    else:
        capped = candidates[: args.max_symbols]
        if len(candidates) > len(capped):
            out.append(f"_showing {len(capped)} of {len(candidates)} changed symbols (raise --max-symbols)_")
        out.extend(consumer_map(repo, definers, capped, args.max_consumers))
        out.append("")

    # 5. The diff
    if not args.no_diff:
        out.append("## Diff")
        dlines = diff_text.splitlines()
        if args.max_diff_lines and len(dlines) > args.max_diff_lines:
            kept = dlines[: args.max_diff_lines]
            kept.append(f"… diff truncated at {args.max_diff_lines} lines "
                        f"(+{len(dlines) - args.max_diff_lines}); raise --max-diff-lines or read the file directly")
            dlines = kept
        out.append("```diff")
        out.extend(dlines)
        out.append("```")

    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Layer-1 shared review pack generator.")
    ap.add_argument("--base", help="diff base ref (default: auto-detect)")
    ap.add_argument("--config", help="review config TOML (default: <repo>/.claude/review.toml)")
    ap.add_argument("--repo", default=".", help="repo root (default: cwd)")
    ap.add_argument("--max-consumers", type=int, default=12, help="call-sites per symbol")
    ap.add_argument("--max-symbols", type=int, default=40, help="symbols in the consumer map")
    ap.add_argument("--max-diff-lines", type=int, default=4000, help="diff truncation (0 = unlimited)")
    ap.add_argument("--no-diff", action="store_true", help="omit the raw diff")
    ap.add_argument("-o", "--output", help="write pack to FILE instead of stdout")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    is_git = subprocess.run(["git", "rev-parse", "--git-dir"], cwd=repo,
                            capture_output=True, text=True, check=False)
    if is_git.returncode != 0:
        print(f"not a git repo: {repo}", file=sys.stderr)
        return 1
    if not shutil.which("rg"):
        print("ripgrep (rg) not found — the consumer map needs it; install ripgrep", file=sys.stderr)
        return 1
    config = Path(args.config) if args.config else repo / ".claude" / "review.toml"
    base = preflight.resolve_base(repo, args.base)

    pack = build(repo, base, config, args)
    if args.output:
        Path(args.output).write_text(pack, "utf-8")
        print(f"wrote {args.output} ({len(pack):,} bytes)", file=sys.stderr)
    else:
        print(pack, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
