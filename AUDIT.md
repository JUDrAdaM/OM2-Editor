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

### D3 — o3d v5 empty-material chunk + ignored transform matrix → scrambled/misplaced meshes  — FIXED
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

### D6 — Oversized / inflated-bbox meshes (e.g. `Kreuz_*_See` junctions)  — NEW, NOT YET FIXED
- **Where:** some large o3d render as a spike/blob. Example
  `Kreuz_Klost_Wilh_See.o3d`: parses cleanly (`fb=false`, identity matrix,
  0% hedgehog) yet vertices span a **±170m cube in all three axes** including
  vertical (z −172..166); 50% of verts are >80m from the median.
- **Distinct from D3** (not a material-chunk/fallback case; predates the D3 fix).
- **Scope:** a sweep for min-dimension >40m found 64/8000, but **most are
  legitimate** large structures (high-rises `bw_hoch_*`, quarry `kamenolom`
  347×83×302, bridge `mostm` 504×75×291). Only extreme cubic cases like
  `Kreuz_*_See` look wrong. No reliable automatic separator yet.
- **Next step:** determine whether these o3d use a sub-mesh/scale/second-chunk
  layout the parser mishandles, or are genuinely authored large; compare a
  `Kreuz_*_See` against a visually-correct large junction. Do **not** mask with a
  size heuristic (would hide legitimate towers/bridges).

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
