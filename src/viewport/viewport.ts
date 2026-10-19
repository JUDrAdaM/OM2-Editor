import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { TILE_SIZE } from "../omsi/types";
import type { OmsiMap, MapObject, MapSpline, MapTile, SplineAttachment, AttachObject, OmsiSection } from "../omsi/types";
import {
  setObjectField, setSplineField, deleteObject, deleteSpline,
  duplicateObject, createObject, findTemplateObject, maxId, deriveTile,
  createSpline, findTemplateSpline, setSplineNext, setTreeOverride,
} from "../omsi/map";
import { terrainHeightAt } from "../omsi/terrain";
import { ModelCache, decodeTexture, tryReadNamed, textureCandidates, dirOf, clearTextureCache } from "./models";
import type { AssetSource, LoadedModel } from "./models";
import { SplineCache, appendSplineGeometry, buildMergedSplineMeshes, splineCenterline, splineSampleAt, appendPathLines, buildPathLineMeshes } from "./splines";
import type { LoadedSpline, SplineMergeBucket } from "./splines";
import { runPool } from "../util/async";

/** Max. souběžně načítaných assetů (bounded pool - brání I/O zahlcení u velkých map). */
const ASSET_CONCURRENCY = 24;

function tileHeight(t: MapTile, x: number, y: number): number {
  return t.terrain ? terrainHeightAt(t.terrain, x, y) : 0;
}

export interface ObjectSelection { kind: "object"; tileIndex: number; objectIndex: number; object: MapObject; }
export interface SplineSelection { kind: "spline"; tileIndex: number; splineIndex: number; spline: MapSpline; }
export type Selection = ObjectSelection | SplineSelection;
export type ObjField = "x" | "y" | "z" | "rotZ" | "rotX" | "rotY";
export type GizmoMode = "translate" | "rotate" | "scale";
export type ToolId = "select" | "object" | "road" | "terrain" | "paint" | "erase";
export type SplField = "x" | "y" | "z" | "rotZ" | "length" | "radius" | "gradientStart" | "gradientEnd";

const SPLINE_COLOR = 0xffb454;
const SPLINE_SEL_COLOR = 0x4ea1ff;
/** Barva zjednodušené osové čáry splajnu ve vzdáleném (LOD) pohledu - tlumený asfalt. */
const SPLINE_LOD_COLOR = 0x6b7079;
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

  // Transformační gizmo (manipulátor jako v Unreal / Roblox): posun XYZ, rotace,
  // měřítko (měřítko jen u stromů - OMSI jinde velikost objektu neukládá).
  private gizmo!: TransformControls;
  private readonly gizmoProxy = new THREE.Object3D();
  private gizmoMode: GizmoMode = "translate";
  /** Oznámí UI změnu režimu gizma (panel tlačítek je v horní liště appky). */
  onGizmoMode?: (mode: GizmoMode) => void;

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
  /** Sloučené meshe splajnů podle indexu dlaždice (render + raycast výběru).
   *  Splajny dlaždice jsou sloučené do pár meshů (per textura) místo tisíců
   *  samostatných - výběr se dořeší nejbližší osou v zasažené dlaždici. */
  private tileSplineMeshes = new Map<number, THREE.Object3D[]>();
  private highlight: THREE.LineSegments;

  private currentMap: OmsiMap | null = null;
  private selection: Selection | null = null;
  private selSplineLine: THREE.Line | null = null;

  private dragging: "object" | "spline" | null = null;
  private dragMoved = false;
  /** Pozice stisku (px) - tažení se počítá až po překročení prahu (brání tomu,
   *  aby pouhý klik mikro-posunem označil dlaždici jako změněnou). */
  private dragStartScreen: { x: number; y: number } | null = null;
  private static readonly DRAG_THRESHOLD_PX = 3;
  /** Vzdálenost kamery (m), do níž se splajny dlaždice kreslí detailně; dál jen
   *  zjednodušená osová čára (LOD) - kvůli plynulému overview velkých map. */
  private static readonly LOD_DETAIL_DIST = 1400;

  // Historie úprav (undo/redo): snapshot sekcí dotčené dlaždice před/po editaci.
  // Sekce jsou zdroj pravdy, takže obnovení + deriveTile + build vrátí přesný stav.
  private undoStack: { tileIndex: number; before: OmsiSection[]; after: OmsiSection[] }[] = [];
  private redoStack: { tileIndex: number; before: OmsiSection[]; after: OmsiSection[] }[] = [];
  private pendingBefore: { tileIndex: number; sections: OmsiSection[] } | null = null;
  /** Oznámí UI změnu dostupnosti undo/redo. */
  onHistory?: () => void;
  private readonly dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private placePath: string | null = null;
  /** Aktivní nástroj (null = výběr). */
  private tool: "road" | "terrain" | "paint" | "erase" | null = null;
  /** Stavba silnic: zvolený .sli profil, počáteční bod a poslední vytvořený segment. */
  private roadPath: string | null = null;
  private roadStart: { wx: number; wy: number } | null = null; // mapové světové souřadnice
  private lastRoad: { tileIndex: number; spline: MapSpline } | null = null;
  /** Heading (°), na který musí navázat další segment (tečna na konci předchozího).
   *  null = další segment je první → rovný ve směru kliknutí. Díky tomu silnice
   *  plynule zatáčí: každý další úsek je kruhový oblouk tečný na předchozí. */
  private roadHeading: number | null = null;
  /** Úprava terénu: operace, poloměr a síla štětce; aktivní tah. */
  private terrainOp: "raise" | "lower" | "flatten" | "smooth" = "raise";
  /** Cílová výška pro „vyrovnat" (sejme se na začátku tahu). */
  private flattenTarget = 0;
  private flattenSampled = false;
  private brushRadius = 25;
  private brushStrength = 1.2;
  private terrainStroke = false;
  private terrainTouched = new Set<number>(); // dlaždice změněné tahem (pro rebuild)
  /** Terénní mesh podle indexu dlaždice (pro živou deformaci). */
  private terrainMeshes = new Map<number, THREE.Mesh>();
  /** Malování povrchu: načtená detailní textura (dlažba atd.). */
  private paintTexture: THREE.Texture | null = null;
  /** Perzistentní malovaná maska dlaždice (canvas); přežívá přestavby scény. */
  private paintMasks = new Map<number, HTMLCanvasElement>();
  /** Overlay vrstvy v aktuální scéně (vytváří se při build() z masek). */
  private paintLayers = new Map<number, { tex: THREE.CanvasTexture; mesh: THREE.Mesh }>();
  private paintStroke = false;
  private static readonly PAINT_RES = 256;

  private modelCache: ModelCache | null = null;
  private loadedModels = new Map<string, LoadedModel | null>();
  private loadToken = 0;
  private assetSrc: AssetSource | null = null;
  /** Základní terénní textura (groundtex[0], typicky tráva); null = plná barva. */
  private groundTexture: THREE.Texture | null = null;
  private groundTexToken = 0;
  /** Zapečené lightmapy terénu (`.map.LM.bmp`) podle fileName dlaždice. */
  private lightmaps = new Map<string, THREE.Texture>();
  private lmToken = 0;
  /** Per-instance textury stromů (druh) podle klíče `scoDir|texName`. */
  private treeTex = new Map<string, THREE.Texture>();
  /** Materiály stromů podle textury (sdílené, nedisposují se). */
  private treeMat = new Map<THREE.Texture, THREE.Material>();
  private treeTexToken = 0;

  private splineCache: SplineCache | null = null;
  private loadedSplines = new Map<string, LoadedSpline | null>();
  private splineLoadToken = 0;

  // ---- AI provoz + semafory (overlay) ----
  /** Zapnutá vizualizace AI drah + semaforů (přepínač v liště). */
  private aiVisible = false;
  /** ID objektů, které signalroutes.cfg označuje jako návěstidla/semafory. */
  private signalIds = new Set<number>();
  private signalToken = 0;
  /** Poslední spočtené počty pro status (AI dráhy dle typu + semafory). */
  private aiStats = { car: 0, ped: 0, rail: 0, lights: 0 };

  onSelect: ((sel: Selection | null) => void) | null = null;
  onChange: ((sel: Selection | null) => void) | null = null;
  onStatus: ((msg: string, error?: boolean) => void) | null = null;
  /** Oznámí UI změnu aktivního nástroje (pro zvýraznění v panelu). */
  onTool: ((tool: ToolId) => void) | null = null;

  /** Aktuální nástroj pro UI (odvozený ze stavu). */
  activeTool(): ToolId {
    if (this.placePath) return "object";
    if (this.tool === "road") return "road";
    if (this.tool === "terrain") return "terrain";
    if (this.tool === "paint") return "paint";
    if (this.tool === "erase") return "erase";
    return "select";
  }
  private emitTool() { this.onTool?.(this.activeTool()); }

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

    // Malý výkonnostní HUD (FPS · viditelné/celkem dlaždic) - důkaz cullingu.
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

    // Transformační gizmo - manipulátor na vybraném prvku (osy posunu / prstence
    // rotace / krychličky měřítka). Kreslí se přímo ve scéně (ne ve worldGroup →
    // nepodléhá cullingu ani disposu). Proxy objekt nese transformaci; po změně se
    // přepíše zpět do polí objektu/splajnu (zdroj pravdy = sekce .map).
    this.scene.add(this.gizmoProxy);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace("world");
    this.gizmo.setSize(0.85);
    this.gizmo.enabled = false;
    this.gizmo.addEventListener("dragging-changed", (e) => this.onGizmoDragChanged(e.value as boolean));
    this.gizmo.addEventListener("objectChange", () => this.applyGizmo());
    const gh = this.gizmo as unknown as { getHelper?: () => THREE.Object3D };
    this.scene.add(gh.getHelper ? gh.getHelper() : (this.gizmo as unknown as THREE.Object3D));

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onCamKeyDown);
    window.addEventListener("keyup", this.onCamKeyUp);
    window.addEventListener("blur", () => { this.camDirs.clear(); });
    if (import.meta.env?.DEV) (window as unknown as { __vp?: Viewport }).__vp = this;
    this.animate();
  }

  // ---------- Transformační gizmo ----------

  getGizmoMode(): GizmoMode { return this.gizmoMode; }

  /** Přepne režim gizma. Měřítko je dostupné jen u stromů (OMSI jinde neukládá). */
  setGizmoMode(mode: GizmoMode) {
    if (mode === "scale") {
      if (this.selection?.kind === "spline") {
        this.onStatus?.("Spline nelze škálovat - uprav Délku/Poloměr v inspektoru.", true);
        return;
      }
      if (this.selection?.kind === "object" && !this.loadedModels.get(this.selection.object.path)?.treeBase) {
        this.onStatus?.("Měřítko: OMSI ukládá velikost jen u stromů. Použij posun/rotaci.", true);
        return;
      }
    }
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.updateGizmoAxes();
    this.onGizmoMode?.(mode);
  }

  /** Omez osy gizma: u splajnu v rotaci jen svislá (heading). */
  private updateGizmoAxes() {
    this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
    if (this.selection?.kind === "spline" && this.gizmoMode === "rotate") {
      this.gizmo.showX = false;
      this.gizmo.showZ = false;
    }
  }

  /** Připne gizmo na vybraný prvek (pokud není aktivní jiný nástroj). */
  private attachGizmo() {
    if (!this.selection || this.tool || this.placePath) { this.detachGizmo(); return; }
    // Měřítko dává smysl jen u stromů - jinak spadni na posun.
    if (this.gizmoMode === "scale" &&
        !(this.selection.kind === "object" && this.loadedModels.get(this.selection.object.path)?.treeBase)) {
      this.gizmoMode = "translate";
      this.onGizmoMode?.("translate");
    }
    this.syncGizmo();
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.enabled = true;
    this.gizmo.attach(this.gizmoProxy);
    this.updateGizmoAxes();
  }
  private detachGizmo() {
    this.gizmo.detach();
    this.gizmo.enabled = false;
  }

  /** Nastaví proxy gizma na světovou transformaci vybraného prvku. */
  private syncGizmo() {
    const sel = this.selection;
    if (!sel || !this.currentMap) return;
    const t = this.currentMap.tiles[sel.tileIndex];
    const p = this.gizmoProxy;
    if (sel.kind === "object") {
      const o = sel.object;
      p.position.copy(worldPos(t.tileX, t.tileY, o.x, o.y, this.objBaseY(t, o)));
      // Pořadí YXZ odpovídá OMSI heading·pitch·bank (viz setObjMatrix).
      p.rotation.set(
        THREE.MathUtils.degToRad(o.rotX),
        THREE.MathUtils.degToRad(o.rotZ),
        THREE.MathUtils.degToRad(-o.rotY),
        "YXZ"
      );
    } else {
      const s = sel.spline;
      p.position.copy(worldPos(t.tileX, t.tileY, s.x, s.y, s.z));
      p.rotation.set(0, THREE.MathUtils.degToRad(s.rotZ), 0, "YXZ");
    }
    p.scale.set(1, 1, 1);
    p.updateMatrixWorld();
  }

  private onGizmoDragChanged(dragging: boolean) {
    this.controls.enabled = !dragging;
    if (dragging) {
      if (this.selection) this.beginEdit(this.selection.tileIndex);
    } else {
      const sel = this.selection;
      this.commitEdit();
      if (sel?.kind === "object") {
        if (!this.updateObjectInstance(sel.tileIndex, sel.objectIndex)) this.build();
      } else if (sel?.kind === "spline") {
        this.updateSplineMesh(sel.tileIndex, sel.splineIndex);
      }
      this.restoreSelectionVisual();
      this.onChange?.(this.selection);
    }
  }

  /** Zapíše aktuální transformaci proxy zpět do polí vybraného prvku (živě). */
  private applyGizmo() {
    const sel = this.selection;
    if (!sel || !this.currentMap) return;
    const t = this.currentMap.tiles[sel.tileIndex];
    const p = this.gizmoProxy;
    if (sel.kind === "object") {
      const o = sel.object;
      if (this.gizmoMode === "scale") {
        const base = this.loadedModels.get(o.path)?.treeBase;
        if (base && base.height > 0) {
          const sy = Math.max(0.05, p.scale.y);
          const newH = round3(base.height * sy);
          const newR = o.treeRatio && o.treeRatio > 0 ? o.treeRatio : base.ratio;
          setTreeOverride(t, o, newH, newR);
          this.updateObjectInstance(sel.tileIndex, sel.objectIndex);
          this.moveHighlightToObject(sel);
          this.onChange?.(sel);
        }
        return;
      }
      const lx = round3(p.position.x - t.tileX * TILE_SIZE);
      const ly = round3(-p.position.z - t.tileY * TILE_SIZE);
      setObjectField(t, o, "x", lx);
      setObjectField(t, o, "y", ly);
      const terrainBase = this.isAbsolute(o.path) ? 0 : tileHeight(t, lx, ly);
      setObjectField(t, o, "z", round3(p.position.y - terrainBase));
      if (this.gizmoMode === "rotate") {
        const e = p.rotation; // order YXZ
        let rz = THREE.MathUtils.radToDeg(e.y) % 360; if (rz < 0) rz += 360;
        setObjectField(t, o, "rotZ", round3(rz));
        setObjectField(t, o, "rotX", round3(THREE.MathUtils.radToDeg(e.x)));
        setObjectField(t, o, "rotY", round3(-THREE.MathUtils.radToDeg(e.z)));
      }
      this.updateObjectInstance(sel.tileIndex, sel.objectIndex);
      this.moveHighlightToObject(sel);
    } else {
      const s = sel.spline;
      const lx = round3(p.position.x - t.tileX * TILE_SIZE);
      const ly = round3(-p.position.z - t.tileY * TILE_SIZE);
      setSplineField(t, s, "x", lx);
      setSplineField(t, s, "y", ly);
      setSplineField(t, s, "z", round3(p.position.y));
      if (this.gizmoMode === "rotate") {
        let rz = THREE.MathUtils.radToDeg(p.rotation.y) % 360; if (rz < 0) rz += 360;
        setSplineField(t, s, "rotZ", round3(rz));
      }
      // Mesh dlaždice přestavíme až po puštění gizma (onGizmoDragChanged) - při
      // sloučeném renderu by přestavba celé dlaždice každý snímek sekala. Živě
      // stačí modrá osová čára (overlay).
      this.refreshSplineLine();
    }
    this.onChange?.(sel);
  }

  setAssetSource(src: AssetSource | null) {
    this.assetSrc = src;
    clearTextureCache(); // nová mapa/kořen → zahoď staré GPU textury
    this.modelCache = src ? new ModelCache(src) : null;
    this.splineCache = src ? new SplineCache(src) : null;
  }

  /**
   * Načte základní terénní texturu (global.cfg `[groundtex]` index 0, typicky
   * tráva) a po načtení přestaví scénu, aby terén nebyl plná zeleň. Cesta je
   * relativní ke kořeni OMSI (čte ji AssetSource přímo). Detailní splatmapa
   * (cesty/dlažba) se zatím nenanáší; silnice kreslí splajny nad terénem.
   */
  private async loadGroundTexture() {
    const token = ++this.groundTexToken;
    this.groundTexture = null;
    const map = this.currentMap;
    const main = map?.groundTex?.[0]?.main;
    if (!this.assetSrc || !main) return;
    let buf: ArrayBuffer | null = null;
    try { buf = await this.assetSrc.readFile(main); } catch { buf = null; }
    if (!buf || token !== this.groundTexToken) return;
    const tex = decodeTexture(main, buf);
    if (!tex || token !== this.groundTexToken) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    this.groundTexture = tex;
    this.build();
  }

  /**
   * Načte zapečené lightmapy terénu (`<mapa>/tile_X_Y.map.LM.bmp`) - stíny/AO,
   * které OMSI předpočítá a editor zobrazuje. Nanáší se na terén přes 2. UV sadu
   * (uv1, 0..1 přes dlaždici) jako `lightMap`, takže terén není plochý jas, ale
   * má měkké stínování. Načítá se přes bounded pool (progresivně) a jen pro
   * dlaždice s terénem; chybějící lightmapa = fallback bez stínování.
   */
  private async loadLightmaps() {
    const token = ++this.lmToken;
    this.lightmaps.clear();
    const map = this.currentMap;
    if (!this.assetSrc || !map || !map.rootName) return;
    const tiles = map.tiles.filter((t) => t.terrain);
    await runPool(
      tiles, ASSET_CONCURRENCY,
      async (t) => {
        const path = `maps/${map.rootName}/${t.fileName}.LM.bmp`;
        let buf: ArrayBuffer | null = null;
        try { buf = await this.assetSrc!.readFile(path); } catch { buf = null; }
        if (!buf || token !== this.lmToken) return;
        const tex = decodeTexture(path, buf);
        if (tex && token === this.lmToken) {
          tex.colorSpace = THREE.NoColorSpace; // lightmapa je multiplikátor, ne sRGB barva
          tex.flipY = true;
          this.lightmaps.set(t.fileName, tex);
        }
      },
      undefined,
      () => token !== this.lmToken
    );
    if (token === this.lmToken && this.lightmaps.size) this.build();
  }

  /**
   * Načte per-instance textury stromů (druh) z přepisů [object]. Každý strom má
   * vlastní texturu (kaštan, bříza…), takže les není jednodruhový. Textury se
   * sdílejí přes cache (klíč `scoDir|texName`); materiály taktéž. Po načtení
   * přestaví scénu. Chybějící textura → fallback na výchozí texturu modelu.
   */
  private async loadTreeTextures() {
    const token = ++this.treeTexToken;
    this.treeTex.clear();
    for (const m of this.treeMat.values()) m.dispose();
    this.treeMat.clear();
    if (!this.assetSrc || !this.currentMap) return;
    const want = new Map<string, { scoDir: string; texName: string }>();
    for (const t of this.currentMap.tiles) {
      for (const o of t.objects) {
        if (!o.treeTex) continue;
        const scoDir = dirOf(o.path);
        const key = `${scoDir}|${o.treeTex.toLowerCase()}`;
        if (!want.has(key)) want.set(key, { scoDir, texName: o.treeTex });
      }
    }
    await runPool(
      [...want.entries()], ASSET_CONCURRENCY,
      async ([key, { scoDir, texName }]) => {
        const found = await tryReadNamed(this.assetSrc!, textureCandidates(scoDir, texName));
        if (!found || token !== this.treeTexToken) return;
        const tex = decodeTexture(found.name, found.buf);
        if (tex && token === this.treeTexToken) {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          this.treeTex.set(key, tex);
        }
      },
      undefined,
      () => token !== this.treeTexToken
    );
    if (token === this.treeTexToken && this.treeTex.size) this.build();
  }

  /** Materiál billboardu stromu pro danou texturu (alpha-test; sdílený). */
  private treeMaterialFor(tex: THREE.Texture): THREE.Material {
    let mat = this.treeMat.get(tex);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        map: tex, color: 0xffffff, roughness: 1, metalness: 0,
        side: THREE.DoubleSide, transparent: false, alphaTest: 0.5,
      });
      this.treeMat.set(tex, mat);
    }
    return mat;
  }
  /** Vrátí override texturu stromu pro objekt (nebo null). */
  private treeTexFor(o: MapObject): THREE.Texture | null {
    if (!o.treeTex) return null;
    return this.treeTex.get(`${dirOf(o.path)}|${o.treeTex.toLowerCase()}`) ?? null;
  }

  private onResize = () => {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };
  private animate = () => {
    requestAnimationFrame(this.animate);
    this.updateCameraMove();
    this.controls.update();
    this.updateVisibility();
    this.renderer.render(this.scene, this.camera);
    this.updateHud();
  };

  // ---------- Pohyb kamery klávesnicí (WASD + šipky) ----------

  private readonly camDirs = new Set<"fwd" | "back" | "left" | "right">();
  private camFast = false;
  private camLastT = performance.now();
  private readonly _cv1 = new THREE.Vector3();
  private readonly _cv2 = new THREE.Vector3();
  private readonly _cv3 = new THREE.Vector3();

  private isTypingTarget(): boolean {
    const ae = document.activeElement as HTMLElement | null;
    return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
  }

  private onCamKeyDown = (e: KeyboardEvent) => {
    if (this.isTypingTarget() || e.ctrlKey || e.metaKey || e.altKey) return;
    this.camFast = e.shiftKey;
    const k = e.key.toLowerCase();
    // WASD vždy, šipky jen když nic není vybráno (jinak šipky = jemný posun).
    const arrowsForCam = this.selection == null;
    if (k === "w" || (arrowsForCam && e.key === "ArrowUp")) this.camDirs.add("fwd");
    else if (k === "s" || (arrowsForCam && e.key === "ArrowDown")) this.camDirs.add("back");
    else if (k === "a" || (arrowsForCam && e.key === "ArrowLeft")) this.camDirs.add("left");
    else if (k === "d" || (arrowsForCam && e.key === "ArrowRight")) this.camDirs.add("right");
    else return;
    if (arrowsForCam && e.key.startsWith("Arrow")) e.preventDefault();
  };
  private onCamKeyUp = (e: KeyboardEvent) => {
    this.camFast = e.shiftKey;
    const k = e.key.toLowerCase();
    if (k === "w" || e.key === "ArrowUp") this.camDirs.delete("fwd");
    if (k === "s" || e.key === "ArrowDown") this.camDirs.delete("back");
    if (k === "a" || e.key === "ArrowLeft") this.camDirs.delete("left");
    if (k === "d" || e.key === "ArrowRight") this.camDirs.delete("right");
  };

  /** Posune kameru (i cíl orbitu) ve vodorovné rovině podle aktivních směrů. */
  private updateCameraMove() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.camLastT) / 1000); // s, nezávislé na FPS
    this.camLastT = now;
    if (this.camDirs.size === 0) return;
    const fwd = this.camera.getWorldDirection(this._cv1);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize();
    const right = this._cv2.set(-fwd.z, 0, fwd.x); // kolmice vpravo na ploše
    const dist = this.camera.position.distanceTo(this.controls.target);
    // ~0.8x vzdálenosti za sekundu (Shift 3x), nezávisle na snímkování.
    const step = Math.max(4, dist * 0.8) * dt * (this.camFast ? 3 : 1);
    const move = this._cv3.set(0, 0, 0);
    if (this.camDirs.has("fwd")) move.add(fwd);
    if (this.camDirs.has("back")) move.sub(fwd);
    if (this.camDirs.has("right")) move.add(right);
    if (this.camDirs.has("left")) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(step);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  /**
   * Per-dlaždicový culling: dlaždice se submituje jen když je v zorném poli
   * (frustum) A zároveň v dosahu od cíle kamery (distance culling). Dosah roste
   * se zoomem (vzdálenost kamera↔cíl), takže zaostřená oblast je vždy celá vidět;
   * ořízne se jen vzdálená periferie - hlavní přínos u nízkých „grazing" pohledů
   * přes velké mapy, kde by frustum jinak pustil stovky dlaždic až k obzoru.
   */
  private updateVisibility() {
    if (this.tileGroups.length === 0) return;
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    // Dosah culling: horizontální poloměr kolem cíle kamery, škálovaný zoomem.
    const tgt = this.controls.target;
    const zoomDist = this.camera.position.distanceTo(tgt);
    const radius = Math.min(14000, Math.max(1600, zoomDist * 2 + 900));
    const r2 = radius * radius;

    // LOD: dlaždice blíž než LOD_DETAIL_DIST od kamery kreslí detailní (texturované)
    // splajny, vzdálenější jen zjednodušenou osovou čáru → v overview drasticky
    // méně draw callů splajnů (1/dlaždici místo desítek).
    const camPos = this.camera.position;
    const lodDist2 = Viewport.LOD_DETAIL_DIST * Viewport.LOD_DETAIL_DIST;

    let visible = 0;
    for (let ti = 0; ti < this.tileGroups.length; ti++) {
      const tg = this.tileGroups[ti];
      if (!tg) continue;
      const dx = tg.sphere.center.x - tgt.x, dz = tg.sphere.center.z - tgt.z;
      const near = dx * dx + dz * dz <= r2;
      const v = near && this.frustum.intersectsSphere(tg.sphere);
      tg.group.visible = v;
      if (!v) continue;
      visible++;
      const cdx = tg.sphere.center.x - camPos.x, cdz = tg.sphere.center.z - camPos.z;
      const detail = cdx * cdx + cdz * cdz <= lodDist2;
      const objs = this.tileSplineMeshes.get(ti);
      if (objs) {
        for (const o of objs) {
          o.visible = (o.userData as { splineLod?: boolean }).splineLod ? !detail : detail;
        }
      }
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
    this.clearHistory();
    this.paintMasks.clear(); this.paintLayers.clear(); this.paintTexture = null;
    this.clearSelection(false);
    this.loadedModels.clear();
    this.loadedSplines.clear();
    this.build();
    this.frameMap(map);
    this.loadModels();
    this.loadSplines();
    this.loadGroundTexture();
    this.loadLightmaps();
    this.loadTreeTextures();
    void this.loadSignalRoutes();
  }
  rebuild() { this.build(); }
  /** Znovu načte základní texturu terénu (po změně map.groundTex[0]). */
  reloadGround() { void this.loadGroundTexture(); }
  /** Přestaví scénu a zacíli na danou dlaždici (po přidání nové dlaždice). */
  focusTile(tileIndex: number) {
    if (!this.currentMap) return;
    this.build();
    const t = this.currentMap.tiles[tileIndex];
    if (!t) return;
    const cx = (t.tileX + 0.5) * TILE_SIZE, cz = -(t.tileY + 0.5) * TILE_SIZE;
    const base = t.terrain ? (t.terrain.heights[0] as number) : 0;
    this.controls.target.set(cx, base, cz);
    this.camera.position.set(cx + 120, base + 260, cz + 220);
  }

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

  /**
   * Zajistí, že model .sco je načtený v `loadedModels` - a když ne, dotáhne ho a
   * přestaví scénu. Volá se při umísťování vlastního objektu (tlačítko „Umístit"
   * / procházení): loadModels() běží jen při otevření mapy, takže nově přidaná
   * cesta by jinak zůstala jen jako šedý box. Idempotentní (ModelCache dedupuje).
   */
  private async ensureModel(path: string | null): Promise<void> {
    if (!path || !this.modelCache || this.loadedModels.has(path)) return;
    const map = this.currentMap;
    const m = await this.modelCache.get(path);
    if (this.currentMap !== map) return;          // mezitím se přepnula mapa
    if (this.loadedModels.has(path)) return;       // doplnil mezitím loadModels()
    this.loadedModels.set(path, m);
    this.build();
    this.restoreSelectionVisual();
  }

  /** Obdoba ensureModel pro splajn (.sli) - při stavbě vlastní silnice. */
  private async ensureSpline(path: string | null): Promise<void> {
    if (!path || !this.splineCache || this.loadedSplines.has(path)) return;
    const map = this.currentMap;
    const sp = await this.splineCache.get(path);
    if (this.currentMap !== map) return;
    if (this.loadedSplines.has(path)) return;
    this.loadedSplines.set(path, sp);
    this.build();
    this.restoreSelectionVisual();
  }

  private build() {
    const map = this.currentMap;
    if (!map) return;
    this.disposeWorld();
    this.pickables = [];
    this.objInstances.clear();
    this.tileSplineMeshes.clear();
    this.groundMeshes = [];
    this.terrainMeshes.clear();
    this.selSplineLine = null;
    this.tileGroups = new Array(map.tiles.length);

    const tileMat = new THREE.MeshStandardMaterial({ color: 0x171d26, roughness: 1 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2f3b4d });

    const dummy = new THREE.Object3D();
    const dummyA = new THREE.Object3D();

    // ---- Předvýpočet pozic řad [splineAttachement] a [attachObj] (napříč mapou) ----
    // `recordPose`: ID záznamu → světová matice + cesta modelu. Obsahuje objekty,
    // „kotvy" řad (1. objekt non-repeater [splineAttachement]) a vyřešené [attachObj].
    // Díky tomu [attachObj] může viset na objektu, na kotvě řady, i na jiném
    // [attachObj] (vnořené - ~39 % případů). Řešení je fixed-point (rekurze s
    // memoizací), stejně jako openOMSI compute_resolved.
    const recordPose = new Map<number, { mat: THREE.Matrix4; path: string }>();
    // Objekty
    for (const t of map.tiles) {
      for (const o of t.objects) {
        if (o.id == null) continue;
        const model = this.loadedModels.get(o.path);
        this.setObjMatrix(dummy, t, o, model?.originRotY ?? 0, model?.absoluteHeight ?? false);
        if (!recordPose.has(o.id)) recordPose.set(o.id, { mat: dummy.matrix.clone(), path: o.path });
      }
    }
    // Matice řad [splineAttachement] (předpočítané i pro instancování) + kotvy.
    const splineRowMats = new Map<string, THREE.Matrix4[]>();
    for (let ti = 0; ti < map.tiles.length; ti++) {
      const t = map.tiles[ti];
      for (let ai = 0; ai < t.splineAttachments.length; ai++) {
        const a = t.splineAttachments[ai];
        if (!a.path || !t.splines[a.splineIndex]) continue;
        const mats: THREE.Matrix4[] = [];
        this.collectAttachmentMatrices(t, a, dummyA, mats);
        splineRowMats.set(`${ti}:${ai}`, mats);
        // Kotva = 1. (nejnižší) umístěný objekt non-repeater řady.
        if (!a.isRepeater && a.id != null && mats.length && !recordPose.has(a.id)) {
          recordPose.set(a.id, { mat: mats[0], path: a.path });
        }
      }
    }
    // Index [attachObj] podle ID (pro vnořené rodiče) + rekurzivní resolve.
    const attachObjById = new Map<number, AttachObject>();
    for (const t of map.tiles) for (const a of t.attachObjects) if (a.id != null) attachObjById.set(a.id, a);
    const attachResolved = new Map<AttachObject, THREE.Matrix4>();
    const resolving = new Set<number>();
    const resolveAttach = (a: AttachObject): THREE.Matrix4 | null => {
      if (a.parentId == null) return null;
      let parent = recordPose.get(a.parentId);
      if (!parent) {
        const pa = attachObjById.get(a.parentId);
        if (!pa || pa === a || resolving.has(a.parentId)) return null; // chybí / cyklus
        resolving.add(a.parentId);
        const pm = resolveAttach(pa);
        resolving.delete(a.parentId);
        if (!pm) return null;
        parent = { mat: pm, path: pa.path };
        if (pa.id != null && !recordPose.has(pa.id)) recordPose.set(pa.id, parent);
      }
      const pModel = this.loadedModels.get(parent.path);
      const attachMat = pModel?.attachments[a.attachIndex] ?? new THREE.Matrix4();
      const child = parent.mat.clone()
        .multiply(attachMat)
        .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(a.heading)));
      if (a.id != null && !recordPose.has(a.id)) recordPose.set(a.id, { mat: child, path: a.path });
      return child;
    };
    for (const t of map.tiles) {
      for (const a of t.attachObjects) {
        if (!a.path) continue;
        const m = resolveAttach(a);
        if (m) attachResolved.set(a, m);
      }
    }

    // ---- Sběr objektů/attachmentů GLOBÁLNĚ (napříč dlaždicemi) ----
    // Místo jednoho InstancedMesh na dlaždici×cestu (→ u velkých map desetitisíce
    // draw callů → 1 FPS / ztráta WebGL kontextu → černo) sloučíme stejné modely
    // přes CELOU načtenou mapu: jeden InstancedMesh na cestu(.sco)×díl. Terén,
    // okraje a splajny zůstávají per-dlaždice (kvůli frustum/distance cullingu).
    type ObjEntry = { ti: number; oi: number; o: MapObject };
    const objByPath = new Map<string, ObjEntry[]>();
    const boxEntries: ObjEntry[] = [];
    const attByPath = new Map<string, THREE.Matrix4[]>();
    const pushAtt = (path: string, m: THREE.Matrix4) => {
      let mats = attByPath.get(path);
      if (!mats) { mats = []; attByPath.set(path, mats); }
      mats.push(m);
    };

    for (let ti = 0; ti < map.tiles.length; ti++) {
      const t = map.tiles[ti];
      const group = new THREE.Group();

      // Terén + okraj dlaždice
      const center = worldPos(t.tileX, t.tileY, TILE_SIZE / 2, TILE_SIZE / 2, -0.05);
      if (t.terrain) {
        const tm = this.buildTerrain(t);
        this.groundMeshes.push(tm);
        this.terrainMeshes.set(ti, tm);
        group.add(tm);
      } else {
        const planeGeo = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
        if (this.groundTexture) {
          // natáhni UV na opakování textury přes dlaždici
          const uv = planeGeo.attributes.uv as THREE.BufferAttribute;
          for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * Viewport.GROUND_REPEAT, uv.getY(k) * Viewport.GROUND_REPEAT);
          uv.needsUpdate = true;
        }
        const plane = new THREE.Mesh(planeGeo, this.groundTexture ? this.groundMaterial() : tileMat);
        if (this.groundTexture) plane.userData.sharedTex = true;
        plane.rotation.x = -Math.PI / 2; plane.position.copy(center);
        plane.userData.ground = true;
        this.groundMeshes.push(plane);
        group.add(plane);
      }
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)), edgeMat);
      edges.rotation.x = -Math.PI / 2; edges.position.copy(center);
      group.add(edges);

      // Objekty této dlaždice zařaď do globálních kbelíků dle cesty. Načtené →
      // model, jinak box.
      for (let oi = 0; oi < t.objects.length; oi++) {
        const o = t.objects[oi];
        const model = this.loadedModels.get(o.path);
        const absolute = model ? model.absoluteHeight : false;
        // Objekt mimo svoji dlaždici a NEabsolutní → OMSI ho nekreslí.
        if (this.outOfTile(o) && !absolute) continue;
        if (model) { let a = objByPath.get(o.path); if (!a) { a = []; objByPath.set(o.path, a); } a.push({ ti, oi, o }); }
        else boxEntries.push({ ti, oi, o });
      }

      // [splineAttachement] + [attachObj] této dlaždice → globální kbelíky.
      for (let ai = 0; ai < t.splineAttachments.length; ai++) {
        const a = t.splineAttachments[ai];
        const mats = splineRowMats.get(`${ti}:${ai}`);
        if (!mats) continue;
        for (const m of mats) pushAtt(a.path, m);
      }
      for (const a of t.attachObjects) {
        const m = attachResolved.get(a);
        if (m) pushAtt(a.path, m);
      }

      // Splajny této dlaždice sloučíme do pár meshů (per textura) + jedné žluté
      // čáry pro nenačtené. Místo tisíců draw callů má dlaždice jen pár. Výběr se
      // řeší raycastem meshe → nejbližší osa splajnu v zasažené dlaždici.
      this.addTileSplines(ti, t, group);

      this.worldGroup.add(group);
      this.tileGroups[ti] = { group, sphere: this.tileSphere(t) };
    }

    // ---- Globální instancování objektů (jeden InstancedMesh na cestu×díl) ----
    for (const [p, entries] of objByPath) {
      const model = this.loadedModels.get(p)!;
      const isTree = !!model.treeBase;
      for (const part of model.parts) {
        // U stromů rozdělíme instance podle per-objektové textury (druh), jinak
        // jedna skupina s výchozím materiálem modelu.
        type Grp = { mat: THREE.Material | THREE.Material[]; items: ObjEntry[] };
        let groups: Grp[];
        if (isTree) {
          const byMat = new Map<THREE.Material | THREE.Material[], ObjEntry[]>();
          for (const e of entries) {
            const tex = this.treeTexFor(e.o);
            const mat = tex ? this.treeMaterialFor(tex) : part.material;
            let a = byMat.get(mat); if (!a) { a = []; byMat.set(mat, a); } a.push(e);
          }
          groups = [...byMat.entries()].map(([mat, items]) => ({ mat, items }));
        } else {
          groups = [{ mat: part.material, items: entries }];
        }
        for (const g of groups) {
          const inst = new THREE.InstancedMesh(part.geometry, g.mat, g.items.length);
          inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          const pmap: { tileIndex: number; objectIndex: number }[] = [];
          g.items.forEach((e, k) => {
            this.setObjMatrix(dummy, map.tiles[e.ti], e.o, model.originRotY, model.absoluteHeight);
            inst.setMatrixAt(k, dummy.matrix);
            pmap.push({ tileIndex: e.ti, objectIndex: e.oi });
            const key = `${e.ti}:${e.oi}`;
            let arr = this.objInstances.get(key);
            if (!arr) { arr = []; this.objInstances.set(key, arr); }
            arr.push({ mesh: inst, k, originRotY: model.originRotY, absolute: model.absoluteHeight });
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.frustumCulled = false; // globální mesh pokrývá celou mapu
          inst.userData.shared = true; // geometrie/materiál z cache - nedisposovat
          this.worldGroup.add(inst);
          this.pickables.push({ mesh: inst, map: pmap, tileIndex: -1 });
        }
      }
    }

    // Fallback boxy (nenačtené modely) - jeden globální InstancedMesh.
    if (boxEntries.length) {
      const geo = new THREE.BoxGeometry(6, OBJ_H * 2, 6);
      const mat = new THREE.MeshStandardMaterial({ color: 0x6f7c8f, roughness: 0.85 });
      const inst = new THREE.InstancedMesh(geo, mat, boxEntries.length);
      const pmap: { tileIndex: number; objectIndex: number }[] = [];
      boxEntries.forEach((e, k) => {
        const t = map.tiles[e.ti];
        const h = tileHeight(t, e.o.x, e.o.y);
        dummy.position.copy(worldPos(t.tileX, t.tileY, e.o.x, e.o.y, h + e.o.z + OBJ_H));
        dummy.rotation.set(0, THREE.MathUtils.degToRad(e.o.rotZ), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        inst.setMatrixAt(k, dummy.matrix);
        pmap.push({ tileIndex: e.ti, objectIndex: e.oi });
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.worldGroup.add(inst);
      this.pickables.push({ mesh: inst, map: pmap, tileIndex: -1 });
    }

    // Globální instancování [splineAttachement]/[attachObj].
    for (const [p, mats] of attByPath) {
      const model = this.loadedModels.get(p);
      if (!model || mats.length === 0) continue;
      for (const part of model.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
        mats.forEach((m, k) => inst.setMatrixAt(k, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        inst.userData.shared = true;
        this.worldGroup.add(inst);
      }
    }

    // Malované overlay vrstvy znovu vytvoř z perzistentních masek.
    this.rebuildPaintOverlays();

    // AI overlay: markery semaforů/návěstidel + přepočet statistik.
    this.buildAiMarkers(map);
  }

  /**
   * Postaví markery semaforů/návěstidel (svislé majáky nad objektem) a přepočítá
   * statistiky AI provozu. Semafor = objekt, jehož .sco cesta odpovídá vzoru
   * (Ampel/signal/…) NEBO jehož ID je v signalroutes.cfg. Markery jsou AI overlay
   * (viditelné dle aiVisible), sloučené do jediného LineSegments (výkon).
   */
  private buildAiMarkers(map: OmsiMap): void {
    // Spočítej, které .sli nesou jaký typ AI dráhy (napříč mapou, bez duplicit).
    const carSli = new Set<string>(), pedSli = new Set<string>(), railSli = new Set<string>();
    for (const [path, loaded] of this.loadedSplines) {
      if (!loaded) continue;
      for (const p of loaded.def.paths) {
        if (p.type === 0) carSli.add(path);
        else if (p.type === 1) pedSli.add(path);
        else if (p.type === 2) railSli.add(path);
      }
    }
    let car = 0, ped = 0, rail = 0;
    for (const t of map.tiles) for (const s of t.splines) {
      if (carSli.has(s.path)) car++;
      if (pedSli.has(s.path)) ped++;
      if (railSli.has(s.path)) rail++;
    }

    const stick: number[] = [];
    const H = 7, CR = 1.2; // výška majáku + příčka nahoře
    let lights = 0;
    for (const t of map.tiles) {
      for (const o of t.objects) {
        if (!this.isSignalObject(o)) continue;
        lights++;
        const wx = t.tileX * TILE_SIZE + o.x;
        const wz = -(t.tileY * TILE_SIZE + o.y);
        const base = o.z, top = o.z + H;
        stick.push(wx, base, wz, wx, top, wz);          // svislý stožár
        stick.push(wx - CR, top, wz, wx + CR, top, wz);  // příčka X
        stick.push(wx, top, wz - CR, wx, top, wz + CR);  // příčka Z
      }
    }
    if (stick.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(stick), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xff2e2e, transparent: true, opacity: 0.95, depthWrite: false });
      const seg = new THREE.LineSegments(geo, mat);
      seg.renderOrder = 4;
      seg.visible = this.aiVisible;
      seg.userData = { aiOverlay: true };
      this.worldGroup.add(seg);
    }
    this.aiStats = { car, ped, rail, lights };
  }

  /** Vzor cest .sco pokládaných za semafor/návěstidlo (OMSI pojmenování). */
  private static readonly SIGNAL_RE =
    /ampel|trafficlight|lichtsignal|lichtzeichen|_tl_|sv_esig|sv_hsig|sv_vsig|signal/i;

  /** Je objekt semafor/návěstidlo? (ID v signalroutes.cfg nebo cesta dle vzoru.) */
  private isSignalObject(o: MapObject): boolean {
    if (o.id != null && this.signalIds.has(o.id)) return true;
    return Viewport.SIGNAL_RE.test(o.path);
  }

  /**
   * Zapne/vypne vizualizaci AI provozu (dráhy + semafory). Jen přepne viditelnost
   * už postavených overlay objektů (bez přestavby scény) a nahlásí statistiku.
   */
  setAiTraffic(on: boolean): void {
    this.aiVisible = on;
    this.worldGroup.traverse((o) => { if (o.userData?.aiOverlay) o.visible = on; });
    const s = this.aiStats;
    if (on) {
      this.onStatus?.(
        `AI provoz: ${s.car} silnic pro auta, ${s.ped} pro chodce, ${s.rail} kolejí; ` +
        `${s.lights} semaforů/návěstidel.`
      );
    } else {
      this.onStatus?.("AI provoz skryt.");
    }
  }

  /** Vrací, zda je AI overlay zapnutý (pro synchronizaci UI tlačítka). */
  aiTrafficVisible(): boolean { return this.aiVisible; }

  /**
   * Načte signalroutes.cfg mapy (kořen mapy, ASCII) a vytáhne ID objektů, která
   * jsou návěstidla/semafory ([signal]/[distsignal]/[nextsignal] - 1. číslo za
   * hlavičkou je ID objektu). Best-effort: když soubor chybí, přeskočí se. Po
   * načtení přestaví markery (build), aby se zahrnuly i signály bez klíčové cesty.
   */
  private async loadSignalRoutes(): Promise<void> {
    const token = ++this.signalToken;
    this.signalIds = new Set();
    const map = this.currentMap;
    if (!this.assetSrc || !map?.rootName) return;
    let buf: ArrayBuffer | null = null;
    try { buf = await this.assetSrc.readFile(`maps\\${map.rootName}\\signalroutes.cfg`); } catch { buf = null; }
    if (!buf || token !== this.signalToken || this.currentMap !== map) return;
    const text = new TextDecoder("windows-1252").decode(buf);
    const lines = text.split(/\r?\n/);
    const ids = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const n = lines[i].trim().toLowerCase();
      if (n === "[signal]" || n === "[distsignal]" || n === "[nextsignal]") {
        // 1. neprázdný řádek pod hlavičkou = ID objektu.
        for (let k = i + 1; k < lines.length && k < i + 4; k++) {
          const v = lines[k].trim();
          if (!v) continue;
          const id = parseInt(v, 10);
          if (Number.isFinite(id) && id > 0) ids.add(id);
          break;
        }
      }
    }
    if (token !== this.signalToken || this.currentMap !== map) return;
    this.signalIds = ids;
    this.build(); // přepočítá markery včetně ID-based signálů
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

  /**
   * Postaví sloučené meshe splajnů jedné dlaždice a přidá je do její skupiny.
   * Načtené splajny se extrudují do kbelíků per textura (→ jeden mesh na texturu),
   * nenačtené se kreslí jako jedna žlutá čára (LineSegments). Vše nese
   * `userData.splineTile = ti`, aby raycast věděl, do které dlaždice zásah patří.
   */
  private addTileSplines(ti: number, t: MapTile, group: THREE.Group): void {
    const buckets = new Map<string, SplineMergeBucket>();
    const fallbackPts: THREE.Vector3[] = [];
    // AI dráhy ([path] v .sli) sloučené dle typu (0 auta / 1 chodci / 2 kolej) -
    // overlay vizualizace AI provozu, viditelná dle this.aiVisible.
    const pathByType = new Map<number, number[]>();
    for (let si = 0; si < t.splines.length; si++) {
      const s = t.splines[si];
      const loaded = this.loadedSplines.get(s.path);
      if (loaded) {
        appendSplineGeometry(buckets, loaded, s, t.tileX, t.tileY);
        appendPathLines(pathByType, loaded, s, t.tileX, t.tileY);
      } else {
        // Fallback: osa jako úsečky (dvojice bodů) do sloučené LineSegments.
        const pts = this.splinePoints(t, s);
        for (let k = 0; k < pts.length - 1; k++) { fallbackPts.push(pts[k], pts[k + 1]); }
      }
    }
    const objs: THREE.Object3D[] = buildMergedSplineMeshes(buckets);
    if (fallbackPts.length) {
      const geo = new THREE.BufferGeometry().setFromPoints(fallbackPts);
      objs.push(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: SPLINE_COLOR })));
    }
    for (const o of objs) {
      o.userData = { splineTile: ti };
      group.add(o);
    }
    // LOD: jedna sloučená osová čára celé dlaždice (všechny splajny). Ve vzdáleném
    // pohledu (overview) se místo desítek texturovaných meshů kreslí jen tahle
    // (1 draw call/dlaždici); detail se zapne až po přiblížení. Přepíná
    // updateVisibility podle vzdálenosti kamery. Výběr funguje v obou režimech.
    const lodPts: THREE.Vector3[] = [];
    for (const s of t.splines) {
      const pts = this.splinePoints(t, s, 0.2);
      for (let k = 0; k < pts.length - 1; k++) { lodPts.push(pts[k], pts[k + 1]); }
    }
    if (lodPts.length) {
      const lod = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(lodPts),
        new THREE.LineBasicMaterial({ color: SPLINE_LOD_COLOR })
      );
      lod.userData = { splineTile: ti, splineLod: true };
      lod.visible = false; // výchozí; updateVisibility hned nastaví podle vzdálenosti
      group.add(lod);
      objs.push(lod);
    }
    this.tileSplineMeshes.set(ti, objs);
    // AI overlay dlaždice: čáry drah (přepínatelné přes aiVisible).
    for (const line of buildPathLineMeshes(pathByType)) {
      line.userData = { aiOverlay: true, splineTile: ti };
      line.visible = this.aiVisible;
      group.add(line);
    }
  }

  /** Cílená přestavba splajnů celé dlaždice (po editaci/přesunu splajnu). */
  private updateSplineMesh(tileIndex: number, _splineIndex: number): void {
    if (!this.currentMap) return;
    const tg = this.tileGroups[tileIndex];
    const old = this.tileSplineMeshes.get(tileIndex);
    if (old) {
      for (const o of old) { tg?.group.remove(o); this.disposeObject3D(o); }
    }
    if (tg) this.addTileSplines(tileIndex, this.currentMap.tiles[tileIndex], tg.group);
  }

  /** Viditelné spline meshe (z neskrytých dlaždic) pro raycast výběru. */
  private visibleSplineObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const [ti, objs] of this.tileSplineMeshes) {
      if (this.tileGroups[ti]?.group.visible === false) continue;
      // Jen aktuálně viditelná reprezentace (detail NEBO LOD čára), ať pick
      // nezasáhne skryté meshe a nevybere splajn dvakrát.
      for (const o of objs) if (o.visible !== false) out.push(o);
    }
    return out;
  }

  /**
   * Výběr splajnu: raycast sloučených meshů → nejbližší zásah dá dlaždici, v ní
   * najdeme osu nejbližší k zásahu. Tím zůstává per-spline výběr i při sloučeném
   * renderu (klik na povrch silnice vybere správný splajn).
   */
  private pickSpline(): { tileIndex: number; splineIndex: number } | null {
    const hits = this.raycaster.intersectObjects(this.visibleSplineObjects(), false);
    if (!hits.length) return null;
    const ti = (hits[0].object.userData as { splineTile?: number }).splineTile;
    if (ti == null) return null;
    const si = this.nearestSplineInTile(ti, hits[0].point);
    return si < 0 ? null : { tileIndex: ti, splineIndex: si };
  }

  /** Index splajnu dlaždice, jehož osa je nejblíž bodu `p` (world). -1 když žádný. */
  private nearestSplineInTile(tileIndex: number, p: THREE.Vector3): number {
    const t = this.currentMap?.tiles[tileIndex];
    if (!t) return -1;
    let bestI = -1, bestD = Infinity;
    for (let si = 0; si < t.splines.length; si++) {
      const pts = this.splinePoints(t, t.splines[si], 0);
      for (let k = 0; k < pts.length - 1; k++) {
        const d = distPointToSegment(p, pts[k], pts[k + 1]);
        if (d < bestD) { bestD = d; bestI = si; }
      }
    }
    return bestI;
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
    // Per-instance velikost stromu (přirozený les): škáluj billboard podle přepisu
    // výšky/poměru proti základnímu rozměru ze .sco. Jen stromy s přepisem.
    if (o.treeHeight) {
      const base = this.loadedModels.get(o.path)?.treeBase;
      if (base && base.height > 0) {
        const sy = o.treeHeight / base.height;
        const or = o.treeRatio && o.treeRatio > 0 ? o.treeRatio : base.ratio;
        const sxz = base.ratio > 0 ? (o.treeHeight * or) / (base.height * base.ratio) : sy;
        m.multiply(this._rTmp.makeScale(sxz, sy, sxz));
      }
    }
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
    // Vzdálenost objektu je měřená od začátku CELÉHO řetězce (přes dlaždice).
    // Počáteční splajn na této dlaždici začíná v řetězci na své chainOffset, takže
    // v lokálních souřadnicích řetězce (od začátku tohoto splajnu) je objekt j na
    // d0 + j·interval. Objekty se zápornou vzdáleností leží na předchozí dlaždici
    // (kreslí je její repeater), objekty za koncem splajnů této dlaždice na další
    // (přesně jako OMSI - chain se nechodí přes hranice dlaždic). Viz openOMSI
    // omsi-world map_index::tile_row_objects (d0 = offset.start − chain_offset).
    const startSpline = t.splines[a.splineIndex];
    const chainOffset = startSpline ? startSpline.chainOffset : 0;
    const d0 = a.startDist - chainOffset;
    const interval = Math.max(a.interval, 0);
    const dists: number[] = [];
    if (interval <= 1e-6) dists.push(d0);
    else {
      const n = Math.min(4096, Math.floor(Math.max(a.range, 0) / interval + 1e-6));
      for (let j = 0; j <= n; j++) dists.push(d0 + j * interval);
    }
    for (const dChain of dists) {
      // objekty před začátkem tohoto splajnu patří předchozí dlaždici
      if (dChain < -1e-6) continue;
      // najdi splajn v řetězci (v rámci dlaždice) a lokální vzdálenost
      let acc = 0, guard = 0, local = -1;
      let sp: MapSpline | undefined = startSpline;
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
  /** Světová výška (osa Y) základny objektu - absolutní z, nebo terén + z. */
  private objBaseY(t: MapTile, o: MapObject): number {
    return this.isAbsolute(o.path) ? o.z : tileHeight(t, o.x, o.y) + o.z;
  }

  /** Kolikrát se základní terénní textura zopakuje přes dlaždici (~18 m/dlaždici). */
  private static readonly GROUND_REPEAT = 16;

  /**
   * Materiál terénu: pokud je načtená základní ground textura (tráva),
   * použije ji (bílá barva + dlaždicově), jinak plná zeleň jako fallback.
   * Textura je sdílená (userData.shared na meshi ji chrání před disposem).
   */
  private groundMaterial(lightmap?: THREE.Texture): THREE.MeshStandardMaterial {
    const mat = this.groundTexture
      ? new THREE.MeshStandardMaterial({ map: this.groundTexture, color: 0xffffff, roughness: 1, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: 0x47553a, roughness: 1, side: THREE.DoubleSide });
    if (lightmap) { mat.lightMap = lightmap; mat.lightMapIntensity = 1.0; }
    return mat;
  }

  private buildTerrain(t: MapTile): THREE.Mesh {
    const terr = t.terrain!;
    const n = terr.size;
    const step = TILE_SIZE / (n - 1);
    const rep = Viewport.GROUND_REPEAT;
    const positions = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const uv1 = new Float32Array(n * n * 2); // 0..1 přes dlaždici - pro lightmapu
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const w = worldPos(t.tileX, t.tileY, i * step, j * step, terr.heights[idx]);
      positions[idx * 3] = w.x; positions[idx * 3 + 1] = w.y; positions[idx * 3 + 2] = w.z;
      uvs[idx * 2] = (i / (n - 1)) * rep; uvs[idx * 2 + 1] = (j / (n - 1)) * rep;
      uv1[idx * 2] = i / (n - 1); uv1[idx * 2 + 1] = j / (n - 1);
    }
    const indices: number[] = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i, d = (j + 1) * n + i + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const lm = this.lightmaps.get(t.fileName);
    const m = new THREE.Mesh(geo, this.groundMaterial(lm));
    m.userData.ground = true;
    if (this.groundTexture || lm) m.userData.sharedTex = true;
    return m;
  }

  private splinePoints(t: MapTile, s: MapSpline, lift = 0.3): THREE.Vector3[] {
    return splineCenterline(s, t.tileX, t.tileY, (lx, ly) => tileHeight(t, lx, ly), lift);
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
      // Per-dlaždicové pickables (tileIndex>=0): přeskoč skryté dlaždice. Globální
      // instanced meshe (tileIndex=-1) pokrývají víc dlaždic → viditelnost se řeší
      // až u konkrétního zásahu níže.
      if (pk.tileIndex >= 0 && this.tileGroups[pk.tileIndex]?.group.visible === false) continue;
      const hits = this.raycaster.intersectObject(pk.mesh);
      for (const h of hits) {
        if (h.instanceId != null) {
          const hit = pk.map[h.instanceId];
          // Objekt na skryté (cullované) dlaždici nelze vybrat.
          if (this.tileGroups[hit.tileIndex]?.group.visible === false) break;
          if (!best || h.distance < best.dist) best = { dist: h.distance, hit };
        }
        break;
      }
    }
    return best?.hit ?? null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.currentMap) return;
    // Klik na rukojeť gizma (hover/drag) obsluhuje TransformControls - neruš výběr
    // ani nespouštěj tažení přes rovinu.
    if (this.gizmo?.enabled && (this.gizmo.dragging || this.gizmo.axis)) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.placePath) {
      const p = this.raycastGround();
      if (p) this.placeObjectAt(p);
      return;
    }
    if (this.tool === "road") {
      const p = this.raycastGround();
      if (p) this.roadClick(p);
      else this.onStatus?.("Klikni na terén.", true);
      return;
    }
    if (this.tool === "terrain") {
      this.terrainStroke = true;
      this.flattenSampled = false;
      this.controls.enabled = false;
      const p = this.raycastGround();
      if (p) this.applyTerrainBrush(p);
      return;
    }
    if (this.tool === "erase") {
      const hit = this.pickObject();
      if (hit) { this.eraseAt(hit.tileIndex, "object", hit.objectIndex); return; }
      const sHit = this.pickSpline();
      if (sHit) {
        this.eraseAt(sHit.tileIndex, "spline", sHit.splineIndex);
      } else this.onStatus?.("Guma: klikni přímo na objekt nebo spline.", true);
      return;
    }
    if (this.tool === "paint") {
      this.paintStroke = true;
      this.controls.enabled = false;
      const p = this.raycastGround();
      if (p) this.applyPaintBrush(p);
      return;
    }

    const objHit = this.pickObject();
    if (objHit) {
      const object = this.currentMap.tiles[objHit.tileIndex].objects[objHit.objectIndex];
      this.selectObject(objHit.tileIndex, objHit.objectIndex, object);
      const t = this.currentMap.tiles[objHit.tileIndex];
      this.dragging = "object"; this.dragMoved = false; this.controls.enabled = false;
      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.beginEdit(objHit.tileIndex);
      this.dragPlane.constant = -(this.objBaseY(t, object) + OBJ_H);
      return;
    }

    const sHit = this.pickSpline();
    if (sHit) {
      const { tileIndex, splineIndex } = sHit;
      const spline = this.currentMap.tiles[tileIndex].splines[splineIndex];
      this.selectSpline(tileIndex, splineIndex, spline);
      this.dragging = "spline"; this.dragMoved = false; this.controls.enabled = false;
      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.beginEdit(tileIndex);
      // Splajn se kreslí v absolutní výšce s.z (bez terénu) - rovina tažení taky.
      this.dragPlane.constant = -spline.z;
      return;
    }
    this.clearSelection(true);
  };

  private onPointerMove = (e: PointerEvent) => {
    if ((this.terrainStroke || this.paintStroke) && this.currentMap) {
      this.updatePointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const p = this.raycastGround();
      if (p) { if (this.terrainStroke) this.applyTerrainBrush(p); else this.applyPaintBrush(p); }
      return;
    }
    if (!this.dragging || !this.selection || !this.currentMap) return;
    // Práh: dokud se kurzor neposune dost daleko, ber to jako klik (ne tažení) -
    // jinak by i nepatrný pohyb při výběru označil dlaždici jako změněnou.
    if (!this.dragMoved && this.dragStartScreen) {
      const dpx = Math.hypot(e.clientX - this.dragStartScreen.x, e.clientY - this.dragStartScreen.y);
      if (dpx < Viewport.DRAG_THRESHOLD_PX) return;
    }
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
    if (this.terrainStroke) { this.endTerrainStroke(); return; }
    if (this.paintStroke) { this.paintStroke = false; this.controls.enabled = true; this.onStatus?.("Povrch namalován."); return; }
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
      this.commitEdit(); // jeden záznam historie za celé tažení
      this.onChange?.(sel);
    } else {
      this.pendingBefore = null; // klik bez tažení - žádná editace
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
    this.beginEdit(tileIndex);
    const newObj = createObject(t, this.placePath, maxId(this.currentMap) + 1, lx, ly, 0, templateSection);
    const objectIndex = t.objects.indexOf(newObj);
    const placedPath = this.placePath;
    this.placePath = null; this.renderer.domElement.style.cursor = "";
    this.build();
    this.commitEdit();
    this.selectObject(tileIndex, objectIndex, newObj);
    this.onStatus?.("Objekt přidán.");
    this.onChange?.(this.selection);
    // Kdyby model ještě nebyl v cache (rychlý klik), dotáhni ho a přestav.
    void this.ensureModel(placedPath);
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
    // Po přestavbě / tažení dorovnej i proxy gizma, ať zůstane na prvku.
    if (this.selection && this.gizmo?.enabled && !this.gizmo.dragging) this.syncGizmo();
  }

  private selectObject(tileIndex: number, objectIndex: number, object: MapObject) {
    this.removeOverlay();
    this.selection = { kind: "object", tileIndex, objectIndex, object };
    this.moveHighlightToObject(this.selection);
    this.attachGizmo();
    this.onSelect?.(this.selection);
  }
  private selectSpline(tileIndex: number, splineIndex: number, spline: MapSpline) {
    this.highlight.visible = false;
    this.selection = { kind: "spline", tileIndex, splineIndex, spline };
    this.setOverlay(tileIndex, splineIndex);
    this.attachGizmo();
    this.onSelect?.(this.selection);
  }
  private clearSelection(emit: boolean) {
    this.removeOverlay();
    this.highlight.visible = false; this.selection = null;
    this.detachGizmo();
    if (emit) this.onSelect?.(null);
  }

  // ---------- Veřejné akce ----------

  getSelection(): Selection | null { return this.selection; }
  setPlaceMode(path: string | null) {
    if (path) this.clearTools();
    this.placePath = path;
    void this.ensureModel(path); // přednačti model, ať se objekt po kliknutí hned zobrazí
    if (path) this.detachGizmo(); else this.attachGizmo();
    this.renderer.domElement.style.cursor = path ? "crosshair" : "";
    this.onStatus?.(path ? `Umísťování: klikni na terén (${path.split("\\").pop()}). Esc zruší.` : "Umísťování zrušeno.");
    this.emitTool();
  }
  isPlacing(): boolean { return this.placePath != null; }

  // ---------- Nástroj: Stavba silnic ----------

  /** Zapne/vypne stavbu silnic se zvoleným .sli profilem. */
  setRoadMode(path: string | null) {
    this.placePath = null;
    this.tool = path ? "road" : null;
    this.roadPath = path;
    this.roadStart = null;
    this.lastRoad = null;
    this.roadHeading = null;
    void this.ensureSpline(path); // přednačti profil splajnu, ať silnice není jen žlutá čára
    if (path) this.detachGizmo(); else this.attachGizmo();
    this.renderer.domElement.style.cursor = path ? "crosshair" : "";
    this.onStatus?.(path
      ? `Stavba silnic (${path.split("\\").pop()}): klikni začátek a pak konec segmentu. Esc ukončí.`
      : "Stavba silnic ukončena.");
    this.emitTool();
  }
  isToolActive(): boolean { return this.tool != null || this.placePath != null; }
  /** Zruší všechny nástroje (výběr zůstává). */
  clearTools() {
    this.tool = null; this.roadPath = null; this.roadStart = null; this.lastRoad = null; this.roadHeading = null;
    this.placePath = null;
    if (this.terrainStroke) this.endTerrainStroke();
    this.terrainStroke = false; this.paintStroke = false;
    this.renderer.domElement.style.cursor = "";
    this.attachGizmo(); // obnov gizmo na vybraném prvku (pokud nějaký je)
    this.emitTool();
  }

  /** Jedno kliknutí v režimu stavby silnic: 1. klik = začátek, 2. = konec segmentu. */
  private roadClick(p: THREE.Vector3) {
    if (!this.currentMap || !this.roadPath) return;
    const wx = p.x, wy = -p.z; // mapové světové souřadnice
    if (!this.roadStart) {
      this.roadStart = { wx, wy };
      this.roadHeading = null; // nový řetězec začíná rovně
      this.lastRoad = null;
      this.onStatus?.("Začátek nastaven - klikni další bod. Silnice plynule zatáčí.");
      return;
    }
    const x0 = this.roadStart.wx, y0 = this.roadStart.wy;
    const dx = wx - x0, dy = wy - y0;
    const chord = Math.hypot(dx, dy);
    if (chord < 1) { this.onStatus?.("Segment je příliš krátký.", true); return; }

    // Heading (°) tětivy ke kliknutému konci (stejná konvence jako splines.ts:
    // směr = (sin h, cos h), h z atan2(dx,dy)).
    const beta = Math.atan2(dx, dy);
    let heading: number;   // azimut na začátku segmentu (°)
    let radius: number;    // poloměr oblouku (0 = rovně); +R zatáčí doprava
    let length: number;    // délka po ose (m)
    let endHeading: number; // azimut tečny na konci (°) → start dalšího segmentu
    if (this.roadHeading == null) {
      // První segment: rovný ve směru kliknutí.
      heading = beta;
      radius = 0;
      length = chord;
      endHeading = beta;
    } else {
      const th0 = THREE.MathUtils.degToRad(this.roadHeading);
      // Úhel mezi počáteční tečnou a tětivou, normalizovaný do (−π, π].
      let alpha = beta - th0;
      alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
      heading = this.roadHeading;
      if (Math.abs(alpha) < 1e-3) {
        radius = 0; length = chord; endHeading = this.roadHeading;
      } else if (Math.abs(alpha) > 2.7) {
        // Ostré otočení (klik skoro dozadu) → oblouk by byl degenerovaný; udělej
        // rovný segment přímo k bodu (naruší plynulost, ale chová se očekávaně).
        heading = beta; radius = 0; length = chord; endHeading = beta;
      } else {
        // Kruhový oblouk tečný na předchozí segment, procházející kliknutým bodem:
        // tětiva c = 2R·sin α, délka oblouku L = c·α/sin α, otočení Δ = 2α.
        radius = chord / (2 * Math.sin(alpha));
        length = (chord * alpha) / Math.sin(alpha);
        endHeading = THREE.MathUtils.radToDeg(th0 + 2 * alpha);
      }
    }
    heading = ((heading % 360) + 360) % 360;
    endHeading = ((endHeading % 360) + 360) % 360;

    const tileX = Math.floor(x0 / TILE_SIZE), tileY = Math.floor(y0 / TILE_SIZE);
    const tileIndex = this.currentMap.tiles.findIndex((t) => t.tileX === tileX && t.tileY === tileY);
    if (tileIndex < 0) { this.onStatus?.("Začátek není na dlaždici mapy.", true); return; }
    const t = this.currentMap.tiles[tileIndex];
    const lx = round3(x0 - tileX * TILE_SIZE), ly = round3(y0 - tileY * TILE_SIZE);
    const z = round3(tileHeight(t, lx, ly));
    const newId = maxId(this.currentMap) + 1;
    const prevId = this.lastRoad?.spline.id ?? 0;
    const template = findTemplateSpline(this.currentMap, this.roadPath) ?? undefined;
    this.beginEdit(tileIndex);
    const sp = createSpline(t, this.roadPath, newId, lx, ly, z, round3(heading), round3(length), round3(radius), prevId, 0, template);
    // Zřetězení: předchozí segment ukazuje na nový.
    if (this.lastRoad) setSplineNext(this.currentMap.tiles[this.lastRoad.tileIndex], this.lastRoad.spline, newId);
    this.build();
    void this.ensureSpline(this.roadPath); // dotáhni profil, pokud ještě není v cache
    this.commitEdit();
    this.lastRoad = { tileIndex, spline: sp };
    this.roadStart = { wx, wy };      // navazuj z konce
    this.roadHeading = endHeading;    // další segment začne tečně (→ plynulé zatáčky)
    this.onChange?.(null);
    const kind = radius === 0 ? "rovný" : `oblouk R=${Math.abs(radius).toFixed(0)} m`;
    this.onStatus?.(`Segment přidán (${kind}, délka ${length.toFixed(1)} m). Klikni další bod, nebo Esc.`);
  }

  // ---------- Nástroj: Úprava terénu ----------

  /** Zapne úpravu terénu danou operací (null = vypnout). */
  setTerrainMode(op: "raise" | "lower" | "flatten" | "smooth" | null) {
    this.placePath = null; this.roadPath = null; this.roadStart = null; this.lastRoad = null;
    this.tool = op ? "terrain" : null;
    if (op) this.terrainOp = op;
    if (op) this.detachGizmo(); else this.attachGizmo();
    this.renderer.domElement.style.cursor = op ? "crosshair" : "";
    const label: Record<string, string> = { raise: "zvýšit", lower: "snížit", flatten: "vyrovnat", smooth: "vyhladit" };
    this.onStatus?.(op
      ? `Úprava terénu (${label[op]}, štětec ${this.brushRadius} m): táhni po terénu. Esc ukončí.`
      : "Úprava terénu ukončena.");
    this.emitTool();
  }
  setBrush(radius?: number, strength?: number) {
    if (radius != null && radius > 0) this.brushRadius = radius;
    if (strength != null && strength > 0) this.brushStrength = strength;
  }

  // ---------- Nástroj: Guma (mazání klikem) ----------

  /** Zapne/vypne gumu: klik na objekt/spline ho smaže. */
  setEraseMode(on: boolean) {
    this.placePath = null; this.roadPath = null; this.roadStart = null; this.lastRoad = null;
    this.tool = on ? "erase" : null;
    if (on) this.detachGizmo(); else this.attachGizmo();
    this.renderer.domElement.style.cursor = on ? "crosshair" : "";
    this.onStatus?.(on ? "Guma: klikni na objekt nebo spline a smažeš ho. Esc ukončí." : "Guma ukončena.");
    this.emitTool();
  }

  /** Smaže prvek na daném indexu (jeden záznam historie). */
  private eraseAt(tileIndex: number, kind: "object" | "spline", index: number) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[tileIndex];
    this.clearSelection(false);
    this.beginEdit(tileIndex);
    if (kind === "object") deleteObject(t, t.objects[index]);
    else deleteSpline(t, t.splines[index]);
    this.build();
    this.commitEdit();
    this.onSelect?.(null);
    this.onChange?.(null);
    this.onStatus?.("Smazáno.");
  }

  /** Aplikuje štětec výšky v bodě (world) na všechny dotčené dlaždice s terénem. */
  private applyTerrainBrush(p: THREE.Vector3) {
    if (!this.currentMap) return;
    const wx = p.x, wy = -p.z;
    const r = this.brushRadius, r2 = r * r;
    const op = this.terrainOp;
    // „Vyrovnat" sejme cílovou výšku z místa prvního kliknutí tahu.
    if (op === "flatten" && !this.flattenSampled) { this.flattenTarget = p.y; this.flattenSampled = true; }
    const amt = (op === "raise" ? 1 : -1) * this.brushStrength;
    for (let ti = 0; ti < this.currentMap.tiles.length; ti++) {
      const t: MapTile = this.currentMap.tiles[ti];
      if (!t.terrain) continue;
      const ox = t.tileX * TILE_SIZE, oy = t.tileY * TILE_SIZE;
      if (wx + r < ox || wx - r > ox + TILE_SIZE || wy + r < oy || wy - r > oy + TILE_SIZE) continue;
      const n: number = t.terrain.size;
      const step = TILE_SIZE / (n - 1);
      const heights = t.terrain.heights as Float32Array | number[];
      // U vyhlazení čti ze snímku (jinak by směr průchodu zkresloval průměr).
      const snap = op === "smooth" ? Float32Array.from(heights as number[]) : null;
      let changed = false;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const dx = ox + i * step - wx, dy = oy + j * step - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2);
        const fall = 0.5 * (1 + Math.cos(Math.PI * d / r)); // 1 ve středu → 0 na okraji
        const k = j * n + i;
        const h = heights[k] as number;
        if (op === "raise" || op === "lower") {
          heights[k] = h + amt * fall;
        } else if (op === "flatten") {
          const f = Math.min(1, this.brushStrength * 0.2 * fall);
          heights[k] = h + (this.flattenTarget - h) * f;
        } else { // smooth
          const s = snap!;
          let sum = 0, cnt = 0;
          if (i > 0) { sum += s[k - 1]; cnt++; }
          if (i < n - 1) { sum += s[k + 1]; cnt++; }
          if (j > 0) { sum += s[k - n]; cnt++; }
          if (j < n - 1) { sum += s[k + n]; cnt++; }
          if (cnt) { const avg = sum / cnt; const f = Math.min(1, this.brushStrength * 0.2 * fall); heights[k] = h + (avg - h) * f; }
        }
        changed = true;
      }
      if (changed) { t.dirty = true; this.terrainTouched.add(ti); this.updateTerrainMesh(ti); }
    }
  }

  /** Živě přepíše pozice + normály terénního meshe dlaždice z aktuálních výšek. */
  private updateTerrainMesh(ti: number) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[ti];
    const mesh = this.terrainMeshes.get(ti);
    if (!t.terrain || !mesh) return;
    const n = t.terrain.size, step = TILE_SIZE / (n - 1);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const w = worldPos(t.tileX, t.tileY, i * step, j * step, t.terrain.heights[idx] as number);
      pos.setXYZ(idx, w.x, w.y, w.z);
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
  }

  /** Konec tahu úpravy terénu: přestav scénu (objekty dosednou na nový terén). */
  private endTerrainStroke() {
    this.terrainStroke = false;
    this.controls.enabled = true;
    if (this.terrainTouched.size) {
      this.terrainTouched.clear();
      this.build();
      this.onChange?.(null);
      this.onStatus?.("Terén upraven. (Objekty dosedly na nový terén.)");
    }
  }

  // ---------- Nástroj: Malování povrchu (dlažba, cesty) ----------

  /** Zapne malování povrchu zvolenou detailní texturou (groundtex nebo cesta). */
  async setPaintMode(texPath: string | null) {
    this.placePath = null; this.roadPath = null; this.tool = texPath ? "paint" : null;
    if (texPath) this.detachGizmo(); else this.attachGizmo();
    this.renderer.domElement.style.cursor = texPath ? "crosshair" : "";
    this.emitTool();
    if (!texPath) { this.onStatus?.("Malování povrchu ukončeno."); return; }
    // načti texturu (relativní ke kořeni OMSI - groundtex)
    this.paintTexture = null;
    if (this.assetSrc) {
      try {
        const buf = await this.assetSrc.readFile(texPath);
        if (buf) {
          const tex = decodeTexture(texPath, buf);
          if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4; this.paintTexture = tex; }
        }
      } catch { /* ignore */ }
    }
    this.onStatus?.(`Malování povrchu (${texPath.split("\\").pop()}, štětec ${this.brushRadius} m): táhni po terénu. Esc ukončí.`);
  }

  /** Geometrie terénu dlaždice s volitelným zvednutím (pro malovaný overlay). */
  private terrainGeometry(t: MapTile, lift: number): THREE.BufferGeometry {
    const terr = t.terrain!;
    const n = terr.size, step = TILE_SIZE / (n - 1), rep = Viewport.GROUND_REPEAT;
    const pos = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2), uv1 = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const w = worldPos(t.tileX, t.tileY, i * step, j * step, (terr.heights[idx] as number) + lift);
      pos[idx * 3] = w.x; pos[idx * 3 + 1] = w.y; pos[idx * 3 + 2] = w.z;
      uvs[idx * 2] = (i / (n - 1)) * rep; uvs[idx * 2 + 1] = (j / (n - 1)) * rep;
      uv1[idx * 2] = i / (n - 1); uv1[idx * 2 + 1] = j / (n - 1);
    }
    const indices: number[] = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i, d = (j + 1) * n + i + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /** Perzistentní maska dlaždice (canvas); vytvoří on-demand. */
  private getPaintMask(ti: number): HTMLCanvasElement | null {
    if (!this.currentMap?.tiles[ti]?.terrain) return null;
    let canvas = this.paintMasks.get(ti);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = canvas.height = Viewport.PAINT_RES;
      this.paintMasks.set(ti, canvas);
    }
    return canvas;
  }
  /** Zajistí overlay mesh v aktuální scéně pro dlaždici (z její masky). */
  private ensurePaintOverlay(ti: number): { tex: THREE.CanvasTexture; mesh: THREE.Mesh } | null {
    let layer = this.paintLayers.get(ti);
    if (layer) return layer;
    const t = this.currentMap?.tiles[ti];
    const canvas = this.paintMasks.get(ti);
    if (!t || !t.terrain || !canvas || !this.paintTexture) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.channel = 1; // alphaMap používá uv1 (0..1 přes dlaždici)
    const mat = new THREE.MeshStandardMaterial({
      map: this.paintTexture, alphaMap: tex, transparent: true, depthWrite: false,
      roughness: 1, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.terrainGeometry(t, 0.12), mat);
    mesh.renderOrder = 2; // nad terénem i silnicemi
    const group = this.tileGroups[ti]?.group;
    if (group) group.add(mesh);
    layer = { tex, mesh };
    this.paintLayers.set(ti, layer);
    return layer;
  }
  /** Po přestavbě scény znovu vytvoří overlay vrstvy ze všech masek. */
  private rebuildPaintOverlays() {
    this.paintLayers.clear();
    if (!this.paintTexture) return;
    for (const ti of this.paintMasks.keys()) this.ensurePaintOverlay(ti);
  }

  /** Namaluje do masky dlaždic v dosahu štětce. */
  private applyPaintBrush(p: THREE.Vector3) {
    if (!this.currentMap) return;
    const wx = p.x, wy = -p.z, r = this.brushRadius, R = Viewport.PAINT_RES;
    for (let ti = 0; ti < this.currentMap.tiles.length; ti++) {
      const t = this.currentMap.tiles[ti];
      if (!t.terrain) continue;
      const ox = t.tileX * TILE_SIZE, oy = t.tileY * TILE_SIZE;
      if (wx + r < ox || wx - r > ox + TILE_SIZE || wy + r < oy || wy - r > oy + TILE_SIZE) continue;
      const canvas = this.getPaintMask(ti);
      if (!canvas) continue;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const cx = ((wx - ox) / TILE_SIZE) * R, cy = ((wy - oy) / TILE_SIZE) * R, cr = (r / TILE_SIZE) * R;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(cr, 1));
      grad.addColorStop(0, "rgba(255,255,255,0.4)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(cr, 1), 0, Math.PI * 2); ctx.fill();
      const layer = this.ensurePaintOverlay(ti);
      if (layer) layer.tex.needsUpdate = true;
    }
  }

  focusObject(tileIndex: number, objectIndex: number) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[tileIndex], o = t.objects[objectIndex];
    this.selectObject(tileIndex, objectIndex, o);
    const p = worldPos(t.tileX, t.tileY, o.x, o.y, this.objBaseY(t, o));
    this.controls.target.copy(p);
    this.camera.position.set(p.x + 40, p.y + 55, p.z + 40);
  }

  // ---------- Undo / redo ----------

  private cloneSections(t: MapTile): OmsiSection[] {
    return t.sections.map((s) => ({ name: s.name, values: [...s.values] }));
  }
  /** Zahájí editaci dlaždice: uloží její sekce PŘED změnou (jen jednou do commitu). */
  private beginEdit(tileIndex: number) {
    if (!this.currentMap) return;
    if (this.pendingBefore) return; // už probíhá (např. během dragu)
    this.pendingBefore = { tileIndex, sections: this.cloneSections(this.currentMap.tiles[tileIndex]) };
  }
  /** Dokončí editaci: uloží sekce PO změně a vytvoří záznam historie. */
  private commitEdit() {
    if (!this.pendingBefore || !this.currentMap) return;
    const { tileIndex, sections: before } = this.pendingBefore;
    this.pendingBefore = null;
    const after = this.cloneSections(this.currentMap.tiles[tileIndex]);
    // Přeskoč no-op (sekce se nezměnily).
    if (before.length === after.length &&
        before.every((s, i) => s.name === after[i].name && s.values.join("\u0001") === after[i].values.join("\u0001"))) {
      return;
    }
    this.undoStack.push({ tileIndex, before, after });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.onHistory?.();
  }
  private applySnapshot(tileIndex: number, sections: OmsiSection[]) {
    if (!this.currentMap) return;
    const t = this.currentMap.tiles[tileIndex];
    t.sections = sections.map((s) => ({ name: s.name, values: [...s.values] }));
    t.dirty = true;
    deriveTile(t); // přepočítá odvozený pohled (objekty/splajny/…) z obnovených sekcí
    this.clearSelection(false); // indexy výběru mohou být po obnově neplatné
    this.build();
    this.onSelect?.(null);
    this.onChange?.(null);
    this.onHistory?.();
  }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): boolean {
    const rec = this.undoStack.pop();
    if (!rec) return false;
    this.applySnapshot(rec.tileIndex, rec.before);
    this.redoStack.push(rec);
    return true;
  }
  redo(): boolean {
    const rec = this.redoStack.pop();
    if (!rec) return false;
    this.applySnapshot(rec.tileIndex, rec.after);
    this.undoStack.push(rec);
    return true;
  }
  private clearHistory() {
    this.undoStack = []; this.redoStack = []; this.pendingBefore = null;
    this.onHistory?.();
  }

  setSelectedObjectField(field: ObjField, value: number) {
    if (this.selection?.kind !== "object" || !this.currentMap) return;
    if (!this.dragging) this.beginEdit(this.selection.tileIndex);
    setObjectField(this.currentMap.tiles[this.selection.tileIndex], this.selection.object, field, value);
    // Cílený přesun instance; jen pokud objekt není instancovaný (box), přestav vše.
    if (!this.updateObjectInstance(this.selection.tileIndex, this.selection.objectIndex)) this.build();
    this.restoreSelectionVisual();
    if (!this.dragging) this.commitEdit();
    this.onChange?.(this.selection);
  }
  setSelectedSplineField(field: SplField, value: number) {
    if (this.selection?.kind !== "spline" || !this.currentMap) return;
    if (!this.dragging) this.beginEdit(this.selection.tileIndex);
    setSplineField(this.currentMap.tiles[this.selection.tileIndex], this.selection.spline, field, value);
    this.updateSplineMesh(this.selection.tileIndex, this.selection.splineIndex);
    this.restoreSelectionVisual();
    if (!this.dragging) this.commitEdit();
    this.onChange?.(this.selection);
  }
  /** Jemný posun výběru o (dx,dy) v lokálních metrech dlaždice (šipky). Jen jedna
   *  osa je nenulová → jeden záznam historie na stisk. */
  nudgeSelected(dx: number, dy: number) {
    const sel = this.selection;
    if (!sel) return;
    if (sel.kind === "object") {
      if (dx) this.setSelectedObjectField("x", round3(sel.object.x + dx));
      if (dy) this.setSelectedObjectField("y", round3(sel.object.y + dy));
    } else {
      if (dx) this.setSelectedSplineField("x", round3(sel.spline.x + dx));
      if (dy) this.setSelectedSplineField("y", round3(sel.spline.y + dy));
    }
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
    const tileIndex = this.selection.tileIndex;
    const t = this.currentMap.tiles[tileIndex];
    this.beginEdit(tileIndex);
    if (this.selection.kind === "object") deleteObject(t, this.selection.object);
    else deleteSpline(t, this.selection.spline);
    this.clearSelection(false);
    this.build();
    this.commitEdit();
    this.onSelect?.(null); this.onChange?.(null);
    return true;
  }
  duplicateSelected() {
    if (this.selection?.kind !== "object" || !this.currentMap) return;
    const tileIndex = this.selection.tileIndex, t = this.currentMap.tiles[tileIndex];
    this.beginEdit(tileIndex);
    const newObj = duplicateObject(t, this.selection.object, maxId(this.currentMap) + 1);
    const newIndex = t.objects.indexOf(newObj);
    this.build();
    this.commitEdit();
    this.selectObject(tileIndex, newIndex, newObj);
    this.onChange?.(this.selection);
  }
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

/** Vzdálenost bodu `p` od úsečky `a`-`b` (3D), pro výběr nejbližší osy splajnu. */
const _segAB = new THREE.Vector3();
const _segAP = new THREE.Vector3();
function distPointToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _segAB.subVectors(b, a);
  const len2 = _segAB.lengthSq();
  let t = 0;
  if (len2 > 1e-9) {
    t = _segAP.subVectors(p, a).dot(_segAB) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = a.x + _segAB.x * t, cy = a.y + _segAB.y * t, cz = a.z + _segAB.z * t;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}
