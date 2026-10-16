# OM2-Editor — Progress log

See `AUDIT.md` for the full defect list and root-cause evidence.

## Session 2026-10-16 (audit + large-map stability, part 1)

### Files changed
- `src/util/async.ts` — **new**: `runPool()` bounded worker pool (+`onIdle`).
- `src/viewport/viewport.ts` — bounded asset loading (D1); incremental
  object/spline updates instead of full rebuild on edit (D2); reverse indexes
  `objInstances` / `splineObjects`; `updateObjectInstance` / `updateSplineMesh`
  / `disposeObject3D`; progress reporting in `loadModels`.
- `AUDIT.md`, `PROGRESS.md` — **new**.

### Root causes confirmed
- **D1** large-map crash = unbounded `Promise.all` over 889 unique models ×
  ~50 file reads each → I/O flood. (Fixed.)
- **D2** edit stutter = full `build()` (all instances + 329 terrains + 2,486
  splines) on every edit. (Fixed for move/rotate/drag/field.)
- **D3** scrambled junction/addon meshes = v5 material-chunk layout differs from
  parser assumption → `validMaterialsAt` rejects correct triangle combo →
  fallback to wrong combo. Byte-level evidence in `AUDIT.md`. (Not yet fixed.)

### Build results
- `npm run build` (tsc --noEmit + vite): **clean** after each change.

### Tests executed (actual results)
- Baseline measured from disk (read-only): Grundorf 19/1106/60, Berlin-Spandau
  369/30310/2486 — recorded in `AUDIT.md`.
- o3d sweep: 7,998/8,000 Sceneryobjects parse without error.
- Grundorf in dev viewport: loads (110/110 models), renders buildings/roads/
  trees correctly, select + drag + field edit work, **no runtime errors** (only
  benign texture 404s).
- Berlin-Spandau 60-tile slice (10,366 objects / 692 splines): loads to 545/550
  models **without crash/freeze** — demonstrates D1 fix. One scrambled junction
  mesh visible (D3, expected).

### Known limitations / remaining failures
- D3 scrambled junction/`*_base`/`*_hole`/addon meshes still render wrong.
- D4 no culling → full 369-tile Berlin-Spandau not yet validated for smooth
  framerate (only loaded in slices so far).
- Count-changing edits (delete/duplicate/place) still full-rebuild.
- `rotX`/`rotY` not applied at render; texture 404 probing noise; 40 missing
  Berlin-Spandau `.map` tiles silently empty.

### Next highest-priority tasks (in order)
1. **D3** — reverse-engineer v5 material-chunk variant; make combo selection
   validate against the *next chunk tag* (not strict material layout); prefer
   uint32 counts for version byte 5. Add geometry-quality regression test over a
   file-list fixture (hedgehog / vertical-outlier metric).
2. **D4** — per-tile frustum culling + correct instanced bounds; evaluate
   chunked/off-thread scene build; then validate full 369-tile Berlin-Spandau and
   record frame-time metrics.
3. Incremental delete/duplicate/place (avoid full rebuild).
4. Load summary + diagnostics (missing tiles, failed models/textures) — no map
   mutation; honor rules 8/10/20.
5. Automated test harness (parser/coordinate/asset/scene/save) per Part 9.
6. Secondary: `rotX`/`rotY` at render; texture directory index to kill 404
   probing; cache eviction.
