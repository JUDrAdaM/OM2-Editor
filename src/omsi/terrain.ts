import { TILE_SIZE } from "./types";
import type { TerrainData } from "./types";

/**
 * Naparsuje binární *.terrain dlaždice.
 * Formát (ověřeno na reálné mapě Grundorf): int32 LE hlavička = počet dílků (60),
 * následuje (dílky+1)² float32 LE výšek v metrech, row-major.
 */
export function parseTerrain(buf: ArrayBuffer): TerrainData | null {
  if (buf.byteLength < 8) return null;
  const dv = new DataView(buf);
  const segments = dv.getInt32(0, true);
  if (segments < 1 || segments > 4096) return null;
  const size = segments + 1;
  const need = 4 + size * size * 4;
  if (buf.byteLength < need) return null;
  const heights = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    heights[i] = dv.getFloat32(4 + i * 4, true);
  }
  return { size, heights };
}

/** Index bodu mřížky (col = x, row = y). */
function at(t: TerrainData, col: number, row: number): number {
  return t.heights[row * t.size + col];
}

/**
 * Bilineárně interpolovaná výška terénu v lokálních souřadnicích dlaždice (0..TILE_SIZE).
 */
export function terrainHeightAt(t: TerrainData, x: number, y: number): number {
  const step = TILE_SIZE / (t.size - 1);
  let gx = x / step;
  let gy = y / step;
  const maxG = t.size - 1;
  gx = Math.min(Math.max(gx, 0), maxG);
  gy = Math.min(Math.max(gy, 0), maxG);
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  const i1 = Math.min(i0 + 1, maxG);
  const j1 = Math.min(j0 + 1, maxG);
  const fx = gx - i0;
  const fy = gy - j0;
  const h00 = at(t, i0, j0);
  const h10 = at(t, i1, j0);
  const h01 = at(t, i0, j1);
  const h11 = at(t, i1, j1);
  const a = h00 * (1 - fx) + h10 * fx;
  const b = h01 * (1 - fx) + h11 * fx;
  return a * (1 - fy) + b * fy;
}
