# Repository Guidelines

## Project Structure & Module Organization
- `src/`: React + TypeScript frontend. Core UI lives in `src/components/`, state in `src/store/`, hooks in `src/hooks/`, and shared helpers in `src/utils/`.
- `src-tauri/`: Rust backend and Tauri setup. Core business logic is in `src-tauri/src/core/`, data models in `src-tauri/src/models/`, and persistence in `src-tauri/src/persistence/`.
- `src-tauri/tests/`: Rust integration tests.
- `prd/`, `SPEC.md`, `TODO.md`: product specs and roadmap notes.
- `dist/`: Vite build output (generated).

## Build, Test, and Development Commands
- `pnpm install`: install frontend dependencies.
- `pnpm tauri dev`: run the full desktop app in dev mode.
- `pnpm tauri build`: produce a production desktop build.
- `pnpm dev`: run the Vite frontend only.
- `pnpm build`: typecheck + Vite build for frontend.
- `pnpm typecheck`: TypeScript type checks only.
- `pnpm test`: run Vitest (frontend tests).
- `cd src-tauri && cargo test`: run Rust integration tests.

## Coding Style & Naming Conventions
- TypeScript uses 2-space indentation and single quotes; follow existing component and store patterns.
- Prefer descriptive component names (`SingleSystemView`, `SurveyLayer`) and directory-based grouping.
- Rust follows standard `rustfmt` conventions; keep modules aligned with existing folders (`core/`, `models/`, `persistence/`).

## Testing Guidelines
- Rust tests live in `src-tauri/tests/` (see `integration_tests.rs`).
- Frontend tests use Vitest; use `*.test.ts` or `*.test.tsx` when adding new specs.
- Keep tests focused on business logic and command behavior before UI snapshots.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and title-cased (e.g., "Add PDF export support").
- PRs should include a clear description, linked issues (if any), and test results.
- For UI changes, include before/after screenshots or a short screen recording.

## Configuration & Logs
- Config file: `~/.config/cavechef/config.toml`; defaults in `src-tauri/src/config/defaults.rs`.
- Logs: `~/.local/share/cavechef/logs/`.
