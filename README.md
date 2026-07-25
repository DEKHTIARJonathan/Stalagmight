# Stalagmight

**A desktop application for processing, visualizing, and planning underwater cave survey data.**

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

Stalagmight is an intuitive, modern, open underwater cave survey application.
It takes other surveys, hand surveys, or `.dmp` files from an mNemo device
and guides the user into creating a clean, editable, georeferenced
map you can reason about and plan future exploration with. It
imports the formats divers already use (Ariane, Compass), adjusts
survey loops, renders the cave over satellite imagery, and supports
the editing and planning workflows that come after the dive.

Stalagmight is an open source project because we believe in transparency,
accessibility, and freedom for users to manipulate their tools. Stalagmight
does not store your data on our servers - everything stays local to your
machine - and the only tracking is opt-in telemetry, meant to help developers
fix issues.

Stalagmight use is meant for certified cave survey divers who
understand that cave surveying is risky, all software has bugs, and
this is meant as an optional informational addition to, but not a
replacement for, cave survey training.

> **Status:** pre-1.0, under active development. The data model, import/export
> pipelines, map editing, and loop-closure adjustment are stable and in daily
> use; some workflows (dive/gas planning, jumps-vs-references) are still landing.
> See [the roadmap](docs/roadmap.md) and the issue tracker for what's in flight.

---

## What it does

- **Import** - Ariane `.dmp` (raw survey, versions 2-5) and `.tml`, Compass
  `.mak`/`.dat` projects, and Walls (experimental).
- **Export** - map images (`.svg`, `.png`, `.pdf`) plus `.tml`, `.csv`, `.json`
- **Map** - survey lines and stations rendered with [MapLibre](https://maplibre.org/)
  over satellite imagery, with snapping, measurement, a distance-gradient overlay,
  and hover/selection highlighting.
- **Edit** - move stations / segments / shots, merge stations, adjust sections,
  edit comments and LRUD, bulk-delete shots - all with hybrid undo/redo.
- **Loop closure** - least-squares loop adjustment to distribute survey error.
- **Collaboration** - an Ariane-compatible collab mode (sibling `.tml`,
  save-both, reconcile/diff). See [docs/collaboration.md](docs/collaboration.md).
- **Safe by default** - atomic saves, auto-save, dirty-state guards, and a
  recent-projects list.

## Tech stack

[Tauri 2](https://tauri.app/) desktop shell with a **Rust** backend
(survey model, parsers, geometry, persistence in SQLite) and a **React 18 +
TypeScript** frontend (MapLibre map, Zustand state, i18n). IPC types are
generated from the Rust types via `ts-rs`.

## Getting started

**Prerequisites:** [Rust](https://rustup.rs/) (stable), Node 22.x, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
platform.

The toolchain is pinned so every machine builds the same versions - pnpm
`9.15.9` (via `packageManager` in `package.json`) and Node `22.x` (via
`.nvmrc`). On a fresh clone:

```bash
corepack enable      # makes `pnpm` honor the pinned version
pnpm install
./scripts/dev.sh     # launches the dev app (handles process cleanup)
```

Production build:

```bash
pnpm tauri build
```

> Telemetry is **off** in normal builds. The `telemetry` Cargo feature (used in
> CI and official releases) additionally requires a `TELEMETRY_ENDPOINT`; you do
> **not** need it to build, run, or contribute. See
> [docs/telemetry.md](docs/telemetry.md).

## Documentation

The `docs/` tree is extensive. Good entry points:

| Document | Contents |
|----------|----------|
| [SPEC.md](docs/SPEC.md) | Full specification - data model, UI, workflows, file formats, validation |
| [architecture.md](docs/architecture.md) | State flow, command pattern, key files, Rust patterns |
| [project-structure.md](docs/project-structure.md) | Directory tree and tech stack |
| [TESTING.md](docs/TESTING.md) | Test tiers and patterns (Rust, Playwright, vitest) |
| [roadmap.md](docs/roadmap.md) | Phases and planned work |

## Contributing

Contributions are welcome - with one important caveat about domain scope (cave
surveying is a specialized field) and some guidance on AI-assisted work. Please
read **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening an issue or PR.

To report a security issue, see **[SECURITY.md](SECURITY.md)**.

## License

Stalagmight is licensed under the **GNU Affero General Public License v3.0 or
later** (AGPL-3.0-or-later). See [LICENSE](LICENSE).

It bundles a locally-patched copy of
[`compass_data`](https://github.com/zheylmun/compass_data) by Zach Heylmun
(MIT OR Apache-2.0) under `src-tauri/vendor/compass_data/`; changes are recorded
in that directory's `MODIFICATIONS.md`. Third-party dependency licenses are
permissive (MIT / Apache-2.0 / BSD / ISC / MPL-2.0) and compatible with the
AGPL.
