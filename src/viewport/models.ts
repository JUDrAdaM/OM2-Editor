import * as THREE from "three";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { DDSLoader } from "three/addons/loaders/DDSLoader.js";
import { parseO3D } from "../omsi/o3d";
import type { O3DMesh } from "../omsi/o3d";
import { parseXMesh } from "../omsi/xmesh";
import { parseSco } from "../omsi/sco";
import type { AlphaMode, ScoMatl, ScoTree } from "../omsi/sco";

// Zdroj souborů relativně ke kořeni OMSI (Electron IPC nebo dev fetch).
export interface AssetSource {
  readFile(relPath: string): Promise<ArrayBuffer | null>;
}

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}
export interface LoadedModel {
  parts: ModelPart[];
  /** Zachováno kvůli API; origin se zapéká přímo do geometrie → 0. */
  originRotY: number;
  /** [absheight] nebo [path] → objekt se umisťuje na absolutní z (bez terénu). */
  absoluteHeight: boolean;
  /** Matice bodů [new_attachment] (pro děti [attachObj]) v three-prostoru rodiče. */
  attachments: THREE.Matrix4[];
  /** Základní rozměr billboardu stromu (z [tree]); slouží k per-instance škálování
   *  podle přepisu ve [object]. undef = objekt není strom. */
  treeBase?: { height: number; ratio: number };
}

/**
 * Matice jednoho [new_attachment] bodu ve three-prostoru.
 *
 * POZOR na konvenci: attachment prostor OMSI je **Z-up** (openOMSI: „x vpravo,
 * y dopředu, z nahoru") – NE Y-up jako samotný mesh. Takže `attach_trans
 * [0,15,0]` je 15 m DOPŘEDU (vodorovně), ne nahoru, a `[... , z]` je výška.
 * (Ověřeno: řadové/panelové domy se skládají VEDLE SEBE do řad – `bw_row50s`,
 * `wohn_*` mají attach_trans [0,±16,0]; semafor na rameni visí v z≈5.)
 *
 * Matici složíme v OMSI prostoru (m = step · m, záporné úhly jako openOMSI) a
 * převedeme do three konjugací bází `B = Rx(−90°)` (OMSI (x,y,z)→three (x,z,−y),
 * tj. stejné mapování jako map→three): M_three = B · m · B⁻¹. Dřívější konverze
 * S=diag(1,1,−1) (Y-up, jako mesh) stavěla vodorovné posuny svisle → modulární
 * domy se stavěly na sebe a značky/semafory padaly k zemi.
 */
function attachmentMatrix(ops: { op: string; vals: number[] }[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const step = new THREE.Matrix4();
  for (const { op, vals } of ops) {
    if (op === "attach_trans" && vals.length >= 3) step.makeTranslation(vals[0], vals[1], vals[2]);
    else if (op === "attach_rot_x") step.makeRotationX(-THREE.MathUtils.degToRad(vals[0] || 0));
    else if (op === "attach_rot_y") step.makeRotationY(-THREE.MathUtils.degToRad(vals[0] || 0));
    else if (op === "attach_rot_z") step.makeRotationZ(-THREE.MathUtils.degToRad(vals[0] || 0));
    else continue;
    m.premultiply(step);
  }
  const B = new THREE.Matrix4().makeRotationX(-Math.PI / 2);     // OMSI z-up → three y-up
  const Binv = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  return B.multiply(m).multiply(Binv);
}

const tgaLoader = new TGALoader();
const ddsLoader = new DDSLoader();

export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}
export function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function join(...parts: string[]): string {
  return parts.filter(Boolean).join("\\");
}

export async function tryReadNamed(src: AssetSource, candidates: string[]): Promise<{ name: string; buf: ArrayBuffer } | null> {
  for (const c of candidates) {
    const buf = await src.readFile(c);
    if (buf) return { name: c, buf };
  }
  return null;
}

/** Dekóduje obrázkový buffer na Three texturu (DDS/TGA/PNG/BMP/JPG). */
export function decodeTexture(name: string, buf: ArrayBuffer): THREE.Texture | null {
  const ext = name.toLowerCase().split(".").pop();
  try {
    if (ext === "dds") {
      const parsed = ddsLoader.parse(buf, true);
      if (!parsed.mipmaps?.length) return null;
      const tex = new THREE.CompressedTexture(
        parsed.mipmaps as unknown as ImageData[], parsed.width, parsed.height,
        parsed.format as THREE.CompressedPixelFormat
      );
      tex.needsUpdate = true;
      tex.flipY = false;
      return tex;
    }
    if (ext === "tga") {
      const parsed = tgaLoader.parse(buf) as unknown as { data: Uint8Array; width: number; height: number };
      if (!parsed?.data) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tex = new THREE.DataTexture(parsed.data as any, parsed.width, parsed.height, THREE.RGBAFormat);
      tex.needsUpdate = true;
      tex.flipY = true;
      return tex;
    }
    // png/jpg/bmp přes Image (asynchronně)
    const img = new Image();
    const tex = new THREE.Texture(img);
    const url = URL.createObjectURL(new Blob([buf]));
    img.onload = () => { tex.needsUpdate = true; URL.revokeObjectURL(url); };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    return tex;
  } catch {
    return null;
  }
}

/** Kandidátní cesty k textuře (podsložka texture/, kořen objektu; varianty přípon). */
export function textureCandidates(scoDir: string, texName: string): string[] {
  const base = baseOf(texName);
  const stem = base.replace(/\.[^.]+$/, "");
  const names = [base, `${stem}.dds`, `${stem}.png`, `${stem}.tga`, `${stem}.bmp`, `${stem}.jpg`];
  const out: string[] = [];
  for (const n of names) out.push(join(scoDir, "texture", n), join(scoDir, n), join(scoDir, "Texture", n));
  return out;
}

const GREY: [number, number, number, number] = [0.72, 0.74, 0.77, 1];

/** Nastaví průhlednost materiálu podle OMSI alpha módu. */
function applyAlpha(mat: THREE.MeshStandardMaterial, mode: AlphaMode) {
  if (mode === 1) {
    // alpha-test: ostré hrany (stromy, ploty, sítě) – bez třídění
    mat.transparent = false;
    mat.alphaTest = 0.5;
  } else if (mode === 2) {
    // alpha-blend: poloprůhledné (sklo)
    mat.transparent = true;
    mat.alphaTest = 0.01;
    mat.depthWrite = false;
  }
}

/** Vstupní prostor meshe: o3d i xmesh jsou Y-up (DirectX). Vertikála = coord1 (Y). */
type MeshSpace = "o3d" | "xmesh";

/** Postaví geometrii; zapeče origin (trans+rot) a seskupí trojúhelníky dle materiálu. */
function buildGeometry(mesh: O3DMesh, originTrans: [number, number, number], originRotY: number, space: MeshSpace = "o3d"): THREE.BufferGeometry {
  const V = mesh.vertexCount, T = mesh.triangleCount;
  const rot = THREE.MathUtils.degToRad(originRotY);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const [ox, oy, oz] = originTrans;
  const pos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const mx0 = mesh.positions[i * 3], my0 = mesh.positions[i * 3 + 1], mz0 = mesh.positions[i * 3 + 2];
    if (space === "xmesh") {
      // už Y-up (levotočivý DirectX) → jen převrácení Z na pravotočivý
      pos[i * 3] = mx0 + ox; pos[i * 3 + 1] = my0 + oz; pos[i * 3 + 2] = -(mz0 + oy);
    } else {
      // o3d (odscramblované) = Y-up DirectX: vertikála = coord1 (Y). origin_rot_y
      // rotuje kolem svislé osy (Y) → horizontální rovina (x,z). Z → pravotočivý.
      const rx = mx0 * cos + mz0 * sin, rz = -mx0 * sin + mz0 * cos;
      pos[i * 3] = rx + ox; pos[i * 3 + 1] = my0 + oy; pos[i * 3 + 2] = -(rz + oz);
    }
  }

  // seřaď trojúhelníky podle materiálu → souvislé skupiny
  const order = Array.from({ length: T }, (_, i) => i).sort((a, b) => mesh.matIndex[a] - mesh.matIndex[b]);
  const idx = new Uint32Array(T * 3);
  const geo = new THREE.BufferGeometry();
  let curMat = -1, gStart = 0;
  for (let k = 0; k < T; k++) {
    const t = order[k];
    idx[k * 3] = mesh.indices[t * 3];
    idx[k * 3 + 1] = mesh.indices[t * 3 + 1];
    idx[k * 3 + 2] = mesh.indices[t * 3 + 2];
    const mat = mesh.matIndex[t];
    if (mat !== curMat) {
      if (curMat >= 0) geo.addGroup(gStart * 3, (k - gStart) * 3, curMat);
      curMat = mat; gStart = k;
    }
  }
  if (curMat >= 0) geo.addGroup(gStart * 3, (T - gStart) * 3, curMat);

  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Výška pole [crossing_heightdeformation] v bodě (x,z) roviny – barycentrická
 * interpolace přes trojúhelníky pole; max přes pokrývající; miss → null.
 * Náš mesh je Y-up (výška = Y, rovina = X,Z); openOMSI počítá v Z-up, proto
 * openOMSI (x,y)=naše (x,z), openOMSI z(výška)=naše y. (openOMSI place.rs field_height.)
 */
function crossingFieldHeight(field: O3DMesh, qx: number, qz: number): number | null {
  const P = field.positions, I = field.indices, T = field.triangleCount;
  let best: number | null = null;
  for (let t = 0; t < T; t++) {
    const ia = I[t * 3], ib = I[t * 3 + 1], ic = I[t * 3 + 2];
    const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
    const bx = P[ib * 3], by = P[ib * 3 + 1], bz = P[ib * 3 + 2];
    const cx = P[ic * 3], cy = P[ic * 3 + 1], cz = P[ic * 3 + 2];
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((bx - ax) * (qz - az) - (qx - ax) * (bz - az)) / det;
    const l2 = ((qx - ax) * (cz - az) - (cx - ax) * (qz - az)) / det;
    const l0 = 1 - l1 - l2;
    if (l0 >= -1e-4 && l1 >= -1e-4 && l2 >= -1e-4) {
      const h = l0 * ay + l2 * by + l1 * cy; // výška = Y
      best = best === null ? h : Math.max(best, h);
    }
  }
  return best;
}

/**
 * „Drapne" desku křižovatky na její výškové pole: každý vrchol se zvedne o výšku
 * pole v jeho (x,z). Vrchol, který pole nepokrývá, zůstane beze změny. Terén
 * nehraje roli (viz openOMSI warp_crossings). Aplikuje se na RAW pozice (Y-up)
 * před zapečením originu v buildGeometry, kde je stejný rámec jako pole.
 */
function applyCrossingDeform(mesh: O3DMesh, field: O3DMesh): number {
  if (field.triangleCount === 0) return 0;
  const P = mesh.positions;
  let moved = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = crossingFieldHeight(field, P[i * 3], P[i * 3 + 2]);
    if (d !== null && Math.abs(d) > 0.001) { P[i * 3 + 1] += d; moved++; }
  }
  return moved;
}

/** Načte mesh objektu: nejdřív zkompilovaný .o3d, při selhání textový .x. */
async function loadMesh(src: AssetSource, scoDir: string, file: string): Promise<{ mesh: O3DMesh; space: MeshSpace } | null> {
  const stem = baseOf(file).replace(/\.[^.]+$/, "");
  // 1) .o3d (zkompilovaná varianta – preferovaná)
  const o3dBuf = await tryReadNamed(src, [
    join(scoDir, "model", `${stem}.o3d`),
    join(scoDir, `${stem}.o3d`),
    join(scoDir, "Model", `${stem}.o3d`),
  ]);
  if (o3dBuf) {
    const mesh = parseO3D(o3dBuf.buf);
    if (mesh) return { mesh, space: "o3d" };
  }
  // 2) textový .x (starší objekty bez .o3d)
  const xBuf = await tryReadNamed(src, [
    join(scoDir, "model", `${stem}.x`),
    join(scoDir, `${stem}.x`),
    join(scoDir, "Model", `${stem}.x`),
  ]);
  if (xBuf) {
    const mesh = parseXMesh(xBuf.buf);
    if (mesh) return { mesh, space: "xmesh" };
  }
  return null;
}

/** Sestaví materiály meshe: o3d materiály + přepisy ze .sco (textura/alpha/transmap). */
async function buildMaterials(src: AssetSource, scoDir: string, mesh: O3DMesh, scoMatls: ScoMatl[]): Promise<THREE.Material[]> {
  let slots = Math.max(mesh.materials.length, 1);
  for (let i = 0; i < mesh.triangleCount; i++) slots = Math.max(slots, mesh.matIndex[i] + 1);

  const scoByIndex = new Map<number, ScoMatl>();
  scoMatls.forEach((m, i) => {
    const key = scoByIndex.has(m.matlIndex) ? i : m.matlIndex;
    scoByIndex.set(key, m);
  });

  const materials: THREE.Material[] = [];
  for (let m = 0; m < slots; m++) {
    const o3dMat = mesh.materials[m];
    const scoMat = scoByIndex.get(m);
    const diffuse = o3dMat?.diffuse ?? GREY;
    const texName = scoMat?.texture || o3dMat?.texture || "";
    const alpha: AlphaMode = scoMat?.alpha ?? 0;

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(diffuse[0], diffuse[1], diffuse[2]),
      roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    applyAlpha(mat, alpha);

    if (texName) {
      const found = await tryReadNamed(src, textureCandidates(scoDir, texName));
      if (found) {
        const tex = decodeTexture(found.name, found.buf);
        if (tex) {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          mat.map = tex;
          mat.color.setRGB(1, 1, 1);
          mat.needsUpdate = true;
        }
      }
    }

    if (scoMat?.transmap) {
      const t = await tryReadNamed(src, textureCandidates(scoDir, scoMat.transmap));
      if (t) {
        const atex = decodeTexture(t.name, t.buf);
        if (atex) {
          atex.flipY = mat.map ? mat.map.flipY : (t.name.toLowerCase().endsWith(".dds") ? false : true);
          mat.alphaMap = atex;
          if (mat.alphaTest === 0) mat.alphaTest = 0.5;
          mat.needsUpdate = true;
        }
      }
    }

    materials.push(mat);
  }
  return materials;
}

/** Postaví billboard stromu: dva zkřížené alfa-testované quady. */
async function buildTree(src: AssetSource, scoDir: string, tree: ScoTree): Promise<ModelPart | null> {
  const found = await tryReadNamed(src, textureCandidates(scoDir, tree.texture));
  const w = (tree.width || 10) / 2, h = tree.height || 14;
  // dva quady (XY a ZY rovina), základna na zemi
  const pos = new Float32Array([
    -w, 0, 0, w, 0, 0, w, h, 0, -w, h, 0,
    0, 0, -w, 0, 0, w, 0, h, w, 0, h, -w,
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    transparent: false, alphaTest: 0.5,
  });
  if (found) {
    const tex = decodeTexture(found.name, found.buf);
    if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; mat.map = tex; mat.needsUpdate = true; }
  } else {
    mat.color.setHex(0x3f7a3f); // nouzová zeleň
  }
  return { geometry: geo, material: mat };
}

/** Načte celý scenery objekt (.sco) jako seznam dílů (geometrie + materiály). */
export async function loadModel(src: AssetSource, scoPath: string): Promise<LoadedModel | null> {
  const scoBuf = await src.readFile(scoPath);
  if (!scoBuf) return null;
  const sco = parseSco(new TextDecoder("windows-1252").decode(scoBuf));
  const scoDir = dirOf(scoPath);
  const parts: ModelPart[] = [];

  // Billboard stromy (pokud objekt má [tree]) – kreslí se místo meshů.
  if (sco.trees.length) {
    for (const tree of sco.trees) {
      const part = await buildTree(src, scoDir, tree);
      if (part) parts.push(part);
    }
    if (parts.length) {
      const bt = sco.trees[0];
      const treeBase = { height: bt.height || 14, ratio: bt.height > 0 ? bt.width / bt.height : 1 };
      return { parts, originRotY: 0, absoluteHeight: sco.absHeight, attachments: sco.attachments.map(attachmentMatrix), treeBase };
    }
  }

  // [crossing_heightdeformation]: hrubé výškové pole (mesh), kterým se „drapne"
  // deska křižovatky (kameny, klopení, ramena klesající na silnice).
  let deformField: O3DMesh | null = null;
  if (sco.crossingDeform) {
    const f = await loadMesh(src, scoDir, sco.crossingDeform);
    deformField = f?.mesh ?? null;
  }

  for (const meshDef of sco.meshes) {
    const loaded = await loadMesh(src, scoDir, meshDef.file);
    if (!loaded) continue;
    if (deformField) applyCrossingDeform(loaded.mesh, deformField);
    const origin: [number, number, number] = loaded.space === "o3d" ? meshDef.originTrans : [0, 0, 0];
    const rotY = loaded.space === "o3d" ? meshDef.originRotY : 0;
    const materials = await buildMaterials(src, scoDir, loaded.mesh, meshDef.matls);
    const geometry = buildGeometry(loaded.mesh, origin, rotY, loaded.space);
    const material = materials.length === 1 ? materials[0] : materials;
    parts.push({ geometry, material });
  }

  return parts.length ? { parts, originRotY: 0, absoluteHeight: sco.absHeight, attachments: sco.attachments.map(attachmentMatrix) } : null;
}

/** Cache modelů podle cesty .sco. */
export class ModelCache {
  private cache = new Map<string, Promise<LoadedModel | null>>();
  constructor(private src: AssetSource) {}
  get(scoPath: string): Promise<LoadedModel | null> {
    let p = this.cache.get(scoPath);
    if (!p) {
      p = loadModel(this.src, scoPath).catch(() => null);
      this.cache.set(scoPath, p);
    }
    return p;
  }
}
