# Contributing to Stalagmight

Thanks for your interest in Stalagmight. This guide covers **who we're built
for**, **how to set up and build the project**, our expectations for
**AI-assisted contributions**, and the **checks your change must pass** before
you open a pull request.

If you would like to get started, we have an active and maintained [issue tracker](https://github.com/Stalagmight/Stalagmight/issues?q=is%3Aissue%20state%3Aopen%20no%3Aassignee) -- please check for open, unassigned bugs there!

Please also read [SECURITY.md](SECURITY.md) for how to report vulnerabilities
(don't open a public issue for those).


---

## Who we're built for

Stalagmight is built by and for cave-survey divers. The domain - underwater
cave surveying, instrument data, loop closure, gas and dive planning - takes
specialized, lived experience to get right. A well-meaning change from someone
who hasn't done the surveying can quietly break *correctness* in ways that
aren't visible in the code or caught by tests.

So we're honest about our contribution model:

- **Cave-diver engineers** - welcome and encouraged. You're exactly who this is
  for. Issues, feature proposals, and PRs across the whole codebase are all fair
  game.

- **Everyone else** - we genuinely value the help, and there's a lot you *can*
  contribute without domain knowledge:
  - clear bug reports with reproduction steps,
  - documentation fixes and improvements,
  - accessibility and internationalization (i18n),
  - build, packaging, CI, and developer-tooling improvements,
  - performance profiling and optimization,
  - dependency and security hygiene.

  What we'll generally **not** merge from contributors without cave-survey
  experience are changes to the **survey/geometry/planning domain logic, default
  parameters, or the diving-workflow UX** - not because your code is bad, but
  because we can't responsibly review domain correctness without the surveying
  background, and carrying that review burden isn't sustainable for us.

We'd rather tell you this up front than walk you through a PR we were never going
to land. If you're unsure whether an idea falls inside or outside that line,
**open an issue first** and ask - we're happy to talk it through.

## AI-assisted contributions

We build Stalagmight largely with [Claude](https://claude.com/claude-code), and
we welcome AI-assisted PRs - in fact we'd rather you used a capable coding agent
than not. [`AGENTS.md`](AGENTS.md) carries the build and test rules an agent
needs, so point your agent at it. A few expectations:

- **You are the author.** Understand your change well enough to explain and
  defend it in review. "The agent wrote it" isn't an answer to a review
  question.
- **Gates pass before you open the PR** (see below). Don't outsource that to the
  reviewer.
- **No slop.** No unrelated reformatting, invented APIs, speculative
  abstraction, or AI-generated filler comments and docs. Keep diffs minimal and
  on-topic, and match the surrounding code's style.
- **Disclose it.** A one-line note in the PR description if an agent did the
  heavy lifting. We don't penalize it; we just like to know.
- The **domain-scope rule above still applies** - an agent is not a substitute
  for cave-survey expertise on domain logic.

---

## Development setup

**Prerequisites:** [Rust](https://rustup.rs/) (stable), Node 22.x, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

The toolchain is pinned - pnpm `9.15.9` (via `packageManager`) and Node `22.x`
(via `.nvmrc`). On a fresh clone:

```bash
corepack enable      # makes pnpm honor the pinned version (avoids a pnpm 11 hard-fail)
pnpm install
./scripts/dev.sh     # always use this to start/restart the dev app
```

A few project rules worth knowing early (full detail in
[`AGENTS.md`](AGENTS.md)):

- **Never `cd` in a shell command** - use `--manifest-path` for cargo or a
  subshell. A persisted `cd` has caused files to land in the wrong directory.
- **IPC types are generated.** Don't hand-edit `src/types/ipc/`; change the Rust
  type and run `pnpm gen:ipc-types`, then commit the regenerated output.
- **You don't need telemetry to contribute.** A plain `pnpm tauri build` (no
  `telemetry` feature) needs no secrets.

## Before you open a pull request

Run the same checks CI runs. All of these must pass:

```bash
pnpm tsc --noEmit                                                  # TypeScript
pnpm typecheck:agent                                               # agent-harness typecheck (a CI gate)
CI=true pnpm test                                                 # vitest unit + component (CI=true runs once, not watch)
pnpm test:ui                                                       # Playwright (needs a display)
pnpm lint:e2e-parallel                                             # Playwright parallel-safety (a CI gate)
pnpm lint:rust-file-size                                           # Rust file-size ratchet (a CI gate)
pnpm lint:ts-file-size                                             # TS file-size ratchet (a CI gate)
pnpm lint:readonly-gates                                           # read-only gating tripwire (a CI gate)
pnpm lint:private-leaks                                            # no internal/personal refs in the public tree (a CI gate)
pnpm lint:no-em-dash                                               # ASCII hyphens only, no Unicode dashes (a CI gate)
cargo fmt --manifest-path src-tauri/Cargo.toml --check             # Rust formatting
TELEMETRY_ENDPOINT=http://localhost/dummy \
  cargo clippy --manifest-path src-tauri/Cargo.toml --features telemetry --all-targets   # deny-level lints
TELEMETRY_ENDPOINT=http://localhost/dummy \
  cargo test --manifest-path src-tauri/Cargo.toml --features telemetry                   # Rust tests
```

(The dummy `TELEMETRY_ENDPOINT` just satisfies `build.rs` under the `telemetry`
feature - it sends nothing.) On Windows, run the Rust tests via
`./scripts/test.ps1`. The Pre-Push Checklist in [`AGENTS.md`](AGENTS.md) is the
canonical copy of this list - if the two drift, that one is authoritative.

Notes:

- **Rust formatting and lints are CI-gated** (deny-level clippy). Run `cargo fmt`
  to fix formatting; clear all clippy warnings. The lint policy is documented in
  [docs/linting.md](docs/linting.md).
- **Tests:** cover the adversarial case (boundaries, duplicate IDs, legacy
  inputs), not just the happy path. Parsers have golden fixtures. Details in
  [docs/TESTING.md](docs/TESTING.md).

## Pull request guidelines

- **One concern per PR.** Keep changes focused and reviewable; don't bundle
  unrelated work.
- **Commits** follow concise semantic style (`feat: …`, `fix: …`, `docs: …`).
- **Describe the change** and how you verified it. Link the relevant issue.
- PRs are automatically reviewed by bots (e.g. GitHub Copilot) in addition to a
  maintainer. Treat CI-breaking or correctness findings as blocking; reply
  inline to anything you're intentionally not changing.

## Reporting bugs and requesting features

Open an issue. For bugs, include the platform, app version, steps to reproduce,
and - if relevant - a (non-sensitive) sample survey file. For domain/feature
ideas outside the contribution scope above, an issue is the right place to start
the conversation.

## License of contributions

By contributing, you agree that your contributions are licensed under the
project's **AGPL-3.0-or-later** license (see [LICENSE](LICENSE)).
