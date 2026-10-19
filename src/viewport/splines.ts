import * as THREE from "three";
import { TILE_SIZE } from "../omsi/types";
import type { MapSpline } from "../omsi/types";
import { parseSli, PATH_CAR, PATH_PED, PATH_RAIL } from "../omsi/sli";
import type { SliDef, SliPath } from "../omsi/sli";
import {
  decodeTexture, textureCandidates, tryReadNamed, dirOf,
} from "./models";
import type { AssetSource } from "./models";

/**
 * Stavba 3D meshů splajnů (silnice, chodníky, koleje) z .sli profilů.
 *
 * Princip: příčný profil (viz sli.ts) se extruduje podél osy splajnu. Osa je
 * buď rovná úsečka (radius = 0), nebo kruhový oblouk (radius ≠ 0). Výška se
 * mění podle sklonu gradientStart/End (v procentech) a navázání na terén.
 */

/** Jeden „snímek" podél osy splajnu: lokální poloha, výškový přírůstek a příčný vektor. */
export interface SplineFrame {
  /** Lokální poloha osy v rámci dlaždice (metry). */
  lx: number;
  ly: number;
  /** Výškový přírůstek proti s.z daný sklonem (gradientem), metry. */
  hGrad: number;
  /** Jednotkový příčný vektor „vpravo" (lokální XY). */
  rx: number;
  ry: number;
  /** Ujetá vzdálenost od začátku splajnu, metry. */
  d: number;
}

export interface LoadedSpline {
  def: SliDef;
  /** Dekódované textury v pořadí indexů z .sli (null = nenalezeno). */
  textures: (THREE.Texture | null)[];
}

/**
 * Znaménko zakřivení: kappa = SPLINE_DIR / radius. OMSI konvence (ověřeno
 * openOMSI i daty: radius>0 = zatáčí DOPRAVA/po směru hodin): kappa = +1/radius.
 * Ověřeno na návaznosti splajnů - koncový bod sedí na začátek dalšího (Grundorf
 * medián 0.00 m, Lisen 0.00 m; s −1 byl medián 7.45 m → silnice nenavazovaly).
 */
const SPLINE_DIR = 1;

/**
 * Spočítá snímky podél osy splajnu. Pro rovný úsek stačí málo kroků, pro oblouk
 * segmentujeme hustěji. Výška se integruje z lineárně se měnícího sklonu.
 */
export function splineFrames(s: MapSpline, steps: number): SplineFrame[] {
  const az = THREE.MathUtils.degToRad(s.rotZ);
  const L = Math.max(s.length, 1e-4);
  const curved = Math.abs(s.radius) > 1e-4;
  const kappa = curved ? SPLINE_DIR / s.radius : 0; // zakřivení (1/m), se znaménkem
  const sinAz = Math.sin(az), cosAz = Math.cos(az);
  const frames: SplineFrame[] = [];
  for (let i = 0; i <= steps; i++) {
    const d = (L * i) / steps;
    const th = az + kappa * d; // azimut tečny v daném místě
    let lx: number, ly: number;
    if (!curved) {
      lx = s.x + sinAz * d;
      ly = s.y + cosAz * d;
    } else {
      // Integrál tečny (sin,cos) → poloha na oblouku.
      lx = s.x + (cosAz - Math.cos(th)) / kappa;
      ly = s.y + (Math.sin(th) - sinAz) / kappa;
    }
    // Příčný vektor „vpravo" kolmý na tečnu (tečna = (sin th, cos th)).
    const rx = Math.cos(th), ry = -Math.sin(th);
    // Výška nad s.z. [spline_h]: kubika s h'(0)=gS, h'(L)=gE, h(L)=deltaH (přesně
    // navazuje na další splajn). Jinak parabola (integrál lineárního sklonu).
    const g = s.gradientStart / 100, G = s.gradientEnd / 100;
    let hGrad: number;
    if (s.deltaH != null) {
      const dh = s.deltaH;
      const c = (G - g - (2 * (dh - g * L)) / L) / (L * L);
      const b = (dh - g * L) / (L * L) - c * L;
      hGrad = g * d + b * d * d + c * d * d * d;
    } else {
      hGrad = (s.gradientStart * d + ((s.gradientEnd - s.gradientStart) * d * d) / (2 * L)) / 100;
    }
    frames.push({ lx, ly, hGrad, rx, ry, d });
  }
  return frames;
}

/** Jeden vzorek na ose splajnu ve vzdálenosti `d`: lokální poloha, výška (s.z+sklon),
 *  příčný vektor „vpravo" a směr tečny (OMSI heading, stupně). Pro umístění řad objektů. */
export interface SplineSample {
  lx: number; ly: number; worldY: number; rx: number; ry: number; headingDeg: number;
}
export function splineSampleAt(s: MapSpline, d: number): SplineSample {
  const az = THREE.MathUtils.degToRad(s.rotZ);
  const L = Math.max(s.length, 1e-4);
  const dd = Math.min(Math.max(d, 0), L);
  const curved = Math.abs(s.radius) > 1e-4;
  const kappa = curved ? SPLINE_DIR / s.radius : 0;
  const th = az + kappa * dd;
  let lx: number, ly: number;
  if (!curved) { lx = s.x + Math.sin(az) * dd; ly = s.y + Math.cos(az) * dd; }
  else { lx = s.x + (Math.cos(az) - Math.cos(th)) / kappa; ly = s.y + (Math.sin(th) - Math.sin(az)) / kappa; }
  const rx = Math.cos(th), ry = -Math.sin(th);
  const g = s.gradientStart / 100, G = s.gradientEnd / 100;
  let hGrad: number;
  if (s.deltaH != null) {
    const dh = s.deltaH;
    const c = (G - g - (2 * (dh - g * L)) / L) / (L * L);
    const b = (dh - g * L) / (L * L) - c * L;
    hGrad = g * dd + b * dd * dd + c * dd * dd * dd;
  } else {
    hGrad = (s.gradientStart * dd + ((s.gradientEnd - s.gradientStart) * dd * dd) / (2 * L)) / 100;
  }
  return { lx, ly, worldY: s.z + hGrad, rx, ry, headingDeg: THREE.MathUtils.radToDeg(th) };
}

/** Vhodný počet segmentů podél splajnu podle délky a zakřivení. */
export function splineSteps(s: MapSpline): number {
  if (Math.abs(s.radius) > 1e-4) {
    return Math.min(256, Math.max(8, Math.ceil(s.length / 2.5)));
  }
  return Math.min(128, Math.max(1, Math.ceil(s.length / 8)));
}

/** Body osy splajnu ve světových souřadnicích (pro výběrovou čáru i fallback). */
export function splineCenterline(
  s: MapSpline, tileX: number, tileY: number,
  _heightAt: (lx: number, ly: number) => number, lift = 0.15
): THREE.Vector3[] {
  // POZOR: s.z je ABSOLUTNÍ výška splajnu (≈ výška terénu, který je k silnici
  // zarovnán), ne offset nad terén. Výška terénu se NEPŘIČÍTÁ (jinak levituje).
  const frames = splineFrames(s, splineSteps(s));
  return frames.map((f) => new THREE.Vector3(
    tileX * TILE_SIZE + f.lx,
    s.z + f.hGrad + lift,
    -(tileY * TILE_SIZE + f.ly)
  ));
}

/** Načte .sli a jeho textury. Vrátí null, když soubor chybí nebo nemá profil. */
export async function loadSpline(src: AssetSource, sliPath: string): Promise<LoadedSpline | null> {
  const buf = await src.readFile(sliPath);
  if (!buf) return null;
  const def = parseSli(new TextDecoder("windows-1252").decode(buf));
  // Drž definici i když nemá grafický profil, ale má AI dráhy ([path]) -
  // neviditelné splajny (invis_sidewalk, pěší/busové dráhy) musí jít zobrazit
  // v AI overlay. Bez profilu i bez drah nemá smysl (→ fallback žlutá čára).
  if (!def.profiles.length && !def.paths.length) return null;
  const dir = dirOf(sliPath);
  const textures: (THREE.Texture | null)[] = [];
  for (const texName of def.textures) {
    if (!texName) { textures.push(null); continue; }
    const found = await tryReadNamed(src, textureCandidates(dir, texName));
    let tex: THREE.Texture | null = null;
    if (found) {
      tex = decodeTexture(found.name, found.buf);
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
      }
    }
    textures.push(tex);
  }
  return { def, textures };
}

const ASPHALT: [number, number, number] = [0.33, 0.34, 0.36];

/** Vytvoří materiál pro splajn (šedý asfalt, když textura chybí; helper poloprůhledně). */
function splineMaterialFor(tex: THREE.Texture | null, onlyEditor: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(ASPHALT[0], ASPHALT[1], ASPHALT[2]),
    roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
  if (tex) {
    mat.map = tex;
    mat.color.setRGB(1, 1, 1);
    mat.needsUpdate = true;
  }
  // Pomocné splajny (neviditelné ve hře) kreslíme poloprůhledně jako helper.
  if (onlyEditor) {
    mat.transparent = true;
    mat.opacity = 0.35;
    mat.depthWrite = false;
  }
  return mat;
}

/**
 * Kbelík sloučené geometrie splajnů jedné dlaždice, klíčovaný podle textury
 * (+ helper flag). Sem se extruduje profil mnoha splajnů dlaždice, aby celá
 * dlaždice byla jen pár draw callů místo tisíců samostatných meshů.
 */
export interface SplineMergeBucket {
  tex: THREE.Texture | null;
  onlyEditor: boolean;
  pos: number[];
  uv: number[];
  idx: number[];
}

/** Klíč kbelíku: shodná textura + helper flag → jeden mesh. */
function bucketKey(tex: THREE.Texture | null, onlyEditor: boolean): string {
  return `${onlyEditor ? "E" : "N"}|${tex ? tex.uuid : "none"}`;
}

/**
 * Přidá geometrii jednoho splajnu do sdílených kbelíků dlaždice (klíč = textura).
 * Víc splajnů téže dlaždice tak sdílí jeden buffer → jeden draw call na texturu.
 */
export function appendSplineGeometry(
  buckets: Map<string, SplineMergeBucket>,
  loaded: LoadedSpline, s: MapSpline, tileX: number, tileY: number
): void {
  const steps = splineSteps(s);
  const frames = splineFrames(s, steps);
  const baseZ = s.z;
  const onlyEditor = !!loaded.def.onlyEditor;

  for (const profile of loaded.def.profiles) {
    const tex = loaded.textures[profile.texIndex] ?? null;
    const key = bucketKey(tex, onlyEditor);
    let b = buckets.get(key);
    if (!b) { b = { tex, onlyEditor, pos: [], uv: [], idx: [] }; buckets.set(key, b); }
    const pts = profile.points;
    // Každý sousední pár bodů profilu = jeden extrudovaný pás podél osy.
    for (let p = 0; p < pts.length - 1; p++) {
      const a = pts[p], c = pts[p + 1];
      for (let i = 0; i < steps; i++) {
        const f0 = frames[i], f1 = frames[i + 1];
        const base = b.pos.length / 3;
        // 4 vrcholy kvádru: (station i × bod a,c), (station i+1 × bod a,c)
        pushVert(b, tileX, tileY, f0, a, baseZ);
        pushVert(b, tileX, tileY, f0, c, baseZ);
        pushVert(b, tileX, tileY, f1, a, baseZ);
        pushVert(b, tileX, tileY, f1, c, baseZ);
        // dva trojúhelníky (DoubleSide → na winding nezáleží)
        b.idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
      }
    }
  }
}

/**
 * Vytvoří sloučené meshe splajnů dlaždice z naplněných kbelíků - jeden mesh na
 * texturu. Geometrie/materiály jsou vlastní (bezpečně disposovatelné); textury
 * žijí ve sdílené cache a nedisposují se.
 */
export function buildMergedSplineMeshes(buckets: Map<string, SplineMergeBucket>): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const b of buckets.values()) {
    if (b.idx.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, splineMaterialFor(b.tex, b.onlyEditor));
    mesh.renderOrder = 1; // nad terénem
    meshes.push(mesh);
  }
  return meshes;
}

/** Přidá jeden vrchol (poloha + UV) do bufferu daného pásu. */
function pushVert(
  b: { pos: number[]; uv: number[]; idx: number[] },
  tileX: number, tileY: number, f: SplineFrame, p: { x: number; z: number; u: number; vSlope: number },
  baseZ: number
) {
  const lx = f.lx + f.rx * p.x;
  const ly = f.ly + f.ry * p.x;
  // s.z (baseZ) je ABSOLUTNÍ výška silnice; terén se NEPŘIČÍTÁ (zarovnaný k silnici).
  const h = baseZ + f.hGrad + p.z;
  b.pos.push(tileX * TILE_SIZE + lx, h, -(tileY * TILE_SIZE + ly));
  b.uv.push(p.u, f.d * p.vSlope);
}

// ---------- AI dráhy ([path]) = vizualizace AI provozu ----------
//
// Každá [path] v .sli je jízdní pruh / chodník / kolej, po které jezdí/chodí AI.
// Dráha kopíruje osu splajnu posunutou příčně o offsetX a svisle o offsetZ, se
// stejným obloukem i gradientem. Kreslíme ji jako čáru (overlay nad silnicí),
// barvu dle typu; u aut přidáme šipky směru (OMSI jezdí vpravo: pruh po směru
// splajnu má dir 0, protisměr dir 1). Segmenty VŠECH splajnů dlaždice se slučují
// do jednoho LineSegments na typ (výkon - jinak desetitisíce draw callů).

/** Barvy AI drah dle typu: auta oranžová, chodci zelená, kolej azurová. */
const PATH_COLORS: Record<number, number> = {
  [PATH_CAR]: 0xff8a1e,
  [PATH_PED]: 0x37d35a,
  [PATH_RAIL]: 0x33c0e6,
};
/** Mírné zvednutí čáry nad povrch dráhy, ať nebliká se silnicí (z-fighting). */
const PATH_LIFT = 0.08;

/** Lokální bod (lx,ly,h) → světová pozice [x,y,z]. */
function toWorldXYZ(lx: number, ly: number, h: number, ox: number, oz: number): [number, number, number] {
  return [ox + lx, h, -(oz + ly)];
}

/** Přidá šipky směru (chevrony „>") podél jízdního pruhu - ukazují směr AI jízdy. */
function appendChevrons(arr: number[], s: MapSpline, path: SliPath, ox: number, oz: number): void {
  const tdir = path.dir === 1 ? -1 : 1; // dir 1 = protisměr splajnu
  const spacing = 18, half = 1.4, wing = 1.1;
  const end = s.length - 2;
  for (let d = 6; d < end; d += spacing) {
    const sm = splineSampleAt(s, d);
    const th = THREE.MathUtils.degToRad(sm.headingDeg);
    const fx = Math.sin(th) * tdir, fy = Math.cos(th) * tdir; // směr jízdy (lokálně)
    const cx = sm.lx + sm.rx * path.offsetX, cy = sm.ly + sm.ry * path.offsetX;
    const h = sm.worldY + path.offsetZ + PATH_LIFT;
    const tip = toWorldXYZ(cx + fx * half, cy + fy * half, h, ox, oz);
    const tl = toWorldXYZ(cx - fx * half + sm.rx * wing, cy - fy * half + sm.ry * wing, h, ox, oz);
    const tr = toWorldXYZ(cx - fx * half - sm.rx * wing, cy - fy * half - sm.ry * wing, h, ox, oz);
    arr.push(tip[0], tip[1], tip[2], tl[0], tl[1], tl[2]);
    arr.push(tip[0], tip[1], tip[2], tr[0], tr[1], tr[2]);
  }
}

/**
 * Přidá čáry AI drah jednoho splajnu do sdílených bufferů dlaždice (klíč = typ
 * dráhy). Víc splajnů dlaždice sdílí jeden buffer na typ → jeden draw call.
 */
export function appendPathLines(
  perType: Map<number, number[]>,
  loaded: LoadedSpline, s: MapSpline, tileX: number, tileY: number
): void {
  if (!loaded.def.paths.length) return;
  const steps = splineSteps(s);
  const frames = splineFrames(s, steps);
  const ox = tileX * TILE_SIZE, oz = tileY * TILE_SIZE;
  for (const path of loaded.def.paths) {
    let arr = perType.get(path.type);
    if (!arr) { arr = []; perType.set(path.type, arr); }
    // Polylinie podél osy posunuté o offsetX (příčně) a offsetZ (svisle).
    let prev: [number, number, number] | null = null;
    for (const f of frames) {
      const lx = f.lx + f.rx * path.offsetX;
      const ly = f.ly + f.ry * path.offsetX;
      const h = s.z + f.hGrad + path.offsetZ + PATH_LIFT;
      const wp = toWorldXYZ(lx, ly, h, ox, oz);
      if (prev) arr.push(prev[0], prev[1], prev[2], wp[0], wp[1], wp[2]);
      prev = wp;
    }
    // Šipky směru jen u aut (nejnázornější); chodci/kolej bývají obousměrní.
    if (path.type === PATH_CAR && s.length > 10) appendChevrons(arr, s, path, ox, oz);
  }
}

/** Z naplněných bufferů (klíč = typ) vytvoří po jednom LineSegments na typ. */
export function buildPathLineMeshes(perType: Map<number, number[]>): THREE.LineSegments[] {
  const out: THREE.LineSegments[] = [];
  for (const [type, arr] of perType) {
    if (!arr.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
    const mat = new THREE.LineBasicMaterial({
      color: PATH_COLORS[type] ?? 0xffffff,
      transparent: true, opacity: 0.92, depthWrite: false,
    });
    const seg = new THREE.LineSegments(geo, mat);
    seg.renderOrder = 3; // nad silnicí i overlay vrstvami
    out.push(seg);
  }
  return out;
}

/** Cache načtených splajnů podle cesty .sli. */
export class SplineCache {
  private cache = new Map<string, Promise<LoadedSpline | null>>();
  constructor(private src: AssetSource) {}
  get(sliPath: string): Promise<LoadedSpline | null> {
    let p = this.cache.get(sliPath);
    if (!p) {
      p = loadSpline(this.src, sliPath).catch(() => null);
      this.cache.set(sliPath, p);
    }
    return p;
  }
}
