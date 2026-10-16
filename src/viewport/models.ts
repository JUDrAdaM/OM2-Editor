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

/** Vstupní prostor meshe: o3d = Z-up (OMSI), xmesh = Y-up (DirectX po frame maticích). */
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
      // rotace kolem svislé osy (Z v mesh-space), pak posun originu, pak Z-up → Y-up
      const rx = mx0 * cos - my0 * sin, ry = mx0 * sin + my0 * cos;
      const mx = rx + ox, my = ry + oy, mz = mz0 + oz;
      pos[i * 3] = mx; pos[i * 3 + 1] = mz; pos[i * 3 + 2] = -my;
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

/** Bounding box pozic meshe v jeho vstupním (mesh) prostoru. */
function meshBBox(mesh: O3DMesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Konzervativní detekce „rozsypaných" o3d-v5 meshů (viz o3d.ts / poznámky): některé
 * soubory (budka Stellwerk, reklamní hodiny Werbeuhr…) mají interně nekonzistentní
 * data vrcholů/indexů a vykreslí se jako naježená „kostka". Poznáme je podle toho, že
 * bounding box je PŘESNÁ krychle – shodné rozměry i rohy ve všech osách (do 2 %). Reálné
 * budovy jsou vždy nesymetrické, takže je to nechytí. Takové meshe nahradíme boxem.
 */
function looksCubeScrambled(mesh: O3DMesh): boolean {
  if (mesh.triangleCount < 12) return false; // malé objekty neřešíme
  const { min, max } = meshBBox(mesh);
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  const avg = (sx + sy + sz) / 3;
  if (!Number.isFinite(avg) || avg < 1) return false;
  const tol = 0.02 * avg;
  const sizeSpread = Math.max(sx, sy, sz) - Math.min(sx, sy, sz);
  const minSpread = Math.max(...min) - Math.min(...min);
  const maxSpread = Math.max(...max) - Math.min(...max);
  return sizeSpread < tol && minSpread < tol && maxSpread < tol;
}

/** Syntetický box-mesh (24 vrcholů, 12 trojúhelníků) v rozměru [min,max] pro náhradu. */
function makeBoxMesh(min: [number, number, number], max: [number, number, number]): O3DMesh {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  // 6 stěn po 4 vrcholech (kvůli plochým stěnám a UV)
  const faces: [number, number, number][][] = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // +Z
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // -Z
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // +X
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // -X
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], // +Y
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // -Y
  ];
  const positions = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(12 * 3);
  const matIndex = new Uint16Array(12);
  const faceUV: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach((f, fi) => {
    const base = fi * 4;
    f.forEach((v, vi) => {
      positions[(base + vi) * 3] = v[0];
      positions[(base + vi) * 3 + 1] = v[1];
      positions[(base + vi) * 3 + 2] = v[2];
      uvs[(base + vi) * 2] = faceUV[vi][0];
      uvs[(base + vi) * 2 + 1] = faceUV[vi][1];
    });
    const t = fi * 2;
    indices[t * 3] = base; indices[t * 3 + 1] = base + 1; indices[t * 3 + 2] = base + 2;
    indices[(t + 1) * 3] = base; indices[(t + 1) * 3 + 1] = base + 2; indices[(t + 1) * 3 + 2] = base + 3;
  });
  return {
    positions, normals: new Float32Array(24 * 3), uvs, indices, matIndex,
    materials: [{ texture: "", diffuse: [0.8, 0.8, 0.8, 1] }], vertexCount: 24, triangleCount: 12,
  };
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
    if (parts.length) return { parts, originRotY: 0 };
  }

  for (const meshDef of sco.meshes) {
    const loaded = await loadMesh(src, scoDir, meshDef.file);
    if (!loaded) continue;
    const origin: [number, number, number] = loaded.space === "o3d" ? meshDef.originTrans : [0, 0, 0];
    const rotY = loaded.space === "o3d" ? meshDef.originRotY : 0;
    const materials = await buildMaterials(src, scoDir, loaded.mesh, meshDef.matls);
    // Rozsypaný o3d-v5 (naježená „kostka") → náhradní box v rozměru bboxu s 1. texturou.
    const meshToBuild = loaded.space === "o3d" && looksCubeScrambled(loaded.mesh)
      ? makeBoxMesh(meshBBox(loaded.mesh).min, meshBBox(loaded.mesh).max)
      : loaded.mesh;
    const geometry = buildGeometry(meshToBuild, origin, rotY, loaded.space);
    const material = meshToBuild === loaded.mesh
      ? (materials.length === 1 ? materials[0] : materials)
      : materials[0]; // box má jen materiál 0
    parts.push({ geometry, material });
  }

  return parts.length ? { parts, originRotY: 0 } : null;
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
