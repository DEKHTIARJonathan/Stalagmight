# Local modifications

This is a vendored copy of [`wry`](https://github.com/tauri-apps/wry) v0.53.5 by
the Tauri Programme, used under its MIT OR Apache-2.0 license (see
`LICENSE-MIT` / `LICENSE-APACHE`). It is embedded in Stalagmight via
`[patch.crates-io]` in `src-tauri/Cargo.toml` so we can carry one small fix the
upstream release lacks.

## Why

On Linux (webkitgtk), the WebKit web process (`WebKitWebProcess`) grows its RSS
well past its live memory and, absent memory pressure, never returns freed pages
to the OS. With a large project open we measured 3.8-5.4 GB RSS against roughly
450-700 MB live. WebKit already knows how to reclaim this: its
`MemoryPressureHandler` releases caches and runs `malloc_trim`-style compaction
when it thinks memory is tight. It just never fires on a normal desktop because
nothing signals pressure. `WebKitMemoryPressureSettings` lets us give the web
process an explicit soft budget so the handler fires on our terms (GC-style
pauses of tens of ms), with no kernel cgroup throttling.

## Change from upstream v0.53.5

Only `src/webkitgtk/web_context.rs` is modified. Two additions, both clearly
marked with `STALAGMIGHT LOCAL MODIFICATION` comments:

- A free function `stalagmight_memory_pressure_settings()` that builds a
  `webkit2gtk::MemoryPressureSettings` from `STALAGMIGHT_WEBKIT_MEM_*`
  environment variables, returning `None` (upstream behavior) when
  `STALAGMIGHT_WEBKIT_MEM_LIMIT_MB` is unset, empty, or `0`.
- A single call site inside `WebContextImpl::new` that, when the function
  returns settings, applies them to the `WebContext` builder via
  `.memory_pressure_settings(&settings)` before `.build()`.

`memory-pressure-settings` is a **construct-only** GObject property on
`WebKitWebContext`, read when the web process is spawned, so it can only be set
at builder time. wry creates the `WebContext` internally (Tauri calls
`WebContext::new`), so there is no public hook to set it from the application;
patching this constructor is the least-invasive option. Stalagmight sets the
environment variables (Linux only, default on) in `src-tauri/src/lib.rs`
`run()` before the Tauri builder starts.

Environment variables (see the doc comment on the function):

| Variable | Type | Default | Meaning |
|----------|------|---------|---------|
| `STALAGMIGHT_WEBKIT_MEM_LIMIT_MB` | u32 | (off) | Memory limit in MB. Unset/0 disables the feature. |
| `STALAGMIGHT_WEBKIT_MEM_CONSERVATIVE` | f64 | 0.33 | Fraction of the limit for the first, gentle release. |
| `STALAGMIGHT_WEBKIT_MEM_STRICT` | f64 | 0.5 | Fraction for the aggressive, synchronous release. |
| `STALAGMIGHT_WEBKIT_MEM_KILL` | f64 | 0.0 | Fraction at which the web process is killed. 0 = never. |
| `STALAGMIGHT_WEBKIT_MEM_POLL` | f64 (s) | 3.0 | Poll interval for the pressure handler. |

With the variables unset, the function returns `None` and this copy behaves
byte-for-byte like upstream wry 0.53.5 (verify with a diff against the crates.io
source for that version).
