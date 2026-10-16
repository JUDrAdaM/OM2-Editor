// Parser textového DirectX .x (xof 0303txt) používaného OMSI pro meshe, které
// nemají zkompilovanou .o3d variantu (starší objekty, stromy s křížovými quady).
//
// Zpracuje hierarchii Frame → FrameTransformMatrix (kumulativně), bloky Mesh
// (vertexy + stěny, triangulace quadů), MeshTextureCoords (UV), MeshNormals a
// MeshMaterialList (index materiálu na stěnu + Material → TextureFilename).
//
// Výstup je kompatibilní s O3DMesh (tentýž build v models.ts). Souřadnice se
// transformují frame maticemi; výsledek je v DirectX prostoru (Y-up, levotočivý)
// a do našeho prostoru se převede v buildGeometry (space = "xmesh").

import type { O3DMesh, O3DMaterial } from "./o3d";

type Mat4 = Float32Array; // 16, column převzatý z .x (row-major v souboru)

function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Násobení row-major 4x4 (a pak b), jak jsou uloženy v .x.
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
}

// Transformace bodu (row-vector × matice), jak .x počítá: v' = v * M.
function apply(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

interface SubMesh {
  positions: number[]; // transformované (x,y,z) DirectX
  uvs: number[];
  indices: number[];
  matIndex: number[];
  materials: O3DMaterial[];
}

export function parseXMesh(buf: ArrayBuffer): O3DMesh | null {
  const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, 16));
  if (!head.startsWith("xof ") || !/txt/.test(head)) return null;
  const text = new TextDecoder("latin1").decode(buf);

  // Odstraň template {...} bloky (jen definice) a komentáře.
  const body = stripTemplates(text.replace(/\/\/[^\n]*/g, "").replace(/#[^\n]*/g, ""));

  const tokens = tokenize(body);
  let i = 0;

  // Projdi se zásobníkem matic podle závorek Frame.
  const matStack: Mat4[] = [identity()];
  const subs: SubMesh[] = [];

  function curMat(): Mat4 { return matStack[matStack.length - 1]; }

  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "Frame") {
      // Frame [name] {  → zdvoj vrchol zásobníku
      i++;
      if (tokens[i] !== "{") i++; // přeskoč jméno
      if (tokens[i] === "{") i++;
      matStack.push(matStack[matStack.length - 1]);
    } else if (t === "FrameTransformMatrix") {
      i = skipTo(tokens, i, "{") + 1;
      const nums: number[] = [];
      while (i < tokens.length && tokens[i] !== "}") { const n = parseFloat(tokens[i]); if (!Number.isNaN(n)) nums.push(n); i++; }
      i++; // }
      if (nums.length >= 16) {
        const local = Float32Array.from(nums.slice(0, 16));
        matStack[matStack.length - 1] = mul(matStack[matStack.length - 1], local);
      }
    } else if (t === "Mesh") {
      i = parseMesh(tokens, i, curMat(), subs);
    } else if (t === "}") {
      if (matStack.length > 1) matStack.pop();
      i++;
    } else {
      i++;
    }
  }

  if (subs.length === 0) return null;

  // Sloučí sub-meshe do jednoho O3DMesh (materiály se zřetězí, indexy posunou).
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [], matIndex: number[] = [];
  const materials: O3DMaterial[] = [];
  for (const s of subs) {
    const vBase = positions.length / 3;
    const mBase = materials.length;
    for (const p of s.positions) positions.push(p);
    if (s.uvs.length === (s.positions.length / 3) * 2) for (const u of s.uvs) uvs.push(u);
    else for (let k = 0; k < s.positions.length / 3; k++) { uvs.push(0, 0); }
    for (let k = 0; k < s.indices.length; k++) indices.push(s.indices[k] + vBase);
    for (const mi of s.matIndex) matIndex.push(mBase + mi);
    for (const mm of s.materials) materials.push(mm);
  }
  const V = positions.length / 3, T = indices.length / 3;
  if (V === 0 || T === 0) return null;
  if (materials.length === 0) materials.push({ texture: "", diffuse: [0.8, 0.8, 0.8, 1] });

  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(V * 3),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    matIndex: Uint16Array.from(matIndex),
    materials,
    vertexCount: V,
    triangleCount: T,
  };
}

function parseMesh(tokens: string[], start: number, mat: Mat4, out: SubMesh[]): number {
  let i = skipTo(tokens, start, "{") + 1;
  const sub: SubMesh = { positions: [], uvs: [], indices: [], matIndex: [], materials: [] };

  // nVertices
  const nV = intAt(tokens, i); i = afterInt(tokens, i);
  for (let v = 0; v < nV; v++) {
    const x = floatAt(tokens, i); i = nextNum(tokens, i);
    const y = floatAt(tokens, i); i = nextNum(tokens, i);
    const z = floatAt(tokens, i); i = nextNum(tokens, i);
    const [tx, ty, tz] = apply(mat, x, y, z);
    sub.positions.push(tx, ty, tz);
  }
  // nFaces
  const nF = intAt(tokens, i); i = afterInt(tokens, i);
  const faceVerts: number[][] = [];
  for (let f = 0; f < nF; f++) {
    const cnt = intAt(tokens, i); i = afterInt(tokens, i);
    const idx: number[] = [];
    for (let k = 0; k < cnt; k++) { idx.push(intAt(tokens, i)); i = nextNum(tokens, i); }
    faceVerts.push(idx);
    // triangulace (fan)
    for (let k = 1; k + 1 < cnt; k++) sub.indices.push(idx[0], idx[k], idx[k + 1]);
  }

  // Volitelné podbloky uvnitř Mesh: MeshTextureCoords, MeshMaterialList, MeshNormals…
  let perFaceMat: number[] | null = null;
  let depth = 1;
  while (i < tokens.length && depth > 0) {
    const t = tokens[i];
    if (t === "MeshTextureCoords") {
      i = skipTo(tokens, i, "{") + 1;
      const nUV = intAt(tokens, i); i = afterInt(tokens, i);
      for (let u = 0; u < nUV; u++) {
        const uu = floatAt(tokens, i); i = nextNum(tokens, i);
        const vv = floatAt(tokens, i); i = nextNum(tokens, i);
        sub.uvs.push(uu, vv);
      }
      i = skipTo(tokens, i, "}") + 1;
    } else if (t === "MeshMaterialList") {
      i = skipTo(tokens, i, "{") + 1;
      const nMat = intAt(tokens, i); i = afterInt(tokens, i);
      const nFaceIdx = intAt(tokens, i); i = afterInt(tokens, i);
      perFaceMat = [];
      for (let f = 0; f < nFaceIdx; f++) { perFaceMat.push(intAt(tokens, i)); i = nextNum(tokens, i); }
      // následují Material {...} bloky
      for (let m = 0; m < nMat; m++) {
        i = skipTo(tokens, i, "Material");
        sub.materials.push(parseMaterial(tokens, i));
        i = matchBrace(tokens, skipTo(tokens, i, "{"));
      }
      i = skipTo(tokens, i, "}") + 1;
    } else if (t === "{") { depth++; i++; }
    else if (t === "}") { depth--; i++; }
    else i++;
  }

  // per-face materiál → per-triangle
  if (perFaceMat && perFaceMat.length === faceVerts.length) {
    for (let f = 0; f < faceVerts.length; f++) {
      const triCount = Math.max(faceVerts[f].length - 2, 0);
      for (let k = 0; k < triCount; k++) sub.matIndex.push(perFaceMat[f] || 0);
    }
  } else {
    for (let k = 0; k < sub.indices.length / 3; k++) sub.matIndex.push(0);
  }

  out.push(sub);
  return i;
}

function parseMaterial(tokens: string[], at: number): O3DMaterial {
  let i = skipTo(tokens, at, "{") + 1;
  // Material: 4 float faceColor, power, 3 float specular, 3 float emissive, pak TextureFilename
  const nums: number[] = [];
  while (i < tokens.length && nums.length < 11 && tokens[i] !== "TextureFilename" && tokens[i] !== "}") {
    const n = parseFloat(tokens[i]); if (!Number.isNaN(n)) nums.push(n); i++;
  }
  const diffuse: [number, number, number, number] = [nums[0] ?? 0.8, nums[1] ?? 0.8, nums[2] ?? 0.8, nums[3] ?? 1];
  let texture = "";
  const tf = findWithin(tokens, i, "TextureFilename", 200);
  if (tf >= 0) {
    const q = findString(tokens, tf);
    if (q) texture = q;
  }
  return { texture, diffuse };
}

// ---------- tokenizace a pomocné ----------

function stripTemplates(text: string): string {
  // Odeber "template Name { ... }" bloky.
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("template", i) && /\s/.test(text[i + 8] || "")) {
      const brace = text.indexOf("{", i);
      if (brace < 0) break;
      let depth = 1, j = brace + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      i = j;
    } else { out += text[i]; i++; }
  }
  return out;
}

function tokenize(text: string): string[] {
  // Oddělovače: whitespace a , ; . Uvozovky drží řetězec.
  const toks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; let s = "";
      while (j < text.length && text[j] !== '"') { s += text[j]; j++; }
      toks.push('"' + s + '"');
      i = j + 1;
    } else if (c === "{" || c === "}") { toks.push(c); i++; }
    else if (c === "," || c === ";" || /\s/.test(c)) { i++; }
    else {
      let j = i; let s = "";
      while (j < text.length && !/[\s,;{}"]/.test(text[j])) { s += text[j]; j++; }
      if (s) toks.push(s);
      i = j;
    }
  }
  return toks;
}

function skipTo(tokens: string[], from: number, tok: string): number {
  let i = from;
  while (i < tokens.length && tokens[i] !== tok) i++;
  return i;
}
function matchBrace(tokens: string[], openIdx: number): number {
  let depth = 0, i = openIdx;
  for (; i < tokens.length; i++) {
    if (tokens[i] === "{") depth++;
    else if (tokens[i] === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return i;
}
function findWithin(tokens: string[], from: number, tok: string, span: number): number {
  for (let i = from; i < Math.min(tokens.length, from + span); i++) { if (tokens[i] === tok) return i; if (tokens[i] === "}") return -1; }
  return -1;
}
function findString(tokens: string[], from: number): string | null {
  for (let i = from; i < Math.min(tokens.length, from + 6); i++) {
    if (tokens[i].startsWith('"')) return tokens[i].slice(1, -1).trim();
  }
  return null;
}
function intAt(tokens: string[], i: number): number { return parseInt(tokens[i], 10) || 0; }
function floatAt(tokens: string[], i: number): number { const n = parseFloat(tokens[i]); return Number.isNaN(n) ? 0 : n; }
function afterInt(_tokens: string[], i: number): number { return i + 1; }
function nextNum(_tokens: string[], i: number): number { return i + 1; }
