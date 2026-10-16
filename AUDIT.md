# OM2-Editor — Audit

Living audit of verified defects, root causes, and fixes. Confirmed defects are
separated from hypotheses. Updated per working session; see `PROGRESS.md` for
the running log and next actions.

## Architecture (as inspected)

| Concern | Location |
|---|---|
| Language / build | TypeScript + Vite; desktop shell Electron (`electron/main.cjs`, `preload.cjs`) |
| Renderer | Three.js (WebGL) — `src/viewport/viewport.ts` |
| Entry / UI | `src/main.ts` (shell) → `src/ui/menu.ts` (start menu) / `src/ui/app.ts` (editor) |
| Map parse / model | `src/omsi/{parser,map,types,terrain}.ts` (round-trip: `tile.sections` is source of truth) |
| Mesh / assets | `src/omsi/{o3d,xmesh,sco,sli}.ts`, `src/viewport/{models,splines}.ts` |
| Asset I/O | `src/fs/loader.ts` → Electron IPC `readAsset` / Vite `/omsi/` dev middleware |
| Scene build | `Viewport.build()` — groups objects into `InstancedMesh` by `.sco` path |

## Baseline (measured 2026-10-16, read-only from disk)

| Map | Tiles | Objects | Splines | Unique .sco | Unique .sli | Terrain verts | Parse (node) |
|---|---|---|---|---|---|---|---|
| Grundorf | 19 | 1,106 | 60 | 110 | 8 | 70,699 | 18 ms |
| Berlin-Spandau | 369 (40 `.map` missing) | 30,310 | 2,486 | 889 | 135 | 1,224,209 | 230 ms |

Berlin-Spandau matches the owner's reported reference (~369 tiles / 30,310 objects / 2,486 splines).

---

## Confirmed defects

### D1 — Unbounded concurrent asset loading → freeze/crash on large maps  — FIXED
- **Where:** `Viewport.loadModels()` / `loadSplines()` (`src/viewport/viewport.ts`).
- **Root cause:** `Promise.all(list.map(...))` over every unique model (889 on
  Berlin-Spandau). Each `loadModel` does up to ~50 sequential file reads (o3d
  candidates + up to 9 texture candidates per material). Firing all 889 at once
  → tens of thousands of concurrent fetch/IPC calls → I/O saturation + memory
  spike → freeze/crash before first frame.
- **Severity:** Critical (reported crashes/freezing).
- **Fix:** Bounded worker pool `runPool()` (`src/util/async.ts`), concurrency 24,
  cancellation-aware, with progress reporting. A concurrency bound, **not** an
  object/tile cap — every asset still loads.
- **Verification:** Berlin-Spandau 60-tile slice (10,366 objects / 692 splines /
  550 unique models) now loads to completion (545/550 models) without crashing;
  Grundorf unchanged. Full 369-tile smooth render still needs D4 (culling).

### D2 — Full scene rebuild on every edit → multi-second stutter per edit  — FIXED
- **Where:** `Viewport.build()` called from `setSelectedObjectField`,
  `setSelectedSplineField`, drag release (`onPointerUp`), `rotateSelected`.
- **Root cause:** `build()` tears down and recreates **all** instanced meshes +
  329 terrain meshes + 2,486 spline geometries on every single edit. Moving one
  object rebuilt the entire 30k-object scene.
- **Severity:** High (stuttering while editing large maps).
- **Fix:** Reverse indexes (`objInstances`, `splineObjects`) populated in
  `build()`; `updateObjectInstance()` rewrites a single instance matrix,
  `updateSplineMesh()` rebuilds a single spline mesh. Move/rotate/drag/field-edit
  are now O(1)/O(one spline). Count-changing ops (delete/duplicate/place) still
  full-rebuild — see T-next.
- **Verification:** Grundorf — select + drag + numeric field edit work with no
  full rebuild and no console errors.

### D7 — o3d v4+ per-vertex scrambling not undone → wrong geometry everywhere (root cause of D3/D6)  — FIXED
- **What it is:** OMSI `.o3d` files of version ≥ 4 carry a `key` (bytes 4–7) and,
  unless it is `0xFFFFFFFF`, **obfuscate every vertex**: per-vertex position-axis
  swaps, normal negations and UV tweaks, driven by a state seeded from the key
  and mixed with each vertex's own data. The previous parser read vertices **raw**
  (and only guessed chunk widths), so near-symmetric meshes (most buildings)
  looked roughly right while asymmetric ones (crossing plates) came out as a
  "cube"/spike. This is the real root cause behind D3 and D6.
- **Fix (`src/omsi/o3d.ts`, full rewrite):** deterministic port of openOMSI's
  `omsi-o3d` parser — magic `84 19`, version/flags/key header, count widths from
  the version (no probing), `0x49/0x26/0x79/0x54` chunks, the `0x79` transform,
  and the exact `unscramble(state, …)` per vertex (`fracByte` mixing). Replaces
  all the old heuristics (combo probing, `validMaterialsAt`, the empty-material
  special-case, ASCII texture scraping).
- **Verification (fixed-parser replica):** Sceneryobjects **8,997/9,000 parse**;
  **5,849** meshes now correctly flat; remaining large near-cubes drop to **8 —
  all genuine towers** (`Spiegelturm`, `Plattenbau_*`, 3dstudio houses). Vehicles
  (v7) **2,500/2,500** parse (old parser failed 8). `Kreuz_Klost_Wilh_See`:
  340 m cube → **341 × 0.2 × 93 m flat plate**; `Haus01a` → a correct 9.4×10.2×
  12.3 m house. Grundorf & Berlin-Spandau render correctly (detailed buildings,
  flat crossings, no spikes); no runtime errors.
- **Supersedes:** D3's empty-material/matrix fix (now subsumed by the correct
  deterministic parser) and D6's crossing suppression (removed — crossings are
  real flat plates now). Full crossing *height* deformation (`warp_crossings`:
  raise each vertex by `[crossing_heightdeformation]`'s field so arms meet their
  roads) remains a later refinement; the flat plate already renders correctly.

### D3 — o3d v5 empty-material chunk + ignored transform matrix (SUBSUMED BY D7)  — FIXED
- **Where:** `parseO3D` / `validMaterialsAt` / `readMaterials` (`src/omsi/o3d.ts`).
- **Root cause (byte-level evidence, `Einm_CharlCh_Stendel_base.o3d`):** two bugs.
  1. The material chunk after `0x26` legitimately had **count 0** (textures come
     from the `.sco` `[matl]`), immediately followed by a `0x79` matrix chunk
     (`26 00 00 79 …`). `validMaterialsAt` required `count >= 1`, so it rejected
     the *correct* triangle combo `[4,8]` and fell back to `[2,8]` → triangle
     start shifted 2 bytes → scrambled geometry.
  2. The `0x79` chunk is a **4×4 transform matrix** (row-major DirectX) that
     positions the mesh. It was never read/applied. Identity for most meshes
     (safe to have ignored) but non-identity for junction `*_base`/`*_hole`
     pieces (e.g. translation 52,50 / −70,47), so those were misplaced.
- **Fix:** `validMaterialsAt` accepts `count == 0` when the next byte is `0x79`
  or EOF (keeps combo disambiguation strong). `readMaterials` returns its end
  offset; `readMatrixAt` reads the `0x79` matrix and `applyMatrixToPositions`
  applies non-identity matrices to vertices in `parseO3D`.
- **Verification (fixed-parser replica over all Sceneryobjects):** fallback-combo
  cases **35 → 10**; `Einm_CharlCh_Stendel_base` hedgehog **23% → 6%** (now
  `fb=false`); **3,471** meshes have non-identity matrices now applied. Grundorf
  renders unchanged (no scatter → matrix convention correct). Removing the old
  `looksCubeScrambled` box fallback earlier exposed these; now fixed at the root.

### D6 — Crossing "spikes" (RESOLVED BY D7: was raw per-vertex scramble, not a separate format)  — FIXED
- **What it is (investigation conclusion):** objects like `Kreuz_Klost_Wilh_See`
  are OMSI **intelligent crossings** (Kreuzungen) / platforms. The o3d parses
  **byte-perfectly** (verified: raw float decode matches, single mesh chunk,
  identity `0x79` matrix, unit normals, valid UVs, coherent indices — avg
  adjacent-index gap 3.4). It is **not** a parser bug and is distinct from D3.
  The `.sco` has `[rendertype] surface` + traffic-light phases; the mesh is a
  large **template** (vertices span ~±160m) that OMSI **deforms at runtime** to
  fit the connected roads. Rendered statically it is a giant spike.
- **Proper fix:** implement OMSI's crossing-deformation (morph template to the
  attached splines) — a large separate feature (queued).
- **Interim fix (`src/omsi/sco.ts` + `src/viewport/models.ts`):** parse
  `[rendertype]`; skip a mesh when `rendertype == "surface"` **and** its bbox is
  an implausibly large near-cube (every axis > 120 m, max/min < 1.6). The object
  stays in the map/tree and renders as a small placeholder box (via the existing
  fallback); a `console.warn` names each skipped mesh. No map data is modified.
- **Verification (correlation sweep over 13,080 `.sco`):** the dual-gate catches
  **35** meshes — **all** in `Kreuz_MC` / `Kreuz_RUE` / `Railroad_RUE`
  (`Kreuz_*`, `Einm_*`, `Checkpoint_*`, `Extra_*`, `Falkensee_Bahnsteig`), i.e.
  exactly the crossing/platform templates. **Zero** legitimate objects caught;
  **zero** large non-cube surface objects missed (so towers `bw_hoch_*`, bridge
  `mostm` 504×75×291, quarry `kamenolom`, hall `bw_hall_grey_1` are untouched).
  Berlin-Spandau 60-tile slice: spike gone, scene clean, warnings logged.

### D4 — No frustum culling / no visibility management  — NOT YET FIXED
- **Where:** `src/viewport/viewport.ts` — `inst.frustumCulled = false`; no spatial
  index, no LOD, all tiles' terrain + objects always in scene.
- **Root cause:** Every instanced mesh, 329 terrain meshes (1.22M verts), and
  2,486 spline meshes are always submitted regardless of camera.
- **Severity:** High for very large maps (frame-rate / GPU memory at 369 tiles).
- **Next step:** Per-tile culling (bounding spheres), re-enable frustum culling
  with correct per-instance bounds, consider off-thread/chunked scene build.

### D5 — Silent data gaps; arbitrary dev tile cap  — PARTIALLY ADDRESSED
- `loadMapFromOmsiDev(maxTiles=25)` caps tiles in the browser dev path — an
  arbitrary limit (violates project rule 7). Acceptable only as a dev-preview
  convenience; the Electron menu path (`openMapByFolder`) loads all tiles.
- 40 `.map` files referenced by Berlin-Spandau's `global.cfg` are missing on
  disk and become silent empty tiles (`buildMap`: `tileTexts.get ?? ""`). Should
  be reported, not silently dropped (rule 8).
- **Next step:** Replace the dev cap with real culling/progressive load; surface
  missing-tile and failed-model counts in a load summary / diagnostics panel.

## Secondary findings (hypotheses / lower severity)

- **Object pitch/bank ignored:** `setObjMatrix` applies only `rotZ`; parsed
  `rotX`/`rotY` are dropped at render. Wrong orientation for tilted objects.
- **Texture candidate probing:** `textureCandidates` tries up to 9 paths/texture;
  misses log 404s (hundreds per large map). Textures do load, but it's noisy and
  wasteful — add a per-directory file index / negative cache.
- **Unbounded caches:** `ModelCache`/`SplineCache` and `loadedModels`/
  `loadedSplines` grow without eviction (bounded by unique-path count).
- **Terrain cost:** full-resolution mesh per tile, recomputed normals, rebuilt by
  any full `build()`.
- **sco LOD selection:** `parseSco` keeps the max-LOD group; verify this is the
  full-detail set for objects whose meshes are all under `[LOD]` markers.

## Already fixed earlier this session (pre-audit)
- Cube-shaped buildings rendered as blank boxes — removed stale
  `looksCubeScrambled`/`makeBoxMesh` fallback; parser verified on 7,998/8,000
  Sceneryobjects o3d (0 parse errors). See git history.
