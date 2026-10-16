# OM2-Editor — Progress log

See `AUDIT.md` for the full defect list and root-cause evidence.

## Session 2026-10-16 (D7 — o3d per-vertex unscramble; root cause of D3/D6)

### What was really wrong
- OMSI `.o3d` v4+ obfuscate every vertex (key-seeded per-vertex axis swaps +
  normal flips + UV tweaks). The old parser read vertices raw and guessed chunk
  widths, so asymmetric meshes (crossing plates) became "cubes"/spikes and all
  buildings were subtly wrong. Found via the openOMSI (Rust) reimplementation.

### Files changed
- `src/omsi/o3d.ts` — full rewrite: deterministic port of openOMSI's `omsi-o3d`
  (header/version/flags/key, fixed count widths, `0x17/0x49/0x26/0x79/0x54`
  chunks, exact `unscramble`/`fracByte`, transform). Removed all heuristics.
- `src/viewport/models.ts` — removed the crossing-suppression workaround
  (crossings now render as correct flat plates).
- `src/omsi/sco.ts` — reverted the now-unneeded `[rendertype]` parsing.
- `AUDIT.md` — added D7 (supersedes D3/D6).

### Build: clean.

### Tests executed (actual results)
- Fixed-parser replica over 9,000 Sceneryobjects o3d: 8,997 parse; 5,849 now
  flat; remaining large near-cubes drop to 8 — all genuine towers. Vehicles (v7)
  2,500/2,500 (old parser failed 8). `Kreuz_Klost_Wilh_See` 340 m cube →
  341×0.2×93 m flat plate; `Haus01a` → correct 9.4×10.2×12.3 m house.
- Grundorf viewport: detailed correctly-sized buildings, flat crossings, no
  spikes/boxes; 110/110 models; no runtime errors.
- Berlin-Spandau 60-tile slice: 545/550 models, city renders correctly, the
  former giant spike is now a flat crossing surface.

### Known limitations / next
- Crossings render as flat plates but are not yet height-warped to meet their
  roads precisely (openOMSI `warp_crossings`: add `[crossing_heightdeformation]`
  field per vertex) — a later refinement.
- D4 (culling for full large maps) still pending.

---

## Session 2026-10-16 (D6b — crossing deformation attempt)

Goal: render crossings correctly instead of the placeholder box.

### Investigation
- Web research: crossings use `[crossing_heightdeformation]` ("folds the base
  tarpaulin along its paths") + `[path]`/`[splinehelper]` connection data; the
  exact field semantics and algorithm are undocumented (openOMSI has a port).
- Real data (`Kreuz_Klost_Wilh_See.sco`): 6 `[splinehelper]` + 13 `[path]`
  blocks. Splinehelper connection points are at ±165 (e.g. X=164.9, Z=−4.1) —
  the **same space as the mesh** — with heights ~0; path points similar. So the
  template's horizontal footprint is large and its ±160 m vertical is the
  undeformed "tarpaulin" to be folded.
- The object itself is placed correctly by our map parsing (box appears in the
  right spot); only the mesh shape/size is template-space.

### Attempt (and result)
- Tried a height-flatten approximation (collapse up-axis to ground) and rendered
  Berlin-Spandau. It removed the spike but produced **messy geometry** (collapsed
  central vertices → overlapping degenerate triangles) and its horizontal
  footprint / terrain fit are **unverifiable** without the real deformation.
- Per rules 3/10/12/18 (no unverifiable simplified geometry), **reverted** to the
  clean, verified suppression. Kept a clarifying code comment.

### Conclusion / next step
- Correct crossing rendering requires implementing OMSI's crossing-deformation
  (parse `[path]`/`[crossing_heightdeformation]`, resolve connected roads from the
  map, morph the template) — a substantial feature, best ported from openOMSI.
  Not safely implementable by guessing. Crossings keep the placeholder for now.

### Build: clean.

---

## Session 2026-10-16 (D6 — intelligent-crossing template spikes)

### Files changed
- `src/omsi/sco.ts` — parse `[rendertype]` into `ScoInfo.rendertype`.
- `src/viewport/models.ts` — `isDeformedCrossingTemplate` + `meshDims`; skip a
  surface-type mesh whose bbox is a large near-cube (>120m, ratio <1.6); warn.
- `AUDIT.md` — D6 updated to FIXED (interim) with full investigation + evidence.

### Root cause confirmed
- `Kreuz_*_See` etc. are OMSI intelligent crossings: o3d parses byte-perfectly
  (raw decode verified, single mesh, identity matrix, unit normals, coherent
  indices gap 3.4). `[rendertype] surface` template deformed at runtime by the
  attached roads → static render is a spike. Not a parser bug.

### Build results
- `npm run build`: clean.

### Tests executed (actual results)
- Correlation sweep over 13,080 `.sco`: dual-gate catches 35 meshes, ALL
  crossings/platforms (`Kreuz_*`/`Einm_*`/`Checkpoint_*`/`Falkensee_Bahnsteig`);
  0 legitimate objects caught; 0 large non-cube surface objects missed.
- Berlin-Spandau 60-tile slice: giant spike **gone**, scene clean; skip warnings
  logged per crossing. Grundorf junctions (<120m) unaffected.

### Known limitations
- Interim: crossing templates render as a small placeholder box, not their real
  (road-deformed) surface. Proper fix = implement crossing deformation (queued).

### Next highest-priority task
- D4 (culling for full large maps) or crossing deformation (full D6).

---

## Session 2026-10-16 (D3 — o3d v5 material chunk + transform matrix)

### Files changed
- `src/omsi/o3d.ts` — `validMaterialsAt` accepts empty (count=0) material chunks
  gated on a following `0x79`/EOF; `readMaterials` returns its end offset; new
  `readMatrixAt` / `isIdentityMatrix` / `applyMatrixToPositions`; `parseO3D`
  reads the `0x79` transform matrix and applies non-identity matrices to verts.
- `AUDIT.md` — D3 marked FIXED with verification; added D6 (oversized meshes).

### Root causes confirmed (byte-level)
- Empty material chunk (`26 00 00 79 …`) was rejected → wrong triangle combo →
  scramble. The `0x79` 4×4 matrix was never applied → junction `*_base` misplaced.

### Build results
- `npm run build`: clean.

### Tests executed (actual results)
- Fixed-parser replica over all 8,000 Sceneryobjects o3d: fallback-combo
  **35 → 10**; `matrixApplied=3,471`; parse errors unchanged (2 `badV`).
- `Einm_CharlCh_Stendel_base` 23% → 6% hedgehog (`fb=false`); `Rominter_base`
  into `fb=false` 0%. Haus01a/Stellwerk unchanged.
- Grundorf in viewport: layout unchanged (matrix convention correct, no scatter);
  no runtime errors. Berlin-Spandau 60-tile slice reloads fine.

### Known limitations / remaining failures
- D6: `Kreuz_*_See`-type junctions still render as a spike (vertices span ~340m
  cube); separate anomaly, not the material-chunk bug. Documented in AUDIT.md.
- 10 o3d still use fallback combo (down from 35); investigate remainder.

### Next highest-priority task
- D6 (oversized `Kreuz_*_See` meshes) OR D4 (culling for full large maps).

---

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
