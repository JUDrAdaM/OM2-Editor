import { buildMap, parseGlobalCfg, serializeTile } from "../omsi/map";
import type { OmsiMap } from "../omsi/types";
import type { AssetSource } from "../viewport/models";

// Most do Electronu (viz electron/preload.cjs). V prohlížeči je undefined.
interface OmsiAPI {
  isElectron: boolean;
  openMapFolder: () => Promise<
    | null
    | { error: string }
    | {
        rootName: string;
        rootPath: string;
        globalText: string;
        tiles: Record<string, string>;
        terrains: Record<string, Uint8Array>;
      }
  >;
  saveTiles: (
    rootPath: string,
    tiles: { fileName: string; content: string }[]
  ) => Promise<{ error?: string; saved?: number }>;
  readAsset?: (omsiRoot: string, relPath: string) => Promise<Uint8Array | null>;
}
declare global {
  interface Window {
    omsiAPI?: OmsiAPI;
  }
}

// --- Dekódování (OMSI bývá UTF-16LE s BOM FF FE) ---
const utf16 = new TextDecoder("utf-16le");
const utf8 = new TextDecoder("utf-8");
const win1252 = new TextDecoder("windows-1252");

export function decodeOmsi(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = utf16.decode(buf);
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = utf8.decode(buf);
  else text = win1252.decode(buf);
  return text.replace(/^﻿/, "");
}

/** Zakóduje text jako UTF-16LE s BOM (formát OMSI). */
export function encodeOmsiUtf16(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

// Handle na složku (prohlížeč) pro pozdější zápis.
let dirHandle: FileSystemDirectoryHandle | null = null;

async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  const buf = await file.arrayBuffer();
  return decodeOmsi(buf);
}

/** Otevře složku mapy OMSI 2 a vrátí rozparsovaný model. */
export async function openMapFolder(): Promise<OmsiMap | null> {
  if (window.omsiAPI?.isElectron) {
    const data = await window.omsiAPI.openMapFolder();
    if (!data) return null;
    if ("error" in data) throw new Error(data.error);
    dirHandle = null;
    const terrains = new Map<string, ArrayBuffer>();
    for (const [name, bytes] of Object.entries(data.terrains ?? {})) {
      const u8 = bytes as Uint8Array;
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      terrains.set(name, ab);
    }
    return buildMap(
      data.rootName,
      data.globalText,
      new Map(Object.entries(data.tiles)),
      data.rootPath,
      terrains
    );
  }

  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      "Prohlížeč nepodporuje výběr složky (File System Access API). V desktop buildu (Electron) bude fungovat nativní dialog."
    );
  }
  const dir = await picker({ mode: "readwrite" });
  dirHandle = dir;
  return loadFromDirectoryHandle(dir);
}

export async function loadFromDirectoryHandle(
  dir: FileSystemDirectoryHandle
): Promise<OmsiMap> {
  let globalText = "";
  const tileTexts = new Map<string, string>();
  const terrains = new Map<string, ArrayBuffer>();

  // @ts-expect-error – .entries() je async iterable, ne vždy v lib.d.ts
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file") continue;
    const lower = name.toLowerCase();
    if (lower === "global.cfg") {
      globalText = await readFileText(handle as FileSystemFileHandle);
    } else if (lower.endsWith(".map.terrain")) {
      const file = await (handle as FileSystemFileHandle).getFile();
      terrains.set(name.slice(0, -".terrain".length), await file.arrayBuffer());
    } else if (lower.endsWith(".map")) {
      tileTexts.set(name, await readFileText(handle as FileSystemFileHandle));
    }
  }
  if (!globalText) {
    throw new Error("Ve složce není global.cfg – nevypadá to jako mapa OMSI 2.");
  }
  return buildMap(dir.name, globalText, tileTexts, "", terrains);
}

/**
 * DEV náhled: postaví mapu přímo ze složky pod OMSI rootem přes /omsi/ middleware
 * (bez nutnosti předgenerovaného JSONu). Velké mapy (stovky dlaždic) omezíme na
 * centrální shluk okolo centroidu, aby to prohlížeč zvládl.
 *
 * `relFolder` je cesta relativně ke kořeni OMSI, např. "maps/Lisen".
 * `maxTiles` = kolik dlaždic maximálně načíst (0 = všechny).
 */
export async function loadMapFromOmsiDev(
  relFolder: string,
  maxTiles = 25
): Promise<OmsiMap> {
  const base = "/omsi/" + relFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  const fetchBuf = async (rel: string): Promise<ArrayBuffer | null> => {
    try {
      const res = await fetch(base + "/" + rel.replace(/\\/g, "/"));
      return res.ok ? await res.arrayBuffer() : null;
    } catch {
      return null;
    }
  };

  const globalBuf = await fetchBuf("global.cfg");
  if (!globalBuf) throw new Error(`Nenalezen ${relFolder}/global.cfg (běží dev server s /omsi/?).`);
  const globalText = decodeOmsi(globalBuf);

  const g = parseGlobalCfg(globalText);
  if (g.tiles.length === 0) throw new Error("global.cfg neobsahuje žádné dlaždice [map].");

  // Výběr dlaždic: u velkých map jen `maxTiles` nejbližších centroidu.
  let chosen = g.tiles;
  if (maxTiles > 0 && g.tiles.length > maxTiles) {
    const cx = g.tiles.reduce((a, t) => a + t.tileX, 0) / g.tiles.length;
    const cy = g.tiles.reduce((a, t) => a + t.tileY, 0) / g.tiles.length;
    chosen = [...g.tiles]
      .sort((a, b) =>
        (a.tileX - cx) ** 2 + (a.tileY - cy) ** 2 -
        ((b.tileX - cx) ** 2 + (b.tileY - cy) ** 2))
      .slice(0, maxTiles);
  }
  const allow = new Set(chosen.map((t) => `${t.tileX},${t.tileY}`));

  // Načti .map + .map.terrain jen pro vybrané dlaždice (paralelně).
  const tileTexts = new Map<string, string>();
  const terrains = new Map<string, ArrayBuffer>();
  await Promise.all(chosen.map(async (t) => {
    const mapBuf = await fetchBuf(t.fileName);
    if (mapBuf) tileTexts.set(t.fileName, decodeOmsi(mapBuf));
    const terrBuf = await fetchBuf(t.fileName + ".terrain");
    if (terrBuf) terrains.set(t.fileName, terrBuf);
  }));

  const rootName = relFolder.split(/[\\/]/).pop() || relFolder;
  return buildMap(rootName, globalText, tileTexts, "", terrains,
    (x, y) => allow.has(`${x},${y}`));
}

/** Odvodí kořen OMSI z cesty mapy (…\OMSI 2\maps\<mapa> → …\OMSI 2). */
function deriveOmsiRoot(rootPath: string): string | null {
  const m = rootPath.match(/^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/i);
  return m ? m[1] : null;
}

/**
 * Vytvoří zdroj assetů (modely/textury) pro danou mapu:
 *  - Electron: nativní čtení z kořene OMSI (odvozeno z cesty mapy),
 *  - DEV náhled: fetch přes /omsi/ middleware,
 *  - jinak: null (jen boxy).
 */
export function createAssetSource(map: OmsiMap): AssetSource | null {
  const omsiRoot = deriveOmsiRoot(map.rootPath);
  if (window.omsiAPI?.isElectron && window.omsiAPI.readAsset && omsiRoot) {
    const api = window.omsiAPI;
    return {
      async readFile(rel: string) {
        const u8 = await api.readAsset!(omsiRoot, rel);
        if (!u8) return null;
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      },
    };
  }
  if (import.meta.env.DEV) {
    return {
      async readFile(rel: string) {
        try {
          const res = await fetch("/omsi/" + rel.replace(/\\/g, "/"));
          return res.ok ? await res.arrayBuffer() : null;
        } catch {
          return null;
        }
      },
    };
  }
  return null;
}

/** Uloží všechny „dirty" dlaždice zpět na disk. Vrátí počet uložených. */
export async function saveMap(map: OmsiMap): Promise<number> {
  const dirty = map.tiles.filter((t) => t.dirty);
  if (dirty.length === 0) return 0;

  const payload = dirty.map((t) => ({
    fileName: t.fileName,
    content: serializeTile(t),
  }));

  if (window.omsiAPI?.isElectron) {
    const res = await window.omsiAPI.saveTiles(map.rootPath, payload);
    if (res.error) throw new Error(res.error);
    dirty.forEach((t) => (t.dirty = false));
    return res.saved ?? dirty.length;
  }

  if (dirHandle) {
    for (const p of payload) {
      const fh = await dirHandle.getFileHandle(p.fileName, { create: false });
      const w = await fh.createWritable();
      await w.write(new Blob([encodeOmsiUtf16(p.content) as BlobPart]));
      await w.close();
    }
    dirty.forEach((t) => (t.dirty = false));
    return payload.length;
  }

  throw new Error("Není kam uložit – otevři mapu tlačítkem Otevřít mapu (desktop build).");
}
