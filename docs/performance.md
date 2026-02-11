# Performance

This document covers key algorithmic decisions in the Rust backend and their
performance characteristics.

## Loop Closure Adjustment — Sparse PCG Solver

**File:** `src-tauri/src/models/project.rs`, `adjust_least_squares()`

The loop closure adjustment solves a weighted least-squares system to distribute
survey errors across the network. The normal equations form a weighted graph
Laplacian matrix — each edge (shot) contributes a constraint between two station
groups, with weights derived from measurement uncertainties (sigma for length and
azimuth, scaled by section quality).

### Problem structure

The normal matrix A^T A is:
- **Symmetric positive-definite** (graph Laplacian)
- **Extremely sparse** — at most ~3 non-zeros per row (each station group
  connects to a small number of neighbors via shots)
- **Dimension n** = number of unknown station groups (groups connected via
  merges and aligned closures)

X and Y axes are solved independently since they have different per-shot weights
(the azimuth orientation affects directional uncertainty differently).

### Algorithm: Jacobi-preconditioned Conjugate Gradient

Instead of assembling a dense n×n matrix and using LU decomposition (O(n³)), the
solver uses a sparse representation and iterative Conjugate Gradient:

1. **Sparse assembly:** diagonal entries in `diag_x[i]` / `diag_y[i]`,
   off-diagonal entries in adjacency list `adj[i] = [(j, w_x, w_y), ...]`.
   A `macro_rules! add_sparse!` macro handles the fixed/unknown group indexing
   to avoid borrow issues with mutable arrays.

2. **Sparse matrix-vector product** (`spmv`): iterates diagonal + adjacency
   list — O(nnz) per call.

3. **Jacobi preconditioner:** M = diag(A), trivially inverted. Good enough for
   graph Laplacians where the diagonal dominance ensures fast convergence.

4. **CG iteration:** converges in O(diameter) iterations for graph Laplacians,
   which is typically much less than n.

**Complexity:** O(nnz × iterations) ≈ O(n × diameter), vs O(n³) for dense LU.

**Tolerance:** 1e-12 relative residual norm, max 10,000 iterations.

### Why not a direct sparse solver?

A sparse Cholesky (LDL^T) factorization would also work and give exact results
in one pass. However:
- It requires a sparse matrix library (e.g., `sprs`, `cholmod` bindings) — an
  extra dependency.
- The graph Laplacian structure makes CG converge extremely fast (typically
  under 50 iterations for survey networks), so the iterative approach is both
  simpler and fast enough.
- The PCG implementation is ~50 lines of pure Rust with no dependencies beyond
  `std`.

### Profiling results

On a project with ~500 sections (~10,000 stations):
- **Before (dense LU):** `adjust_least_squares` consumed 96.78% of CPU for
  multiple minutes. The inner loop was a Gaussian elimination kernel
  (movsd/mulsd/subsd) operating on a dense n×n matrix.
- **After (sparse PCG):** `adjust_least_squares` dropped to 5.14% of CPU. The
  hotspots shifted to normal app activity (image resizing, tile rendering).

## Frozen Shot Detection — Tarjan's Bridge-Finding

**File:** `src-tauri/src/models/project.rs`, `compute_frozen_shots()`

A shot is "frozen" (its geometry cannot be edited) when removing it would not
disconnect any zero datum station from the rest of the network. Equivalently: a
shot is frozen when both its endpoints can reach a zero datum via alternative
paths (shots, merges, and aligned closures) that don't include the shot itself.

### Why this matters for performance

`compute_frozen_shots()` is called on every `get_project_state()` IPC call,
including after every undo/redo operation. It must be fast.

### Previous approach: per-shot BFS

The original `is_shot_frozen()` ran two BFS traversals per shot — one from each
endpoint — to check if both sides can still reach a datum station when the shot
is excluded. With S shots and V stations:

**Complexity:** O(S × V) — for 500 sections with ~20 shots each, this means
~20,000 BFS operations, each visiting up to V stations.

### Current approach: Tarjan's bridge detection

The key insight is that frozen/non-frozen status is determined by the graph's
**bridge** structure:

- **Non-bridge shot** in a component with ≥1 datum: **frozen**. Removing a
  non-bridge edge doesn't disconnect the graph, so both endpoints can still
  reach the datum.
- **Bridge shot**: **frozen only if both sides have datums**. Removing a bridge
  splits the component into two parts; both parts must independently contain a
  datum for both endpoints to be anchored.
- **Any shot** in a component with 0 datums: **not frozen**.

The algorithm:

1. **Index stations** into compact integers for array-based access.
2. **Build adjacency list** with edge metadata (is_shot, section_id, shot_index)
   from shots, merges, and aligned closures.
3. **Iterative Tarjan's DFS** (avoids stack overflow on large graphs):
   - Computes discovery times (`disc`) and low-link values (`low`)
   - An edge parent→child is a bridge iff `low[child] > disc[parent]`
   - Simultaneously counts datums in each DFS subtree (`subtree_datums`)
   - Tracks total datums per connected component (`component_datums`)
4. **Classify each shot:**
   - Look up whether the shot's edge is a bridge
   - Non-bridge + component has datums → frozen
   - Bridge + both sides have datums → frozen
   - Otherwise → not frozen

**Complexity:** O(V + E) — a single DFS pass over the entire graph.

### Multigraph note

The DFS uses a `parent_edge_skipped` flag to correctly handle the first back-
edge to the DFS parent (skip it as the tree edge) vs subsequent edges (treat as
back edges that prevent bridging). However, in practice the survey graph is a
**simple graph**: shots connect consecutive intra-section stations, merges
connect inter-section stations, and closures connect non-adjacent stations.
No two edge types can create parallel edges between the same station pair, so
the multigraph handling is purely defensive.

### Profiling results

On a project with ~500 sections, undo operations that previously stalled due to
`compute_frozen_shots()` dominating CPU no longer show the function in profiling
hotspots.

## Profiling Guide

### Build for profiling

The project has a `[profile.profiling]` in `Cargo.toml` that inherits from
release with debug symbols preserved:

```toml
[profile.profiling]
inherits = "release"
strip = false
debug = 1
```

Build with:
```bash
cargo build --profile profiling --manifest-path src-tauri/Cargo.toml
```

The binary is at `~/.cargo_build/profiling/stalagmight`.

### Recording with perf

```bash
# Start the app
WEBKIT_DISABLE_DMABUF_RENDERER=1 /path/to/profiling/stalagmight &

# Record (replace PID and duration)
perf record -g -p <PID> -o /tmp/perf.data -- sleep 15

# Or with DWARF call graphs for better stack traces
perf record -g --call-graph dwarf -p <PID> -o /tmp/perf.data -- sleep 120
```

### Analyzing

```bash
# Top functions by overhead
perf report -i /tmp/perf.data --no-children --percent-limit 1

# Source annotation for a specific function
perf annotate -i /tmp/perf.data --symbol=<function_name>
```

### Debug build caveat

Never profile a debug build for performance analysis. `nalgebra` and other
numerical code runs 20-50x slower without optimizations due to bounds checks
and lack of inlining/SIMD. Always use the `profiling` profile.
