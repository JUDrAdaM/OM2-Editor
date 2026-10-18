import * as THREE from "three";
import { TILE_SIZE } from "../omsi/types";
import type { MapSpline } from "../omsi/types";
import { parseSli } from "../omsi/sli";
import type { SliDef } from "../omsi/sli";
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
  if (!def.profiles.length) return null;
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

/** Vytvoří materiál pro daný index textury (šedý asfalt, když textura chybí). */
function splineMaterial(loaded: LoadedSpline, texIndex: number): THREE.MeshStandardMaterial {
  const tex = loaded.textures[texIndex] ?? null;
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
  if (loaded.def.onlyEditor) {
    mat.transparent = true;
    mat.opacity = 0.35;
    mat.depthWrite = false;
  }
  return mat;
}

/**
 * Postaví mesh splajnu: jedna geometrie se skupinami podle textury + pole
 * materiálů. Textury jsou sdílené z `loaded` (geometrie/materiály jsou vlastní
 * a bezpečně disposovatelné; textury žijí v cache a nedisposují se).
 */
export function buildSplineMesh(
  loaded: LoadedSpline, s: MapSpline, tileX: number, tileY: number
): THREE.Mesh {
  const steps = splineSteps(s);
  const frames = splineFrames(s, steps);
  const baseZ = s.z;

  // Buffery sdružené podle indexu textury (→ skupiny geometrie).
  const byTex = new Map<number, { pos: number[]; uv: number[]; idx: number[] }>();
  const bucket = (ti: number) => {
    let b = byTex.get(ti);
    if (!b) { b = { pos: [], uv: [], idx: [] }; byTex.set(ti, b); }
    return b;
  };

  for (const profile of loaded.def.profiles) {
    const b = bucket(profile.texIndex);
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

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const materials: THREE.Material[] = [];
  const geo = new THREE.BufferGeometry();
  let vertOffset = 0, triOffset = 0;
  for (const [texIndex, b] of byTex) {
    const matSlot = materials.length;
    materials.push(splineMaterial(loaded, texIndex));
    for (const v of b.pos) positions.push(v);
    for (const v of b.uv) uvs.push(v);
    for (const v of b.idx) indices.push(v + vertOffset);
    geo.addGroup(triOffset, b.idx.length, matSlot);
    vertOffset += b.pos.length / 3;
    triOffset += b.idx.length;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, materials.length === 1 ? materials[0] : materials);
  mesh.renderOrder = 1; // nad terénem
  return mesh;
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
