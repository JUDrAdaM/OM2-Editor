// Parser binárního meshe OMSI (.o3d).
//
// Formát ověřený reverse-engineeringem na reálných datech (OMSI 2, ~13 500
// scenery + splajn meshů, >99 % úspěšnost):
//
//   [0]      0x84  (verze/signatura)
//   [1..]    hlavička, pak chunk s tagem 0x17 = vertices
//   0x17     count (uint16 nebo uint32 – detekuje se podle toho, kde navazuje
//            chunk 0x49), pak count × 32 B = 3×float pozice + 3×float normála
//            + 2×float UV
//   0x49     triangles: count (POZOR: u části modelů uint16, u části uint32 –
//            detekuje se), pak count × trojúhelník:
//              3× index (uint16 = 8 B stride, nebo uint32 = 14 B stride)
//              + uint16 index materiálu
//   0x26     materials: count (uint16), pak count × materiál:
//              4×float diffuse RGBA, 3×float specular, 3×float emission,
//              1×float specular power, 1×uint8 délka názvu textury, název
//
// KLÍČOVÉ: index materiálu u trojúhelníku odkazuje PŘÍMO do seznamu materiálů
// (0-based, včetně materiálů s prázdným názvem textury). Dřívější verze parseru
// tohle mapování ztrácela (ASCII scrape) a navíc četla počet trojúhelníků vždy
// jako uint32 → posun startu o 2 B → rozházené materiály i tvary.

export interface O3DMaterial {
  /** Název souboru textury (může být prázdný → jen barva). */
  texture: string;
  /** Difuzní barva RGBA (0..1). */
  diffuse: [number, number, number, number];
}

export interface O3DMesh {
  positions: Float32Array; // V*3
  normals: Float32Array; // V*3
  uvs: Float32Array; // V*2
  indices: Uint32Array; // T*3
  /** Index materiálu pro každý trojúhelník (T). */
  matIndex: Uint16Array;
  /** Materiály v pořadí (index = hodnota z matIndex). */
  materials: O3DMaterial[];
  vertexCount: number;
  triangleCount: number;
}

const MAT_TAG = 0x26;

export function parseO3D(buf: ArrayBuffer): O3DMesh | null {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x84) return null;
  const dv = new DataView(buf);

  // --- vertices (chunk 0x17) ---
  let p = 1;
  while (p < 12 && u8[p] !== 0x17) p++;
  if (u8[p] !== 0x17) return null;
  p++;

  const V16 = dv.getUint16(p, true);
  const V32 = dv.getUint32(p, true);
  let V: number, vStart: number;
  if (p + 2 + V16 * 32 < u8.length && u8[p + 2 + V16 * 32] === 0x49) { V = V16; vStart = p + 2; }
  else if (p + 4 + V32 * 32 <= u8.length && u8[p + 4 + V32 * 32] === 0x49) { V = V32; vStart = p + 4; }
  else { V = V16; vStart = p + 2; }
  if (V <= 0 || vStart + V * 32 > u8.length) return null;

  const positions = new Float32Array(V * 3);
  const normals = new Float32Array(V * 3);
  const uvs = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    const o = vStart + i * 32;
    positions[i * 3] = dv.getFloat32(o, true);
    positions[i * 3 + 1] = dv.getFloat32(o + 4, true);
    positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
    normals[i * 3] = dv.getFloat32(o + 12, true);
    normals[i * 3 + 1] = dv.getFloat32(o + 16, true);
    normals[i * 3 + 2] = dv.getFloat32(o + 20, true);
    uvs[i * 2] = dv.getFloat32(o + 24, true);
    uvs[i * 2 + 1] = dv.getFloat32(o + 28, true);
  }

  // --- triangles (chunk 0x49) ---
  p = vStart + V * 32;
  if (u8[p] !== 0x49) return null;
  const triTag = p;

  // Vyber kombinaci (šířka počtu, stride indexu) tak, aby:
  //  (a) všechny indexy byly < V,
  //  (b) konec trojúhelníků padl na platný materiálový chunk (0x26).
  // Pořadí zkoušení dle četnosti v reálných datech.
  const combos: Array<[number, number]> = [[2, 8], [4, 8], [4, 14], [2, 14]];
  type TriCand = { countOff: number; triStart: number; T: number; stride: number; matOff: number };
  let chosen: TriCand | null = null;
  let fallback: TriCand | null = null;

  for (const [cw, stride] of combos) {
    const countOff = triTag + 1;
    const T = cw === 2 ? dv.getUint16(countOff, true) : dv.getUint32(countOff, true);
    if (T <= 0 || T > 5_000_000) continue;
    const triStart = countOff + cw;
    const end = triStart + T * stride;
    if (end > u8.length) continue;
    if (!indicesValid(dv, triStart, T, stride, V)) continue;
    const cand = { countOff, triStart, T, stride, matOff: end };
    if (validMaterialsAt(dv, u8, end)) { chosen = cand; break; }
    if (!fallback) fallback = cand;
  }
  const sel = chosen ?? fallback;
  if (!sel) return null;

  const { triStart, T, stride, matOff } = sel;
  const long = stride === 14;
  const indices = new Uint32Array(T * 3);
  const matIndex = new Uint16Array(T);
  const miOff = long ? 12 : 6;
  for (let i = 0; i < T; i++) {
    const o = triStart + i * stride;
    indices[i * 3] = long ? dv.getUint32(o, true) : dv.getUint16(o, true);
    indices[i * 3 + 1] = long ? dv.getUint32(o + 4, true) : dv.getUint16(o + 2, true);
    indices[i * 3 + 2] = long ? dv.getUint32(o + 8, true) : dv.getUint16(o + 4, true);
    matIndex[i] = dv.getUint16(o + miOff, true);
  }

  // --- materials (chunk 0x26) ---
  let materials: O3DMaterial[];
  if (chosen && u8[matOff] === MAT_TAG) {
    materials = readMaterials(dv, u8, matOff);
  } else {
    // Nouzový režim: strukturu materiálů se nepodařilo potvrdit → vyškrábej
    // názvy textur jako ASCII (bez spolehlivého mapování na index).
    materials = scrapeTextures(u8, matOff).map((texture) => ({
      texture, diffuse: [0.8, 0.8, 0.8, 1] as [number, number, number, number],
    }));
  }

  return { positions, normals, uvs, indices, matIndex, materials, vertexCount: V, triangleCount: T };
}

function indicesValid(dv: DataView, triStart: number, T: number, stride: number, V: number): boolean {
  const long = stride === 14;
  for (let i = 0; i < T; i++) {
    const o = triStart + i * stride;
    const a = long ? dv.getUint32(o, true) : dv.getUint16(o, true);
    const b = long ? dv.getUint32(o + 4, true) : dv.getUint16(o + 2, true);
    const c = long ? dv.getUint32(o + 8, true) : dv.getUint16(o + 4, true);
    if (a >= V || b >= V || c >= V) return false;
  }
  return true;
}

/** Ověří, že na offsetu `at` začíná platný materiálový chunk (0x26 + záznamy). */
function validMaterialsAt(dv: DataView, u8: Uint8Array, at: number): boolean {
  if (u8[at] !== MAT_TAG) return false;
  let m = at + 1;
  if (m + 2 > u8.length) return false;
  const count = dv.getUint16(m, true); m += 2;
  if (count < 1 || count > 256) return false;
  if (m + 44 > u8.length) return false;
  // difuzní barva: rozumné hodnoty
  for (let k = 0; k < 4; k++) {
    const v = dv.getFloat32(m + k * 4, true);
    if (!Number.isFinite(v) || v < -0.01 || v > 8) return false;
  }
  const len = u8[m + 44];
  if (len > 63) return false;
  if (len > 0) {
    const name = asciiAt(u8, m + 45, len);
    if (!/\.(dds|bmp|tga|png|jpe?g)$/i.test(name)) return false;
  }
  return true;
}

function readMaterials(dv: DataView, u8: Uint8Array, at: number): O3DMaterial[] {
  const out: O3DMaterial[] = [];
  let m = at + 1;
  const count = dv.getUint16(m, true); m += 2;
  for (let k = 0; k < count && m + 44 <= u8.length; k++) {
    const diffuse: [number, number, number, number] = [
      dv.getFloat32(m, true), dv.getFloat32(m + 4, true),
      dv.getFloat32(m + 8, true), dv.getFloat32(m + 12, true),
    ];
    m += 44; // 11 floatů: diffuse(4) + specular(3) + emission(3) + specpower(1)
    const len = u8[m]; m += 1;
    let texture = "";
    if (len > 0 && m + len <= u8.length) { texture = asciiAt(u8, m, len).trim(); m += len; }
    out.push({ texture, diffuse });
  }
  return out;
}

function asciiAt(u8: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

/** Nouzové vyškrábání názvů textur (jen když selže strukturované čtení). */
function scrapeTextures(u8: Uint8Array, from: number): string[] {
  const out: string[] = [];
  let ascii = "";
  const flush = () => {
    const m = ascii.match(/([\w\-. ]{1,}\.(?:dds|bmp|tga|png|jpe?g))/i);
    if (m) out.push(m[1].trim());
    ascii = "";
  };
  for (let i = from; i < u8.length; i++) {
    const c = u8[i];
    if (c >= 32 && c < 127) ascii += String.fromCharCode(c);
    else flush();
  }
  flush();
  return out;
}
