// Parser binárního meshe OMSI (.o3d).
//
// Deterministický port algoritmu z openOMSI (crate omsi-o3d) - ověřeno proti
// reálným datům (OMSI 2). Formát .o3d:
//
//   [0..1]  magie 0x84 0x19
//   [2]     verze (u8)
//   [3]     (verze>=3) flagy: bit0 = dlouhé indexy (u32), bit1 = alt scramble
//   [4..7]  (verze>=4) klíč (u32)
//   pak chunky s tagem:
//     0x17 vrcholy:  count (u32 když verze>=3, jinak u16) × 32 B
//                    (3×float pozice + 3×float normála + 2×float UV)
//     0x49 trojúhelníky: count × (3× index + u16 materiál)
//     0x26 materiály:    u16 count × (11 float + str8 textura)
//     0x79 matice:       16× float (4×4, row-major, translace v řádku 3)
//     0x54 kosti:        přeskakujeme
//
// KLÍČOVÉ: u verze 4+ s klíčem ≠ 0xFFFFFFFF jsou vrcholy PER-VERTEX „scrambled"
// (zaměněné osy pozice/normály + úprava UV) podle stavu odvozeného z klíče a
// z dat předchozích vrcholů. `unscramble` je odmotá přesně jako OMSI. Bez toho
// se nesymetrické meshe (hlavně ploché křižovatkové desky) vykreslí jako „krychle".

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

/** Míchací bajt z (ještě scramblované) pozice vrcholu - krmí stav dalšího vrcholu. */
function fracByte(x: number, y: number, z: number): number {
  const f = (v: number) => v - Math.trunc(v);
  const prod = Math.abs(f(x) * f(y) * f(z)) * 600.0;
  return ((Math.trunc(prod) % 256) + 256) % 256;
}

/** Odmotá per-vertex scrambling souborů verze 4+ (přesně dle OMSI / openOMSI). */
function unscramble(s: number, p: Float32Array, po: number, n: Float32Array, uv: Float32Array, uo: number): void {
  if (s < 1000) { const t = p[po]; p[po] = p[po + 1]; p[po + 1] = t; }
  else if (s < 3000) { const t = p[po]; p[po] = p[po + 2]; p[po + 2] = t; }
  else if (s > 7000) { const t = p[po + 1]; p[po + 1] = p[po + 2]; p[po + 2] = t; }
  if ((s & 3) === 0) n[po] = -n[po];
  if (s % 6 === 0) n[po + 1] = -n[po + 1];
  if (s % 7 === 0) n[po + 2] = -n[po + 2];
  if (s < 600) { const t = n[po + 1]; n[po + 1] = n[po + 2]; n[po + 2] = t; }
  else if (s > 4500) { const t = n[po]; n[po] = n[po + 1]; n[po + 1] = t; }
  else if (s > 6500) { const t = n[po]; n[po] = n[po + 2]; n[po + 2] = t; }
  if (s % 5 === 0) { const m = s % 100; uv[uo] -= (m * m) / 10000.0; }
  if (s % 3 === 0) { const m = s % 50; uv[uo + 1] -= (m * m) / 2500.0; }
}

/** Jednoduchý kurzor s kontrolou mezí (přes konec → vyhodí). */
class Cur {
  p = 0;
  constructor(private dv: DataView, private u8: Uint8Array) {}
  private need(k: number) { if (this.p + k > this.u8.length) throw new Error("eof"); }
  u8r(): number { this.need(1); return this.u8[this.p++]; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  skip(k: number) { this.need(k); this.p += k; }
  get end(): boolean { return this.p >= this.u8.length; }
}

export function parseO3D(buf: ArrayBuffer): O3DMesh | null {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const c = new Cur(dv, u8);
  try {
    if (c.u8r() !== 0x84 || c.u8r() !== 0x19) return null;
    const version = c.u8r();
    let longIndices = false, alt = false;
    if (version >= 3) { const flags = c.u8r(); longIndices = (flags & 1) !== 0; alt = (flags & 2) !== 0; }
    let key = 0;
    if (version >= 4) key = c.u32();
    const scrambled = version >= 4 && key !== 0xffffffff;
    let state = 0;
    if (scrambled) {
      const k = key + (version - 4) + (alt ? 0x17d : 0);
      state = ((k % 0xfde8) + 0xfde8) % 0xfde8;
    }
    const wide = version >= 3;

    let positions = new Float32Array(0);
    let normals = new Float32Array(0);
    let uvs = new Float32Array(0);
    let V = 0;
    const idxArr: number[] = [];
    const matArr: number[] = [];
    const materials: O3DMaterial[] = [];
    let transform: number[] | null = null;

    while (!c.end) {
      const tag = c.u8r();
      if (tag === 0x17) {
        const n = wide ? c.u32() : c.u16();
        const n16 = ((n % 0xfde8) + 0xfde8) % 0xfde8;
        positions = new Float32Array(n * 3);
        normals = new Float32Array(n * 3);
        uvs = new Float32Array(n * 2);
        V = n;
        let fb = 0;
        for (let i = 0; i < n; i++) {
          const o3 = i * 3, o2 = i * 2;
          positions[o3] = c.f32(); positions[o3 + 1] = c.f32(); positions[o3 + 2] = c.f32();
          normals[o3] = c.f32(); normals[o3 + 1] = c.f32(); normals[o3 + 2] = c.f32();
          uvs[o2] = c.f32(); uvs[o2 + 1] = c.f32();
          if (scrambled) {
            if (key === 0) state = alt ? 0x130 : 0;
            state = (state * n16 + n16 * fb) % 8000;
            fb = fracByte(positions[o3], positions[o3 + 1], positions[o3 + 2]);
            unscramble(state, positions, o3, normals, uvs, o2);
          }
        }
      } else if (tag === 0x49) {
        const n = wide ? c.u32() : c.u16();
        for (let i = 0; i < n; i++) {
          const a = longIndices ? c.u32() : c.u16();
          const b = longIndices ? c.u32() : c.u16();
          const d = longIndices ? c.u32() : c.u16();
          const mat = c.u16();
          idxArr.push(a, b, d);
          matArr.push(mat);
        }
      } else if (tag === 0x26) {
        const n = c.u16();
        for (let i = 0; i < n; i++) {
          const diffuse: [number, number, number, number] = [c.f32(), c.f32(), c.f32(), c.f32()];
          c.skip(28); // specular(3)+emissive(3)+specpower(1) = 7 float
          const len = c.u8r();
          let texture = "";
          for (let k = 0; k < len; k++) texture += String.fromCharCode(c.u8r());
          materials.push({ texture: texture.trim(), diffuse });
        }
      } else if (tag === 0x79) {
        transform = [];
        for (let i = 0; i < 16; i++) transform.push(c.f32());
      } else if (tag === 0x54) {
        const n = c.u16();
        for (let i = 0; i < n; i++) {
          const ln = c.u8r(); c.skip(ln);
          const w = c.u16();
          for (let j = 0; j < w; j++) { c.skip(longIndices ? 4 : 2); c.skip(4); }
        }
      }
      // jiný tag: přeskočíme (kurzor už posunut o 1 přečtením tagu)
    }

    if (V <= 0 || idxArr.length === 0) return null;

    // Transformační matice (0x79): aplikuj na pozice (u většiny meshů identita).
    if (transform) {
      const m = transform;
      let ident = true;
      const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > 1e-4) { ident = false; break; }
      if (!ident) {
        for (let i = 0; i < V; i++) {
          const o = i * 3, x = positions[o], y = positions[o + 1], z = positions[o + 2];
          positions[o] = x * m[0] + y * m[4] + z * m[8] + m[12];
          positions[o + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
          positions[o + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
        }
      }
    }

    // Vyhoď trojúhelníky s indexem mimo rozsah (jako OMSI loader).
    const T = idxArr.length / 3;
    const indices = new Uint32Array(idxArr.length);
    const matIndex = new Uint16Array(T);
    let t = 0;
    for (let i = 0; i < T; i++) {
      const a = idxArr[i * 3], b = idxArr[i * 3 + 1], d = idxArr[i * 3 + 2];
      if (a >= V || b >= V || d >= V) continue;
      indices[t * 3] = a; indices[t * 3 + 1] = b; indices[t * 3 + 2] = d;
      matIndex[t] = matArr[i];
      t++;
    }

    return {
      positions, normals, uvs,
      indices: indices.subarray(0, t * 3),
      matIndex: matIndex.subarray(0, t),
      materials,
      vertexCount: V,
      triangleCount: t,
    };
  } catch {
    return null;
  }
}
