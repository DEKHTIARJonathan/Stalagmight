# IPC Type Generation

This project generates TypeScript types for IPC payloads directly from the Rust
backend using `ts-rs`. This keeps the frontend and backend in sync and reduces
manual drift.

## Command

Run the generator from the repo root:

```bash
pnpm gen:ipc-types
```

This runs `src-tauri/examples/gen_ipc_types.rs` (via `--example`) and produces:

> The example is gated behind the `ipc-typegen` cargo feature
> (`required-features` in `src-tauri/Cargo.toml`) so plain `cargo build` /
> `cargo build --release` skip it - it's dev-only tooling and was paying its
> own full LTO pass in release builds. `pnpm gen:ipc-types` enables the
> feature automatically; it is the only supported way to run the generator.

- `src/types/ipc.generated.ts` (re-exports for all generated IPC types)
- `src/types/ipc/*.ts` (one file per exported Rust type)

The exported types live across the workspace member crates
(`src-tauri/crates/*`) as well as the app crate; the generator collects them
all, and `flatten_import_paths` rewrites the ts-rs-emitted relative import
specifiers so the flat `src/types/ipc/` output stays internally consistent no
matter which crate a type came from.

## The second tree: `src-tauri/bindings/`

There is a *second* committed tree of generated TypeScript, and `pnpm gen:ipc-types`
does not write it. The generator hardcodes its output directory to
`../src/types/ipc` (`gen_ipc_types.rs`), so it never touches `src-tauri/bindings/`.

That tree is a side effect of **`cargo test --workspace`**. Every
`#[ts(export)]` derive makes ts-rs emit an `export_bindings_*` unit test whose
body writes the type's `.ts` file. ts-rs's default output directory is
`<crate>/bindings/` - which, after the workspace split, would scatter the tree
across `src-tauri/crates/*/bindings/`. So the rule is: every exported type in
a member crate carries `#[ts(export, export_to = "../../bindings/")]`, which
resolves from `crates/<member>/` back to the single `src-tauri/bindings/`
tree, and running the workspace tests rewrites every file in it. The **app
crate hosts no bindings-defaulted exports** - keep it that way, so every
writer of the committed tree follows the one explicit `export_to` convention.
Its only ts exports are the two types in `commands/memory.rs`, which opt out
with `#[ts(export, export_to = "../../src/types/ipc/")]` and land in the
frontend tree instead.

**Nothing consumes it.** No module in `src/`, `e2e-playwright/`, `e2e/` or
`scripts/` imports from it, and it is in no tsconfig's `include` (see
[testing-recipes.md](testing-recipes.md#typecheck)). It exists because ts-rs
generates it by default, not because anything reads it.

Because nothing reads it, nothing used to notice it going stale - it was easy to
hand-edit or hand-delete a file there while renaming a type and have CI stay
green. The `check` job now runs a **ts-rs bindings tree matches the checkout**
step immediately after `cargo test --workspace`, which fails if that tree has any
modified or untracked file. Treat the tree exactly like `src/types/ipc/`: never hand-edit it;
run the Rust tests and commit whatever they produce.

One gap the step cannot close: ts-rs only *writes* files, it never deletes them,
so a `.ts` left behind after its Rust type is deleted leaves the worktree clean
and passes. That orphan is inert (nothing imports it), but it does mean the tree
can accumulate dead files - delete them by hand when you remove a type.

## Automation Policy

These IPC types are **always generated**, never written by hand:

- Do not create or edit files under `src/types/ipc/`.
- Do not edit `src/types/ipc.generated.ts`.
- Do not create or edit files under `src-tauri/bindings/` either - it is generated
  by `cargo test --workspace`, not by `pnpm gen:ipc-types` (see above), and CI now
  fails on any drift there.
- If a type changes, update the Rust source + export list, run `pnpm gen:ipc-types`,
  and commit the regenerated output.

## Adding a New IPC Type

1. Add `#[derive(TS)]` to the Rust type definition.
2. If the type lives in a workspace member crate (`src-tauri/crates/*` - the
   normal case), export it with
   `#[ts(export, export_to = "../../bindings/")]` so its bindings file lands
   in the shared `src-tauri/bindings/` tree. Do not add bindings-defaulted
   (bare `#[ts(export)]`) types to the app crate.
3. If the type uses `#[serde(rename_all = "...")]`, add the matching
   `#[ts(rename_all = "...")]` so the TS output matches JSON.
4. For non-JSON-friendly fields (e.g., `PathBuf`, `DateTime`), add
   field-level overrides like `#[ts(type = "string")]`.
5. Add the type to the export list in `src-tauri/examples/gen_ipc_types.rs`.
6. Re-run `pnpm gen:ipc-types` and commit the updated generated files.

## Notes

- Generated files are committed to the repo for CI and editor support.
- Do not edit `src/types/ipc.generated.ts` or files under `src/types/ipc/`
  by hand; regenerate instead.
