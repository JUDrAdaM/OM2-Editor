import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TILE_SIZE } from "../omsi/types";
import type { OmsiMap, MapObject, MapSpline, MapTile, SplineAttachment } from "../omsi/types";
import {
  setObjectField, setSplineField, deleteObject, deleteSpline,
  duplicateObject, createObject, findTemplateObject, maxId,
} from "../omsi/map";
import { terrainHeightAt } from "../omsi/terrain";
import { ModelCache } from "./models";
import type { AssetSource, LoadedModel } from "./models";
import { SplineCache, buildSplineMesh, splineCenterline, splineSampleAt } from "./splines";
import type { LoadedSpline } from "./splines";
import { runPool } from "../util/async";

/** Max. souběžně načítaných assetů (bounded pool – brání I/O zahlcení u velkých map). */
const ASSET_CONCURRENCY = 24;

function tileHeight(t: MapTile, x: number, y: number): number {
  return t.terrain ? terrainHeightAt(t.terrain, x, y) : 0;
}

export interface ObjectSelection { kind: "object"; tileIndex: number; objectIndex: number; object: MapObject; }
export interface SplineSelection { kind: "spline"; tileIndex: number; splineIndex: number; spline: MapSpline; }
export type Selection = ObjectSelection | SplineSelection;
export type ObjField = "x" | "y" | "z" | "rotZ" | "rotX" | "rotY";
export type SplField = "x" | "y" | "z" | "rotZ" | "length" | "radius" | "gradientStart" | "gradientEnd";

const SPLINE_COLOR = 0xffb454;
const SPLINE_SEL_COLOR = 0x4ea1ff;
const OBJ_H = 6;

function worldPos(tileX: number, tileY: number, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(tileX * TILE_SIZE + x, z, -(tileY * TILE_SIZE + y));
}

interface Pickable { mesh: THREE.InstancedMesh; map: { tileIndex: number; objectIndex: number }[]; tileIndex: number; }
interface TileGroup { group: THREE.Group; sphere: THREE.Sphere; }

export class Viewport {
  readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  /** Jedna skupina na dlaždici (terén + objekty + attachmenty + splajny) → cullování. */
  private worldGroup = new THREE.Group();
  private tileGroups: TileGroup[] = [];
  private groundMeshes: THREE.Mesh[] = [];
  private pickables: Pickable[] = [];

  // Frustum culling + HUD
  private readonly frustum = new THREE.Frustum();
  private readonly projScreenMatrix = new THREE.Matrix4();
  private visibleTileCount = 0;
  private hud!: HTMLDivElement;
  private frameCount = 0;
  private lastHudT = performance.now();
  /** Zpětný index: "tileIndex:objectIndex" → instance (mesh + slot) ve všech dílech modelu. */
  private objInstances = new Map<string, { mesh: THREE.InstancedMesh; k: number; originRotY: number; absolute: boolean }[]>();
  /** Zpětný index: "tileIndex:splineIndex" → mesh splajnu (pro cílený přestavec). */
  private splineObjects = new Map<string, THREE.Object3D>();
  private highlight: THREE.LineSegments;

  private currentMap: OmsiMap | null = null;
  private selection: Selection | null = null;
  private selSplineLine: THREE.Line | null = null;

  private dragging: "object" | "spline" | null = null;
  private dragMoved = false;
  private readonly dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private placePath: string | null = null;

  private modelCache: ModelCache | null = null;
  private loadedModels = new Map<string, LoadedModel | null>();
  private loadToken = 0;

  private splineCache: SplineCache | null = null;
  private loadedSplines = new Map<string, LoadedSpline | null>();
  private splineLoadToken = 0;

  onSelect: ((sel: Selection | null) => void) | null = null;
  onChange: ((sel: Selection | null) => void) | null = null;
  onStatus: ((msg: string, error?: boolean) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    const { clientWidth: w, clientHeight: h } = container;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 20000);
    this.camera.position.set(300, 350, 450);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    // Malý výkonnostní HUD (FPS · viditelné/celkem dlaždic) – důkaz cullingu.
    this.hud = document.createElement("div");
    this.hud.style.cssText =
      "position:absolute;top:8px;left:8px;z-index:5;pointer-events:none;" +
      "font:11px/1.4 ui-monospace,Consolas,monospace;color:#8a99ad;" +
      "background:rgba(14,17,22,0.55);border:1px solid #253040;border-radius:6px;padding:3px 7px;";
    container.appendChild(this.hud);

    // Denní obloha (blíž vzhledu OMSI editoru).
    const SKY = 0x9dc4ef;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 4000, 16000);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.raycaster.params.Line = { threshold: 6 };

    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x55502f, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(400, 800, 300);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const grid = new THREE.GridHelper(TILE_SIZE * 20, 20 * 10, 0x2a3442, 0x1a2029);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    this.scene.add(grid);
    this.scene.add(this.worldGroup);

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(10, 16, 10)),
      new THREE.LineBasicMaterial({ color: SPLINE_SEL_COLOR })
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 2;
    this.scene.add(this.highlight);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  setAssetSource(src: AssetSource | null) {
    this.modelCache = src ? new ModelCache(src) : null;
    this.splineCache = src ? new SplineCache(src) : null;
  }

  private onResize = () => {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };
  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.updateVisibility();
    this.renderer.render(this.scene, this.camera);
    this.updateHud();
  };

  /** Per-dlaždicový frustum culling: neviditelné dlaždice se nesubmitují. */
  private updateVisibility() {
    if (this.tileGroups.length === 0) return;
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
    let visible = 0;
    for (const tg of this.tileGroups) {
      if (!tg) continue;
      const v = this.frustum.intersectsSphere(tg.sphere);
      tg.group.visible = v;
      if (v) visible++;
    }
    this.visibleTileCount = visible;
  }

  private updateHud() {
    this.frameCount++;
    const now = performance.now();
    const dt = now - this.lastHudT;
    if (dt >= 250) {
      const fps = Math.round((this.frameCount * 1000) / dt);
      const total = this.tileGroups.length;
      this.hud.textContent = total
        ? `${fps} FPS · ${this.visibleTileCount}/${total} dlaždic`
        : `${fps} FPS`;
      this.frameCount = 0;
      this.lastHudT = now;
    }
  }

  // ---------- Stavba ----------

  setMap(map: OmsiMap) {
    this.currentMap = map;
    this.clearSelection(false);
    this.loadedModels.clear();
    this.loadedSplines.clear();
    this.build();
    this.frameMap(map);
    this.loadModels();
    this.loadSplines();
  }
  rebuild() { this.build(); }

  private async loadSplines() {
    if (!this.splineCache || !this.currentMap) return;
    const token = ++this.splineLoadToken;
    const paths = new Set<string>();
    for (const t of this.currentMap.tiles) for (const s of t.splines) if (s.path) paths.add(s.path);
    const list = [...paths];
    // Bounded pool: nespouštět stovky souběžných čtení najednou.
    await runPool(
      list, ASSET_CONCURRENCY,
      async (p) => {
        const sp = await this.splineCache!.get(p);
        if (token === this.splineLoadToken) this.loadedSplines.set(p, sp);
      },
      undefined,
      () => token !== this.splineLoadToken
    );
    if (token !== this.splineLoadToken) return;
    const ok = [...this.loadedSplines.values()].filter(Boolean).length;
    this.build();
    this.restoreSelectionVisual();
    this.onStatus?.(`Splajny načteny (${ok}/${list.length}).`);
  }

  private async loadModels() {
    if (!this.modelCache || !this.currentMap) return;
    const token = ++this.loadToken;
    const paths = new Set<string>();
    for (const t of this.currentMap.tiles) {
      for (const o of t.objects) if (o.path) paths.add(o.path);
      for (const a of t.splineAttachments) if (a.path) paths.add(a.path);
      for (const a of t.attachObjects) if (a.path) paths.add(a.path);
    }
    const list = [...paths];
    this.onStatus?.(`Načítám ${list.length} modelů…`);
    // Bounded pool: u velkých map (stovky unikátních .sco) jinak vznikne
    // desetitisíce souběžných čtení → zahlcení I/O a pád. Postup hlásíme.
    await runPool(
      list, ASSET_CONCURRENCY,
      async (p) => {
        const m = await this.modelCache!.get(p);
        if (token === this.loadToken) this.loadedModels.set(p, m);
      },
      (doneN, totalN) => {
        if (token === this.loadToken && (doneN % 25 === 0 || doneN === totalN)) {
          this.onStatus?.(`Načítám modely… ${doneN}/${totalN}`);
        }
      },
      () => token !== this.loadToken
    );
    if (token !== this.loadToken) return;
    const ok = [...this.loadedModels.values()].filter(Boolean).length;
    this.build();
    this.restoreSelectionVisual();
    this.onStatus?.(`Modely načteny (${ok}/${list.length}).`);
  }

  private build() {
    const map = this.currentMap;
    if (!map) return;
    this.disposeWorld();
    this.pickables = [];
    this.objInstances.clear();
    this.splineObjects.clear();
    this.groundMeshes = [];
    this.selSplineLine = null;
    this.tileGroups = new Array(map.tiles.length);

    const tileMat = new THREE.MeshStandardMaterial({ color: 0x171d26, roughness: 1 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2f3b4d });

    // Rodiče pro [attachObj] – hledání napříč celou mapou (dítě může viset na
    // objektu z jiné dlaždice), ale instance ukládáme do skupiny deklarující dlaždice.
    const parentById = new Map<number, { t: MapTile; o: MapObject }>();
    for (const t of map.tiles) for (const o of t.objects) if (o.id != null) parentById.set(o.id, { t, o });

    const dummy = new THREE.Object3D();
    const dummyA = new THREE.Object3D();

    for (let ti = 0; ti < map.tiles.length; ti++) {
      const t = map.tiles[ti];
      const group = new THREE.Group();

      // Terén + okraj dlaždice
      const center = worldPos(t.tileX, t.tileY, TILE_SIZE / 2, TILE_SIZE / 2, -0.05);
      if (t.terrain) {
        const tm = this.buildTerrain(t);
        this.groundMeshes.push(tm);
        group.add(tm);
      } else {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE), tileMat);
        plane.rotation.x = -Math.PI / 2; plane.position.copy(center);
        plane.userData.ground = true;
        this.groundMeshes.push(plane);
        group.add(plane);
      }
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)), edgeMat);
      edges.rotation.x = -Math.PI / 2; edges.position.copy(center);
      group.add(edges);

      // Objekty této dlaždice seskupené podle cesty (.sco). Načtené → model, jinak box.
      const byPath = new Map<string, { oi: number; o: MapObject }[]>();
      const boxList: { oi: number; o: MapObject }[] = [];
      for (let oi = 0; oi < t.objects.length; oi++) {
        const o = t.objects[oi];
        const model = this.loadedModels.get(o.path);
        const absolute = model ? model.absoluteHeight : false;
        // Objekt mimo svoji dlaždici a NEabsolutní → OMSI ho nekreslí.
        if (this.outOfTile(o) && !absolute) continue;
        if (model) { let a = byPath.get(o.path); if (!a) { a = []; byPath.set(o.path, a); } a.push({ oi, o }); }
        else boxList.push({ oi, o });
      }
      for (const [p, entries] of byPath) {
        const model = this.loadedModels.get(p)!;
        for (const part of model.parts) {
          const inst = new THREE.InstancedMesh(part.geometry, part.material, entries.length);
          inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          const pmap: { tileIndex: number; objectIndex: number }[] = [];
          entries.forEach((e, k) => {
            this.setObjMatrix(dummy, t, e.o, model.originRotY, model.absoluteHeight);
            inst.setMatrixAt(k, dummy.matrix);
            pmap.push({ tileIndex: ti, objectIndex: e.oi });
            const key = `${ti}:${e.oi}`;
            let arr = this.objInstances.get(key);
            if (!arr) { arr = []; this.objInstances.set(key, arr); }
            arr.push({ mesh: inst, k, originRotY: model.originRotY, absolute: model.absoluteHeight });
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.frustumCulled = false; // cullujeme na úrovni skupiny dlaždice
          inst.userData.shared = true; // geometrie/materiál z cache – nedisposovat
          group.add(inst);
          this.pickables.push({ mesh: inst, map: pmap, tileIndex: ti });
        }
      }
      if (boxList.length) {
        const geo = new THREE.BoxGeometry(6, OBJ_H * 2, 6);
        const mat = new THREE.MeshStandardMaterial({ color: 0x6f7c8f, roughness: 0.85 });
        const inst = new THREE.InstancedMesh(geo, mat, boxList.length);
        const pmap: { tileIndex: number; objectIndex: number }[] = [];
        boxList.forEach((e, k) => {
          const h = tileHeight(t, e.o.x, e.o.y);
          dummy.position.copy(worldPos(t.tileX, t.tileY, e.o.x, e.o.y, h + e.o.z + OBJ_H));
          dummy.rotation.set(0, THREE.MathUtils.degToRad(e.o.rotZ), 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          inst.setMatrixAt(k, dummy.matrix);
          pmap.push({ tileIndex: ti, objectIndex: e.oi });
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        group.add(inst);
        this.pickables.push({ mesh: inst, map: pmap, tileIndex: ti });
      }

      // [splineAttachement] (lampy/stožáry/značky) + [attachObj] této dlaždice.
      const attByPath = new Map<string, THREE.Matrix4[]>();
      for (const a of t.splineAttachments) {
        if (!a.path || !t.splines[a.splineIndex]) continue;
        let mats = attByPath.get(a.path);
        if (!mats) { mats = []; attByPath.set(a.path, mats); }
        this.collectAttachmentMatrices(t, a, dummyA, mats);
      }
      for (const a of t.attachObjects) {
        if (!a.path || a.parentId == null) continue;
        const parent = parentById.get(a.parentId);
        if (!parent) continue;
        const pModel = this.loadedModels.get(parent.o.path);
        const attachMat = pModel?.attachments[a.attachIndex] ?? new THREE.Matrix4();
        const pm = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(parent.o.rotZ));
        pm.setPosition(worldPos(parent.t.tileX, parent.t.tileY, parent.o.x, parent.o.y, this.objBaseY(parent.t, parent.o)));
        const child = pm.clone().multiply(attachMat).multiply(
          new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(a.heading))
        );
        let mats = attByPath.get(a.path);
        if (!mats) { mats = []; attByPath.set(a.path, mats); }
        mats.push(child);
      }
      for (const [p, mats] of attByPath) {
        const model = this.loadedModels.get(p);
        if (!model || mats.length === 0) continue;
        for (const part of model.parts) {
          const inst = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
          mats.forEach((m, k) => inst.setMatrixAt(k, m));
          inst.instanceMatrix.needsUpdate = true;
          inst.frustumCulled = false;
          inst.userData.shared = true;
          group.add(inst);
        }
      }

      // Splajny této dlaždice: reálný mesh z .sli, jinak fallback žlutá čára.
      for (let si = 0; si < t.splines.length; si++) {
        const s = t.splines[si];
        const loaded = this.loadedSplines.get(s.path);
        const obj: THREE.Object3D = loaded
          ? buildSplineMesh(loaded, s, t.tileX, t.tileY)
          : this.buildSpline(t, s);
        obj.userData = { tileIndex: ti, splineIndex: si };
        group.add(obj);
        this.splineObjects.set(`${ti}:${si}`, obj);
      }

      this.worldGroup.add(group);
      this.tileGroups[ti] = { group, sphere: this.tileSphere(t) };
    }
  }

  /** Konzervativní obalová koule dlaždice (footprint + velkorysý vertikální rozsah). */
  private tileSphere(t: MapTile): THREE.Sphere {
    const cx = (t.tileX + 0.5) * TILE_SIZE;
    const cz = -(t.tileY + 0.5) * TILE_SIZE;
    const horiz = TILE_SIZE / 2 + 60;        // přesah objektů za okraj dlaždice
    const CENTER_Y = 120, VERT_HALF = 340;   // pokryje i vysoké budovy/věže
    const r = Math.hypot(horiz, horiz, VERT_HALF);
    return new THREE.Sphere(new THREE.Vector3(cx, CENTER_Y, cz), r);
  }

  /** Uvolní celou scénu dlaždic; sdílené (cache) geometrie/materiály nedisposuje. */
  private disposeWorld() {
    this.worldGroup.traverse((c) => {
      if (c.userData?.shared) return;
      const anyc = c as unknown as { isMesh?: boolean; isLine?: boolean; isLineSegments?: boolean };
      if (!anyc.isMesh && !anyc.isLine && !anyc.isLineSegments) return;
      const m = c as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
      else mat?.dispose?.();
    });
    this.worldGroup.clear();
    this.tileGroups = [];
  }

  /** Cílený přesun jediného objektu (bez přestavby celé scény). */
  private updateObjectInstance(tileIndex: number, objectIndex: number): boolean {
    if (!this.currentMap) return false;
    const arr = this.objInstances.get(`${tileIndex}:${objectIndex}`);
    if (!arr || arr.length === 0) return false; // např. fallback box → nutná přestavba
    const t = this.currentMap.tiles[tileIndex];
    const o = t.objects[objectIndex];
    const dummy = new THREE.Object3D();
    for (const ent of arr) {
      this.setObjMatrix(dummy, t, o, ent.originRotY, ent.absolute);
      ent.mesh.setMatrixAt(ent.k, dummy.matrix);
      ent.mesh.instanceMatrix.needsUpdate = true;
    }
    return true;
  }

  /** Cílená přestavba jediného splajnu (bez přestavby celé scény). */
  private updateSplineMesh(tileIndex: number, splineIndex: number): void {
    if (!this.currentMap) return;
    const key = `${tileIndex}:${splineIndex}`;
    const tg = this.tileGroups[tileIndex];
    const old = this.splineObjects.get(key);
    if (old) {
      tg?.group.remove(old);
      this.disposeObject3D(old);
    }
    const t = this.currentMap.tiles[tileIndex];
    const s = t.splines[splineIndex];
    const loaded = this.loadedSplines.get(s.path);
    const obj = loaded
      ? buildSplineMesh(loaded, s, t.tileX, t.tileY)
      : this.buildSpline(t, s);
    obj.userData = { tileIndex, splineIndex };
    tg?.group.add(obj);
    this.splineObjects.set(key, obj);
  }

  /** Viditelné splajny (z neskrytých dlaždic) pro raycast výběru. */
  private visibleSplineObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const [key, obj] of this.splineObjects) {
      const ti = Number(key.slice(0, key.indexOf(":")));
      if (this.tileGroups[ti]?.group.visible !== false) out.push(obj);
    }
    return out;
  }

  /** Uvolní geometrii/materiály jednoho objektu (jen vlastní, ne sdílené textury). */
  private disposeObject3D(obj: THREE.Object3D) {
    const m = obj as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
    else mat?.dispose?.();
  }

  private readonly _rTmp = new THREE.Matrix4();

  private setObjMatrix(dummy: THREE.Object3D, t: MapTile, o: MapObject, originRotY: number, absolute: boolean) {
    // Absolutní výška (křižovatky/výhybky/[absheight]): z přímo, bez terénu.
    // Jinak objekt stojí na terénu: výška = terén + o.z.
    const baseY = absolute ? o.z : tileHeight(t, o.x, o.y) + o.z;
    // OMSI je Z-up (X,Y vodorovně, Z výška); mapování map→three je vlastní rotace:
    //   rotZ (heading, kolem svislé) → three Y
    //   rotX (pitch, kolem mapové X) → three X
    //   rotY (bank,  kolem mapové Y) → three −Z
    // Pořadí jako v OMSI: heading · pitch · bank. Pro objekty bez náklonu
    // (rotX=rotY=0) je výsledek shodný s dřívější čistou rotací kolem Y.
    const m = dummy.matrix;
    m.makeRotationY(THREE.MathUtils.degToRad(o.rotZ + originRotY));
    if (o.rotX) m.multiply(this._rTmp.makeRotationX(THREE.MathUtils.degToRad(o.rotX)));
    if (o.rotY) m.multiply(this._rTmp.makeRotationZ(THREE.MathUtils.degToRad(-o.rotY)));
    m.setPosition(worldPos(t.tileX, t.tileY, o.x, o.y, baseY));
  }

  /** Objekt leží mimo svoji dlaždici (lokální x/y mimo [0,300])? OMSI ho nekreslí. */
  private outOfTile(o: MapObject): boolean {
    const e = TILE_SIZE + 1e-3;
    return o.x < -1e-3 || o.x > e || o.y < -1e-3 || o.y > e;
  }

  /** Spočítá matice instancí pro jednu řadu [splineAttachement] (podél splajnu + chain). */
  private collectAttachmentMatrices(
    t: MapTile, a: SplineAttachment,
    dummy: THREE.Object3D, out: THREE.Matrix4[]
  ) {
    const interval = Math.max(a.interval, 0);
    const dists: number[] = [];
    if (interval <= 1e-6) dists.push(a.startDist);
    else {
      const n = Math.min(2000, Math.floor(Math.max(a.range, 0) / interval + 1e-6));
      for (let j = 0; j <= n; j++) dists.push(a.startDist + j * interval);
    }
    for (const dChain of dists) {
      // najdi splajn v řetězci (v rámci dlaždice) a lokální vzdálenost
      let acc = 0, guard = 0, local = -1;
      let sp: MapSpline | undefined = t.splines[a.splineIndex];
      while (guard++ < 600 && sp) {
        const Lsp: number = Math.max(sp.length, 0);
        if (dChain <= acc + Lsp + 1e-6) { local = dChain - acc; break; }
        acc += Lsp;
        const nid: number | null = sp.nextId;
        const ni: number = nid ? t.splines.findIndex((x) => x.id === nid) : -1;
        if (ni < 0) { sp = undefined; break; }
        sp = t.splines[ni];
      }
      if (!sp || local < 0) continue;
      const smp = splineSampleAt(sp, local);
      dummy.position.set(
        t.tileX * TILE_SIZE + smp.lx + a.lateral * smp.rx,
        smp.worldY + a.height,
        -(t.tileY * TILE_SIZE + smp.ly + a.lateral * smp.ry)
      );
      dummy.rotation.set(0, THREE.MathUtils.degToRad(smp.headingDeg + a.heading), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      out.push(dummy.matrix.clone());
    }
  }

  /** Má objekt absolutní výšku (podle načteného modelu)? */
  private isAbsolute(path: string): boolean {
    return this.loadedModels.get(path)?.absoluteHeight ?? false;
  }
  /** Světová výška (osa Y) základny objektu – absolutní z, nebo terén + z. */
  private objBaseY(t: MapTile, o: MapObject): number {
    return this.isAbsolute(o.path) ? o.z : tileHeight(t, o.x, o.y) + o.z;
  }

  private buildTerrain(t: MapTile): THREE.Mesh {
    const terr = t.terrain!;
    const n = terr.size;
    const step = TILE_SIZE / (n - 1);
    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const w = worldPos(t.tileX, t.tileY, i * step, j * step, terr.heights[idx]);
      positions[idx * 3] = w.x; positions[idx * 3 + 1] = w.y; positions[idx * 3 + 2] = w.z;
    }
    const indices: number[] = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i, d = (j + 1) * n + i + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x47553a, roughness: 1, side: THREE.DoubleSide }));
    m.userData.ground = true;
    return m;
  }

  private splinePoints(t: MapTile, s: MapSpline, lift = 0.3): THREE.Vector3[] {
    return splineCenterline(s, t.tileX, t.tileY, (lx, ly) => tileHeight(t, lx, ly), lift);
  }
  private buildSpline(t: MapTile, s: MapSpline): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints(this.splinePoints(t, s));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: SPLINE_COLOR }));
  }

  private frameMap(map: OmsiMap) {
    if (map.tiles.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of map.tiles) {
      minX = Math.min(minX, t.tileX); maxX = Math.max(maxX, t.tileX);
      minY = Math.min(minY, t.tileY); maxY = Math.max(maxY, t.tileY);
    }
    const cx = ((minX + maxX + 1) / 2) * TILE_SIZE, cz = -((minY + maxY + 1) / 2) * TILE_SIZE;
    const span = (Math.max(maxX - minX, maxY - minY) + 1) * TILE_SIZE;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + span * 0.5, span * 0.5 + 150, cz + span * 0.6);
  }

  // ---------- Pointer / výběr ----------

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickObject(): { tileIndex: number; objectIndex: number } | null {
    let best: { dist: number; hit: { tileIndex: number; objectIndex: number } } | null = null;
    for (const pk of this.pickables) {
      if (this.tileGroups[pk.tileIndex]?.group.visible === false) continue; // skryté dlaždice nelze vybrat
      const hits = this.raycaster.intersectObject(pk.mesh);
      for (const h of hits) {
        if (h.instanceId != null && (!best || h.distance < best.dist)) {
          best = { dist: h.distance, hit: pk.map[h.instanceId] };
        }
        break;
      }
    }
    return best?.hit ?? null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.currentMap) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.placePath) {
      const p = this.raycastGround();
      if (p) this.placeObjectAt(p);
      return;
    }

    const objHit = this.pickObject();
    if (objHit) {
      const object = this.currentMap.tiles[objHit.tileIndex].objects[objHit.objectIndex];
      this.selectObject(objHit.tileIndex, objHit.objectIndex, object);
      const t = this.currentMap.tiles[objHit.tileIndex];
      this.dragging = "object"; this.dragMoved = false; this.controls.enabled = false;
      this.dragPlane.constant = -(this.objBaseY(t, object) + OBJ_H);
      return;
    }

    const sHits = this.raycaster.intersectObjects(this.visibleSplineObjects(), false);
    if (sHits.length > 0) {
      const { tileIndex, splineIndex } = sHits[0].object.userData as { tileIndex: number; splineIndex: number };
      const spline = this.currentMap.tiles[tileIndex].splines[splineIndex];
      this.selectSpline(tileIndex, splineIndex, spline);
      this.dragging = "spline"; this.dragMoved = false; this.controls.enabled = false;
      // Splajn se kreslí v absolutní výšce s.z (bez terénu) – rovina tažení taky.
      this.dragPlane.constant = -spline.z;
      return;
    }
    this.clearSelection(true);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || !this.selection || !this.currentMap) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;
    this.dragMoved = true;
    const t = this.currentMap.tiles[this.selection.tileIndex];
    const lx = round3(hit.x - t.tileX * TILE_SIZE), ly = round3(-hit.z - t.tileY * TILE_SIZE);
    if (this.selection.kind === "object") {
      setObjectField(t, this.selection.object, "x", lx);
      setObjectField(t, this.selection.object, "y", ly);
      // Živý cílený přesun instance (O(1)); fallback box se dorovná po puštění.
      this.updateObjectInstance(this.selection.tileIndex, this.selection.objectIndex);
      this.moveHighlightToObject(this.selection);
    } else {
      setSplineField(t, this.selection.spline, "x", lx);
      setSplineField(t, this.selection.spline, "y", ly);
      this.refreshSplineLine();
    }
    this.onChange?.(this.selection);
  };

  private onPointerUp = () => {
    if (!this.dragging) return;
    const moved = this.dragMoved;
    const sel = this.selection;
    this.dragging = null;
    this.controls.enabled = true;
    if (moved && sel) {
      // Cílená aktualizace jen dotčeného prvku (ne celá scéna).
      if (sel.kind === "object") {
        if (!this.updateObjectInstance(sel.tileIndex, sel.objectIndex)) this.build();
      } else {
        this.updateSplineMesh(sel.tileIndex, sel.splineIndex);
      }
      this.restoreSelectionVisual();
      this.onChange?.(sel);
    }
  };

  private raycastGround(): THREE.Vector3 | null {
    const hits = this.raycaster.intersectObjects(this.groundMeshes, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  private placeObjectAt(point: THREE.Vector3) {
    if (!this.currentMap || !this.placePath) return;
    const tileX = Math.floor(point.x / TILE_SIZE), tileY = Math.floor(-point.z / TILE_SIZE);
    const tileIndex = this.currentMap.tiles.findIndex((t) => t.tileX === tileX && t.tileY === tileY);
    if (tileIndex < 0) { this.onStatus?.("Na tomto místě není dlaždice mapy.", true); return; }
    const t = this.currentMap.tiles[tileIndex];
    const lx = round3(point.x - tileX * TILE_SIZE), ly = round3(-point.z - tileY * TILE_SIZE);
    const tmpl = findTemplateObject(this.currentMap, this.placePath);
    const templateSection = tmpl ? tmpl.tile.sections[tmpl.obj.sectionIndex] : undefined;
    const newObj = createObject(t, this.placePath, maxId(this.currentMap) + 1, lx, ly, 0, templateSection);
    const objectIndex = t.objects.indexOf(newObj);
    this.placePath = null; this.renderer.domElement.style.cursor = "";
    this.build();
    this.selectObject(tileIndex, objectIndex, newObj);
    this.onStatus?.("Objekt přidán.");
    this.onChange?.(this.selection);
  }

  // ---------- Zvýraznění ----------

  private moveHighlightToObject(sel: ObjectSelection) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[sel.tileIndex], o = sel.object;
    this.highlight.position.copy(worldPos(t.tileX, t.tileY, o.x, o.y, this.objBaseY(t, o) + OBJ_H));
    this.highlight.visible = true;
  }
  /** Vytvoří/obnoví modrou překryvnou čáru osy vybraného splajnu. */
  private setOverlay(tileIndex: number, splineIndex: number) {
    this.removeOverlay();
    const t = this.currentMap!.tiles[tileIndex];
    const s = t.splines[splineIndex];
    const pts = this.splinePoints(t, s, 0.4);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: SPLINE_SEL_COLOR, depthTest: false })
    );
    line.renderOrder = 3;
    this.selSplineLine = line;
    this.scene.add(line);
  }
  private removeOverlay() {
    if (!this.selSplineLine) return;
    this.scene.remove(this.selSplineLine);
    this.selSplineLine.geometry.dispose();
    (this.selSplineLine.material as THREE.Material).dispose();
    this.selSplineLine = null;
  }
  private refreshSplineLine() {
    if (this.selection?.kind !== "spline") return;
    this.setOverlay(this.selection.tileIndex, this.selection.splineIndex);
  }
  private restoreSelectionVisual() {
    if (this.selection?.kind === "object") this.moveHighlightToObject(this.selection);
    else if (this.selection?.kind === "spline") this.setOverlay(this.selection.tileIndex, this.selection.splineIndex);
  }

  private selectObject(tileIndex: number, objectIndex: number, object: MapObject) {
    this.removeOverlay();
    this.selection = { kind: "object", tileIndex, objectIndex, object };
    this.moveHighlightToObject(this.selection);
    this.onSelect?.(this.selection);
  }
  private selectSpline(tileIndex: number, splineIndex: number, spline: MapSpline) {
    this.highlight.visible = false;
    this.selection = { kind: "spline", tileIndex, splineIndex, spline };
    this.setOverlay(tileIndex, splineIndex);
    this.onSelect?.(this.selection);
  }
  private clearSelection(emit: boolean) {
    this.removeOverlay();
    this.highlight.visible = false; this.selection = null;
    if (emit) this.onSelect?.(null);
  }

  // ---------- Veřejné akce ----------

  getSelection(): Selection | null { return this.selection; }
  setPlaceMode(path: string | null) {
    this.placePath = path;
    this.renderer.domElement.style.cursor = path ? "crosshair" : "";
    this.onStatus?.(path ? `Umísťování: klikni na terén (${path.split("\\").pop()}). Esc zruší.` : "Umísťování zrušeno.");
  }
  isPlacing(): boolean { return this.placePath != null; }

  focusObject(tileIndex: number, objectIndex: number) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[tileIndex], o = t.objects[objectIndex];
    this.selectObject(tileIndex, objectIndex, o);
    const p = worldPos(t.tileX, t.tileY, o.x, o.y, this.objBaseY(t, o));
    this.controls.target.copy(p);
    this.camera.position.set(p.x + 40, p.y + 55, p.z + 40);
  }

  setSelectedObjectField(field: ObjField, value: number) {
    if (this.selection?.kind !== "object" || !this.currentMap) return;
    setObjectField(this.currentMap.tiles[this.selection.tileIndex], this.selection.object, field, value);
    // Cílený přesun instance; jen pokud objekt není instancovaný (box), přestav vše.
    if (!this.updateObjectInstance(this.selection.tileIndex, this.selection.objectIndex)) this.build();
    this.restoreSelectionVisual();
    this.onChange?.(this.selection);
  }
  setSelectedSplineField(field: SplField, value: number) {
    if (this.selection?.kind !== "spline" || !this.currentMap) return;
    setSplineField(this.currentMap.tiles[this.selection.tileIndex], this.selection.spline, field, value);
    this.updateSplineMesh(this.selection.tileIndex, this.selection.splineIndex);
    this.restoreSelectionVisual();
    this.onChange?.(this.selection);
  }
  rotateSelected(deltaDeg: number) {
    if (this.selection?.kind === "object") {
      let r = (this.selection.object.rotZ + deltaDeg) % 360; if (r < 0) r += 360;
      this.setSelectedObjectField("rotZ", round3(r));
    } else if (this.selection?.kind === "spline") {
      let r = (this.selection.spline.rotZ + deltaDeg) % 360; if (r < 0) r += 360;
      this.setSelectedSplineField("rotZ", round3(r));
    }
  }
  deleteSelected(): boolean {
    if (!this.selection || !this.currentMap) return false;
    const t = this.currentMap.tiles[this.selection.tileIndex];
    if (this.selection.kind === "object") deleteObject(t, this.selection.object);
    else deleteSpline(t, this.selection.spline);
    this.clearSelection(false);
    this.build();
    this.onSelect?.(null); this.onChange?.(null);
    return true;
  }
  duplicateSelected() {
    if (this.selection?.kind !== "object" || !this.currentMap) return;
    const tileIndex = this.selection.tileIndex, t = this.currentMap.tiles[tileIndex];
    const newObj = duplicateObject(t, this.selection.object, maxId(this.currentMap) + 1);
    const newIndex = t.objects.indexOf(newObj);
    this.build();
    this.selectObject(tileIndex, newIndex, newObj);
    this.onChange?.(this.selection);
  }
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }
