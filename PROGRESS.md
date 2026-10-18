# OM2-Editor — Progress log

See `AUDIT.md` for the full defect list and root-cause evidence.

## Session 2026-10-18 (undo / redo)

Added undo/redo — a core editing capability the editor was missing (move,
rotate, duplicate, delete, place had no way back).

- **Snapshot-based history** (`viewport.ts`): the tile's `sections` are the
  source of truth, so each edit brackets `beginEdit(tileIndex)` (deep-copy
  sections before) / `commitEdit()` (deep-copy after → push a record). Undo/redo
  restore the before/after sections, `deriveTile` re-derives the view, and the
  scene rebuilds. A drag is one record (begin on pointer-down, commit on
  pointer-up when moved; a click with no move discards the pending snapshot).
  No-op edits are skipped; history is capped at 100 and cleared on map load.
- Wired into every mutation (field edits, rotate, delete, duplicate, place,
  drag) and bound to **Ctrl+Z** (undo) / **Ctrl+Y** or **Ctrl+Shift+Z** (redo)
  in `app.ts`, with status messages; hint bar updated.
- **Verified in-browser (Grundorf):** rotate 159.84→174.84→undo→159.84→
  redo→174.84; drag X 56.863→103.722→undo→56.863 (whole drag = one step);
  delete→undo restores the object with its original id (5456). No JS errors,
  build clean.

---

## Session 2026-10-17 (terrain lightmaps — baked shading)

Added OMSI's **baked terrain lightmaps** (`<map>/tile_X_Y.map.LM.bmp`, a 256×256
BMP of baked shadows/AO per tile) so the terrain isn't a flat uniform grass but
has soft shading — what the OMSI editor shows. (A scan of the .map confirmed the
`[terrain]`/`[water]` sections and the `.terrain` binary hold no splatmap/water
data for these maps, so the base grass + lightmap is the complete terrain.)

- `viewport.loadLightmaps` loads each terrain tile's `.map.LM.bmp` via the
  `AssetSource` (path `maps/<rootName>/<fileName>.LM.bmp`), through the bounded
  pool (progressive, like model/spline loading), then rebuilds. `buildTerrain`
  adds a second UV set (`uv1`, 0..1 across the tile) and sets `material.lightMap`
  (intensity 1.0, `NoColorSpace`). Missing lightmap → graceful grass-only fallback.
- **Verified in the live scene:** Grundorf 19/19 terrain meshes carry both the
  grass `map` and the `lightMap` on `uv1`; Berlin 57/60 (3 tiles have no LM file →
  fallback). Visible soft shading on Berlin's elevation/urban terrain; no JS
  errors; build clean. Cost is bounded (~0.25 MB GPU per tile, loaded lazily).

---

## Session 2026-10-17 (terrain base texture — grass instead of solid green)

The biggest remaining "doesn't look like OMSI" gap was the terrain: a flat solid
green slab. (A scene scan first ruled out textures on objects — 94% of mesh
parts are textured; the 6% untextured are tiny sign/plate decals, not buildings.)

- OMSI's ground textures are a palette in **global.cfg `[groundtex]`** (index 0 =
  base, usually `texture\gras.bmp`; the rest are splatmap detail layers). The
  paths are **OMSI-root-relative**, so the existing `AssetSource` reads them
  directly (`gras.bmp` lives at `<OMSI>/Texture/gras.bmp`, shared, not in the map).
- Now parse `[groundtex]` (`map.ts` → `OmsiMap.groundTex`) and load the base
  texture (`viewport.loadGroundTexture`, async, rebuilds on load). `buildTerrain`
  gets tiled UVs (`GROUND_REPEAT = 16` ≈ every 19 m) and a textured material;
  the flat-plane fallback (tiles without terrain) too. Solid green stays as the
  fallback until the texture loads. The texture is shared (survives rebuilds).
- Splatmap detail (cobble/dirt paths on the terrain) is **not** applied yet;
  roads are drawn as splines above the ground, so the base grass is enough for a
  natural look.
- **Verified:** Grundorf & Berlin-Spandau — terrain now reads as grass (close-up
  texture detail, natural tone) instead of a dark slab; city/roads/trees sit on
  it correctly. 144 FPS (Grundorf) / 53 FPS (Berlin 25 tiles), no JS errors.
  Build clean. Data-driven, so a non-grass base map uses its own base texture.

---

## Session 2026-10-17 (distance culling — large maps at grazing angles)

Added per-tile **distance culling** on top of D4's frustum culling. A low
grazing view across a large map keeps hundreds of tiles inside the frustum
(stretching to the far plane), tanking the framerate. Now a tile renders only
when it is in the frustum **and** within a horizontal radius of the camera
target. The radius scales with zoom (`clamp(zoomDist*2 + 900, 1600, 14000)`), so
the focused region is always shown in full and only the distant periphery drops.

- `updateVisibility` (`viewport.ts`): horizontal distance test vs
  `controls.target`, combined with the existing `frustum.intersectsSphere`.
- **Verified:** Grundorf (19 tiles) **19/19** visible, 144 FPS — small maps never
  over-culled. Berlin 120 tiles: 103/120 zoomed out → **83/120** zoomed in, FPS
  30 → 50, focused area complete (no holes/flicker). No JS errors. Build clean.

---

## Session 2026-10-17 (attachment axis — "buildings stacked on top of each other")

User report: buildings appearing "sideways" and "several buildings on top of
each other". Root cause found by scanning the live scene (temporary `__scene`
dev hook): modular buildings were **stacked vertically** instead of placed
**side-by-side in rows**.

- **The `[new_attachment]` space is Z-up** (openOMSI: *"x right, y forward,
  z up"*), NOT Y-up like the mesh. So `attach_trans [0,15,0]` is 15 m **forward
  (horizontal)**, and the height is the **z** component. OMSI builds row/terrace
  houses and apartment blocks (`bw_row50s`, `wohn_*`) by attaching modules
  side-by-side via `attach_trans [0,±16,0]`; a gibbet signal hangs at `z≈5`.
- **We converted the attachment matrix as if it were Y-up** (`S=diag(1,1,-1)`,
  copied from the mesh conversion), so every horizontal forward offset became a
  **vertical lift** → modules stacked into towers (one `wohn_03` row became a
  6-high column at y=33→108; a `bw_row50s` row went *underground* to y=-15), and
  pole-top signs/signals were dropped to the ground.
- **Fix** (`models.ts attachmentMatrix`): conjugate the OMSI-space matrix by
  `B = Rx(-90°)` (OMSI (x,y,z)→three (x,z,-y) — the same map→three mapping)
  instead of `diag(1,1,-1)`: `M_three = B · M_omsi · B⁻¹`.
- **Verified in the live scene (Berlin, 25 tiles):** the `wohn_03` column
  collapsed from 6 stacked (33.7..108.7) to a single instance at that (x,z) with
  the rest spread horizontally into a row; `bw_row50s` from [33,17,1,-15] to
  [33]; **buildings below ground: several → 0**; stacked cells 69→17, max tower
  11→2. Residential streets now show proper terraced **rows**. Grundorf
  114/114, no regression, no JS errors. Build clean.
- Note: data scan showed object `rotX`/`rotY` are ~0 (Grundorf 0, Berlin max
  15°), so the "sideways" look was this same vertical-stack bug, not object tilt.

---

## Session 2026-10-17 (nested [attachObj] — children of children)

`[attachObj]` children whose parent is itself another `[attachObj]` (a sign on a
bracket on a pole) or a `[splineAttachement]` anchor were not drawn — only the
867/1447 Berlin children whose parent is a plain `[object]`. Measured parents:
867 object, **569 another attachObj (nested, 39%)**, 11 spline-row anchor, 0
missing, **0 with nonzero pitch/bank** (so pitch/bank skipped — unused here).

- **Global record-pose index + fixed-point resolution** (faithful to openOMSI
  `omsi-scene/stage.rs::compute_resolved`). `recordPose: id → {worldMatrix, path}`
  holds every `[object]` pose, every non-repeater `[splineAttachement]` *anchor*
  (its first placed object, keyed by row id — repeaters never anchor), and each
  resolved `[attachObj]`. `resolveAttach` is recursive with memoization + a cycle
  guard; a child registers itself under its id so a grandchild finds it. Child
  world = `parentPose · parentModel.attachments[attachIndex] · R_Y(childHeading)`
  — same formula as before, but the parent pose can now be an attachObj or anchor,
  and uses the parent's full `setObjMatrix` pose (incl. pitch/bank).
- Parsing: `SplineAttachment` gains `id` + `isRepeater`; `AttachObject` gains
  `id` (`types.ts`, `map.ts`). `viewport.ts build()`: precompute passes replace
  the old object-only `parentById`; `collectAttachmentMatrices` now runs once in
  the precompute (`splineRowMats`), reused for instancing.
- **Verified on real Berlin-Spandau** (node replica of the fixed-point resolve):
  **all 1447 attachObj now resolve** (was 867) in 2 passes — +580 objects (569
  nested + 11 anchors) that were previously invisible, 0 unresolved, no cycles.
- **Browser (Berlin, 60 tiles):** 568/573 models, coherent city, **no JS errors**,
  28–45 FPS, no regression. Build clean.

### Known limitations / next
- attachObj pitch/bank parsed-but-unused (0 in Berlin); add if a map needs it.
- D4 next: LOD / distance culling for the full 369-tile map.

---

## Session 2026-10-17 (spline attachment repeaters — cross-tile rows) — v0.0.13-alpha

The last big real gap. `[splineAttachement_repeater]` records (cross-tile
continuations of a row: catenary masts, guardrails, fences along roads/rails)
were parsed-dropped — 213 in Berlin-Spandau. Now rendered. Faithful port of
openOMSI `omsi-world/map_index.rs::tile_row_objects` + `omsi-map/tile.rs`.

- **Key semantics (verified against openOMSI):** a repeater is *self-contained*
  and placed exactly like a normal `[splineAttachement]`. The chain is walked
  **only within the same tile** (via `next_id`), ending at the tile edge; the
  next tile's repeater continues the row. So **no global spline index is needed**.
  The repeater's two extra pre-path fields (master tile idx, first-object idx)
  are consistency metadata only — placement ignores them.
- **`map_chain_offset` is the missing piece.** Object `j` sits at chain distance
  `startDist + j*interval` measured from the *chain's* start; a tile's start
  spline begins at its cumulative `chainOffset`, so local distance is
  `d0 + j*interval`, `d0 = startDist − chainOffset`. Objects with local < 0 are
  on earlier tiles (their repeaters draw them); beyond this tile's splines →
  next tile. `chainOffset` is OMSI's `tex_offset` = the 3rd trailing number of a
  `[spline]`/`[spline_h]` record (after cant); sanitized to 0 when non-positive.
- Files: `types.ts` (`MapSpline.chainOffset`), `map.ts` (`splineChainOffset` +
  `deriveSpline(version)`; `deriveTile` now accepts `splineattachement_repeater`),
  `viewport.ts` (`collectAttachmentMatrices`: `d0 = startDist − chainOffset`,
  skip local<0). Applies to normals too (correct per openOMSI).
- **Verified on real Berlin-Spandau** (node replica over the actual UTF-16 maps):
  `chainOffset` parse is **byte-perfect** — 346/346 within-tile prev links match
  `chainOffset(prev)+prev.length` to 0.00 m. Repeater rows partition the chain
  across tiles with no duplicates (Oberleitung_Gittermast row: chainOffset
  300/600/900 on consecutive tiles, each draws its slice). In the exact loaded
  60-tile centroid view: **+1181 repeater instances** (24 tiles, 98 records)
  that were previously invisible; normals repositioned correctly (3106→3257, no
  collapse). Total roadside attachment instances 3106 → 4438.
- **Browser (Berlin-Spandau, 60 tiles):** loads 568/573 models, coherent city,
  **no JS errors** (only benign texture 404s), 30 FPS, no regression. Build clean.

---

## Session 2026-10-17 (crossing [crossing_heightdeformation] + rotX/rotY)

- **Object pitch/bank (rotX/rotY)** now applied at render (`setObjMatrix`):
  heading·pitch·bank via composed matrix; objects without tilt unchanged.
- **Crossing height deformation** implemented (faithful port of openOMSI
  `place.rs warp_crossings` / `field_height`). `[crossing_heightdeformation]` in
  a .sco names a coarse height-field **mesh**; every plate vertex is raised by
  the field's height at its (x,z) (barycentric interp over field triangles, max
  over covering tris, miss → unchanged). Terrain plays no part. Applied to raw
  Y-up positions before `buildGeometry` bakes the origin, in the same frame as
  the field. Axis map: our Y-up (height=Y, plane=X,Z) ↔ openOMSI Z-up, so
  openOMSI (x,y)→our (x,z), openOMSI z(height)→our y.
  - Parse: `sco.ts` `crossingDeform`; apply: `models.ts`
    `crossingFieldHeight` + `applyCrossingDeform`.
  - **Verified on real Berlin-Spandau crossings** (node replica over the actual
    .o3d): `Kreuz_FernbhfSpandau` 752/3001 verts raised (25%), Δ 0.01..0.30 m
    (kerbs/camber); `Kreuz_AmJul_Breite` 631/1378 (46%), Δ −1.35..0.03 m (an arm
    dropping to its road); `Einm_Stresowplatz` 0% (its field doesn't cover the
    plate — openOMSI would leave it unchanged too). Math matches openOMSI exactly.
  - Browser: Berlin-Spandau still renders, no errors, no regression.

---

## Session 2026-10-17 (D4 — per-tile frustum culling + visibility)

The long-pending performance task. Previously objects were instanced **globally
by `.sco` path**, so each `InstancedMesh` spanned the whole map and could not be
frustum-culled (`frustumCulled = false`) — the whole scene was submitted every
frame.

- **Scene reorganised into one `THREE.Group` per tile** (terrain + the tile's
  objects, attachments and splines); objects instanced **per-tile-per-path**.
- **`updateVisibility()`** (each frame) builds the camera frustum and toggles
  `group.visible` per tile against a conservative per-tile bounding `Sphere`
  (`tileSphere`: footprint + 60 m horizontal margin, 340 m vertical half-extent
  → tall buildings/towers never false-cull). Off-screen tiles submit no draw
  calls. Picking + ground raycast skip hidden tiles.
- **HUD** (FPS · visible/total tiles) added to the viewport as live proof.
- Verified on Grundorf (real assets): 114/114 models, coherent scene, HUD
  **19/19 → 15/19** when zooming in, 140+ FPS, selection works, no runtime errors
  (only the known benign texture 404s). O(tiles)/frame — scales to Berlin's 369.

### Known limitations / next
- Count-changing edits (delete/duplicate/place) still full-rebuild.
- Optional: LOD / distance culling, off-thread chunked scene build.

---

## Session 2026-10-17 (D11 — render spline attachments & attachObj)

Verified against openOMSI (`omsi-world/map_index.rs`, `omsi-scene/stage.rs`,
`omsi-scenery/sco.rs`).

- **[splineAttachement]** (lamps, masts, signs along roads): placed at
  `startDist + j*interval` along the spline's chain (while `j*interval ≤ range`),
  each offset laterally (right) + height, facing spline tangent + attachment
  heading; walks following splines via next_id. `splineSampleAt` added.
  Verified: Berlin-Spandau renders 1082 instances on the splines.
- **[attachObj]** (signs/lights on a parent's `[new_attachment]` point): parse
  `[new_attachment]` + `attach_trans`/`attach_rot_*` ops → attachment matrix
  (D3D built like openOMSI, converted to three by S·M·S, S=diag(1,1,-1)); child
  world = parent(T·R_Y) · attachMatrix · R_Y(childHeading). Verified: resolves
  and renders without scatter.

### Known limitations / next
- attachObj parents must be a regular `[object]` in a loaded tile — children
  whose parent is cross-tile (unloaded) or a `[splineAttachement]`/`[attachObj]`
  are not drawn yet (≈half in a 12-tile slice; improves with more tiles loaded).
- `[splineAttachement_repeater]` (cross-tile rows) and attachment-row picking
  not done. attachObj pitch/bank not applied.

---

## Session 2026-10-16 (D10 — levitating & scattered objects on large maps)

Verified against openOMSI (`crates/omsi-scene/src/stage.rs`) + measured data.

- **Absolute-height objects levitated.** openOMSI: an object uses absolute z
  (no terrain) when its .sco has `[absheight]` OR any `[path]` (crossings,
  railway switches, road pieces); `absolute_height() = abs_height || !paths`.
  We added terrain to every object, so those sat ~terrain-height up (~33 m on
  Berlin). Berlin: 257 such objects (crossings, `EW190` switches).
- **Scattered objects "outside the map."** OMSI does NOT draw a non-absolute
  object whose tile-local x/y is outside `[0, tile]` (worldcoordinates-map
  leftovers that would be 11 km underground). We drew them. Berlin: **7,861**
  such objects (38% of the sampled objects) — the "random scattered" look.
- Fix (`sco.ts`, `models.ts`, `viewport.ts`): `ScoInfo.absHeight` +
  `LoadedModel.absoluteHeight` (`[absheight]`/`[path]`); `setObjMatrix`/highlight/
  drag/focus use absolute z when set, else terrain+z; `build()` skips
  non-absolute out-of-tile objects (kept in map data/tree, just not drawn —
  as OMSI does). Crossings are absolute → now flat plates at the right height.
- Verified: Berlin-Spandau — no scatter, no levitation; coherent city. Grundorf/
  Lisen unchanged (few absolute / out-of-tile). Build clean.

---

## Session 2026-10-16 (D9 — roads don't connect / scattered objects)

Verified against openOMSI (`crates/omsi-map/src/tile.rs`) + real data (Grundorf,
Berlin-Spandau, Lisen).

- **Spline curvature sign was inverted.** openOMSI: `radius > 0` turns RIGHT
  (clockwise); we used `kappa = -1/R` (left). Measured endpoint→next-start error
  over resolvable `next_id` links: `+1/R` median **0.00 m** (Grundorf/Lisen),
  `-1/R` median 7.45 m. Fixed `SPLINE_DIR = 1` → curved roads now join.
- **`[splineAttachement]` was parsed as a regular `[object]`** (its layout is
  spline-index + lateral offset, not x/y/z) → lamps/masts/signs scattered to
  random spots. Removed from `isObjectSection`; not drawn for now (TODO: place
  along the spline). `[attachObj]` likewise stays undrawn (hangs on a parent).
- Verified visually: Grundorf and Berlin-Spandau now render a connected road
  network with correct curves/junctions; no scattered objects.

### Also fixed (same session)
- `[spline_h]` height now uses the cubic `delta_h` (h'(0)=gS, h'(L)=gE,
  h(L)=Z+delta_h). Measured end-height vs next.Z on Berlin: parabola max 12.0 m
  → delta_h max 0.0 m. Added `MapSpline.deltaH`, parsed from spline_h records.

### Known limitations / next
- `[splineAttachement]`/`[attachObj]` objects undrawn (lamps, masts, attached
  signs). Cross-tile spline connection: a minority still off (Berlin p90 ~72 m)
  — investigate (tile-grid offset / chain semantics).
- Record layout is version-dependent; our maps are v11–14 where object offsets
  hold, but a general version-aware `.map` parser is the robust long-term fix.

---

## Session 2026-10-16 (D8 — spline height double-counts terrain → floating roads)

- Symptom: roads/splines levitated (worst on hilly maps). Measured: spline `z`
  is the **absolute** road height (≈ aligned terrain) — Grundorf splineZ≈terrain
  (both ~0); Berlin-Spandau splineZ 32–37 m vs terrain 32–33 m. But the spline
  mesh used `s.z + gradient + terrain_height + profile` → double-counted terrain,
  so in Berlin-Spandau roads sat ~33 m above the ground. (Objects use `terrain +
  o.z` with small relative `o.z`, so they were already grounded.)
- Fix (`src/viewport/splines.ts`): spline height = `s.z + gradient + profile`
  (no terrain term) in `buildSplineMesh`/`pushVert`/`splineCenterline`; removed
  the now-unused `heightAt` plumbing; aligned the spline drag-plane to `s.z`.
- Verified: Berlin-Spandau roads now sit flush on the terrain; Grundorf unchanged
  (terrain ~0). Build clean.

---

## Session 2026-10-16 (D7b — fix axis convention after unscramble)

- Regression after D7: ~90% of models lay on their side / levitated. Cause:
  unscrambled o3d is OMSI-native **Y-up (DirectX)** (the crossing's flat axis is
  Y), but `buildGeometry`'s o3d branch still mapped the vertical from coord2
  (the old Z-up assumption that matched the *scrambled* raw data).
- Fix (`src/viewport/models.ts` `buildGeometry`): o3d branch now treats data as
  Y-up — vertical = coord1, `origin_rot_y` rotates the (x,z) horizontal plane,
  Z negated for right-handedness (same convention as the xmesh/.x branch).
- Verified: Grundorf & Berlin-Spandau — buildings upright and grounded, roofs
  correct, crossings flat; no sideways/levitating models. Build clean.

---

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
