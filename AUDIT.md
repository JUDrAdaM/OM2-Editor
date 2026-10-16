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

### D3 — o3d v5 material-chunk variant → wrong triangle combo → scrambled meshes  — ROOT-CAUSED, NOT YET FIXED
- **Where:** `parseO3D` combo selection + `validMaterialsAt`/`readMaterials` (`src/omsi/o3d.ts`).
- **Root cause (byte-level evidence, `Einm_CharlCh_Stendel_base.o3d`):** vertices
  (V=44, uint32 count) and triangles (T=22, stride 8, uint32 count) parse
  correctly and the material tag `0x26` sits exactly at the computed end
  (offset `0x642`). But the bytes after `0x26` are **not** the assumed
  `uint16 count + 11 floats + name` layout — the "count" reads 0 and the diffuse
  floats read as garbage (the data is matrix-like). So `validMaterialsAt` rejects
  the *correct* combo `[4,8]`; the parser falls back to `[2,8]` (uint16 count) →
  triangle start shifted 2 bytes → scrambled geometry. Affects road junctions
  (`Einm_*`, `Wende_*`), `*_base`/`*_hole`, and some addon meshes.
- **Related:** Removing the old `looksCubeScrambled` box fallback (correctly —
  it false-positived on square buildings, see git history) exposed these
  genuinely-wrong meshes as spiky geometry instead of blank boxes.
- **Severity:** Medium (minority of objects; buildings/most scenery correct).
- **Next step:** Reverse-engineer the v5 material-chunk layout for these files
  (compare `0x26` payload vs known-good `Haus01a.o3d`; the differing chunk looks
  like a 4×4 matrix / `0x79`). Make combo selection robust (prefer uint32 counts
  for version byte == 5; validate end-of-triangles against the *next tag* rather
  than a strict material-layout check). Add a geometry-quality regression test.

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
