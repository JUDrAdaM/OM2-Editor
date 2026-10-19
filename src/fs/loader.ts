import { buildMap, parseGlobalCfg, serializeTile } from "../omsi/map";
import type { OmsiMap, TerrainData } from "../omsi/types";

/** Serializuje výškmapu dlaždice do binárního *.terrain (int32 dílky + float32 výšky LE). */
function serializeTerrain(t: TerrainData): Uint8Array {
  const segments = t.size - 1;
  const out = new Uint8Array(4 + t.size * t.size * 4);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, segments, true);
  for (let i = 0; i < t.size * t.size; i++) dv.setFloat32(4 + i * 4, t.heights[i] as number, true);
  return out;
}
import type { AssetSource } from "../viewport/models";

// Most do Electronu (viz electron/preload.cjs). V prohlížeči je undefined.
type MapFolderResult =
  | null
  | { error: string }
  | {
      rootName: string;
      rootPath: string;
      globalText: string;
      tiles: Record<string, string>;
      terrains: Record<string, Uint8Array>;
    };

export interface OmsiMapEntry {
  folder: string;
  name: string;
  tileCount: number;
}

export interface UpdateStatus {
  state: "checking" | "available" | "none" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

interface OmsiAPI {
  isElectron: boolean;
  getRoot?: () => Promise<{ root: string | null }>;
  pickRoot?: () => Promise<{ root?: string | null; error?: string }>;
  listMaps?: (
    omsiRoot: string | null
  ) => Promise<{ root?: string | null; maps: OmsiMapEntry[]; error?: string }>;
  openMapByFolder?: (
    omsiRoot: string | null,
    folder: string
  ) => Promise<MapFolderResult | { error: string }>;
  openMapFolder: () => Promise<MapFolderResult>;
  saveTiles: (
    rootPath: string,
    tiles: { fileName: string; content: string }[]
  ) => Promise<{ error?: string; saved?: number }>;
  saveTerrains?: (
    rootPath: string,
    terrains: { fileName: string; data: Uint8Array }[]
  ) => Promise<{ error?: string; saved?: number }>;
  readAsset?: (omsiRoot: string, relPath: string) => Promise<Uint8Array | null>;
  pickAsset?: (
    omsiRoot: string | null,
    kind: AssetKind
  ) => Promise<{ rels?: string[]; canceled?: boolean; error?: string }>;
  addTileEntries?: (
    rootPath: string,
    entries: { tileX: number; tileY: number; fileName: string }[]
  ) => Promise<{ ok?: boolean; error?: string }>;
  getVersion?: () => Promise<string>;
  checkUpdate?: () => Promise<{ ok: boolean; message?: string }>;
  installUpdate?: () => Promise<{ ok: boolean }>;
  onUpdateStatus?: (cb: (s: UpdateStatus) => void) => () => void;
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

/** Je aplikace spuštěná jako desktop (Electron)? */
export function isElectronApp(): boolean {
  return !!window.omsiAPI?.isElectron;
}

// ---------------------------------------------------------------------------
// Limit renderovaných dlaždic (anti-crash u velkých map)
// ---------------------------------------------------------------------------
const TILE_LIMIT_KEY = "om2.maxTiles.v1";
/** Výchozí strop: kolik dlaždic velké mapy se načte/zobrazí (shluk kolem středu).
 *  Díky deduplikaci textur (sdílená GPU paměť) a sloučení instancí zvládne editor
 *  i stovky dlaždic bez pádu; strop drží hlavně plynulost overview u hustých map.
 *  150 je rozumný kompromis; v Nastavení lze zvýšit (ověřeno i 250 na Líšni). */
export const DEFAULT_TILE_LIMIT = 150;

/** Aktuální strop dlaždic z Nastavení (localStorage). 0 = bez limitu (vše). */
export function getRenderTileLimit(): number {
  try {
    const raw = localStorage.getItem(TILE_LIMIT_KEY);
    if (raw == null) return DEFAULT_TILE_LIMIT;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TILE_LIMIT;
  } catch {
    return DEFAULT_TILE_LIMIT;
  }
}

/** Uloží strop dlaždic (0 = vše). */
export function setRenderTileLimit(n: number): void {
  try {
    localStorage.setItem(TILE_LIMIT_KEY, String(Math.max(0, Math.floor(n))));
  } catch {
    /* localStorage nedostupné - ignoruj */
  }
}

// ---------------------------------------------------------------------------
// Verze aplikace + autoupdate (tenké obaly nad omsiAPI)
// ---------------------------------------------------------------------------

/** Kanonická verze z package.json (např. „0.0.12-alpha"). Prázdné mimo desktop. */
export async function getAppVersion(): Promise<string> {
  if (!window.omsiAPI?.getVersion) return "";
  try {
    return await window.omsiAPI.getVersion();
  } catch {
    return "";
  }
}

/**
 * Převede semver na „přívětivou" podobu, kterou používáme v UI:
 *   0.0.12-alpha   → 0.0.12a   (alpha = „a")
 *   0.0.12-beta.2  → 0.0.12b   (beta  = „b")
 *   0.0.12-rc.1    → 0.0.12rc
 *   1.0.0          → 1.0.0     (stabilní beze změny)
 * Neznámý tvar vrací beze změny.
 */
export function formatVersion(v: string): string {
  if (!v) return "-";
  const m = v.match(/^(\d+\.\d+\.\d+)-(alpha|beta|rc)(?:\.\d+)?$/i);
  if (!m) return v;
  const suffix: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
  return m[1] + (suffix[m[2].toLowerCase()] ?? "");
}

/** Lidský název kanálu z verze (pro popisek v Nastavení). */
export function versionChannel(v: string): string {
  if (/-alpha(\.\d+)?$/i.test(v)) return "Alpha";
  if (/-beta(\.\d+)?$/i.test(v)) return "Beta";
  if (/-rc(\.\d+)?$/i.test(v)) return "Release candidate";
  if (/^\d+\.\d+\.\d+$/.test(v)) return "Stabilní";
  return "";
}

/** Ruční kontrola aktualizací (stav pak přichází přes onUpdateStatus). */
export async function checkForUpdate(): Promise<{ ok: boolean; message?: string }> {
  if (!window.omsiAPI?.checkUpdate) {
    return { ok: false, message: "Aktualizace jsou dostupné jen v desktop aplikaci." };
  }
  return window.omsiAPI.checkUpdate();
}

/** Restartuje a nainstaluje stažené aktualizace. */
export async function installUpdate(): Promise<void> {
  await window.omsiAPI?.installUpdate?.();
}

/** Přihlásí se k odběru stavu aktualizací. Vrací odhlašovací funkci. */
export function onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
  return window.omsiAPI?.onUpdateStatus?.(cb) ?? (() => {});
}

/** Vrátí detekovaný / uložený kořen OMSI 2 (nebo null). */
export async function getOmsiRoot(): Promise<string | null> {
  if (!window.omsiAPI?.getRoot) return null;
  const r = await window.omsiAPI.getRoot();
  return r.root;
}

/** Nechá uživatele ručně vybrat kořen OMSI 2 (uloží se). */
export async function pickOmsiRoot(): Promise<string | null> {
  if (!window.omsiAPI?.pickRoot) return null;
  const r = await window.omsiAPI.pickRoot();
  if (r.error) throw new Error(r.error);
  return r.root ?? null;
}

/** Seznam map pod <root>/maps. */
export async function listOmsiMaps(
  omsiRoot: string | null
): Promise<{ root: string | null; maps: OmsiMapEntry[] }> {
  if (!window.omsiAPI?.listMaps) return { root: null, maps: [] };
  const r = await window.omsiAPI.listMaps(omsiRoot);
  if (r.error && (!r.maps || r.maps.length === 0)) {
    return { root: r.root ?? null, maps: [] };
  }
  return { root: r.root ?? omsiRoot, maps: r.maps ?? [] };
}

/** Postaví OmsiMap z výsledku čtení složky (Electron IPC). */
function buildFromFolderResult(data: Exclude<MapFolderResult, null | { error: string }>): OmsiMap {
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
    terrains,
    undefined,
    getRenderTileLimit()
  );
}

/** Otevře mapu podle názvu složky pod <root>/maps (desktop). */
export async function openMapByFolder(
  omsiRoot: string | null,
  folder: string
): Promise<OmsiMap> {
  if (!window.omsiAPI?.openMapByFolder) {
    throw new Error("Tato funkce je dostupná jen v desktop aplikaci.");
  }
  const data = await window.omsiAPI.openMapByFolder(omsiRoot, folder);
  if (!data) throw new Error("Mapu se nepodařilo načíst.");
  if ("error" in data) throw new Error(data.error);
  return buildFromFolderResult(data);
}

/** Otevře složku mapy OMSI 2 a vrátí rozparsovaný model. */
export async function openMapFolder(): Promise<OmsiMap | null> {
  if (window.omsiAPI?.isElectron) {
    const data = await window.omsiAPI.openMapFolder();
    if (!data) return null;
    if ("error" in data) throw new Error(data.error);
    return buildFromFolderResult(data);
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

  // @ts-expect-error - .entries() je async iterable, ne vždy v lib.d.ts
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
    throw new Error("Ve složce není global.cfg - nevypadá to jako mapa OMSI 2.");
  }
  return buildMap(dir.name, globalText, tileTexts, "", terrains, undefined, getRenderTileLimit());
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

/** Kořen OMSI pro danou mapu (pro čtení/procházení assetů). */
export function omsiRootOf(map: OmsiMap): string | null {
  return deriveOmsiRoot(map.rootPath);
}

/** Druh assetu pro procházení (dialog filtruje přípony + výchozí podsložku). */
export type AssetKind = "object" | "spline" | "texture";

/**
 * Nechá uživatele vybrat soubor(y) assetu z instalace OMSI (desktop). Vrací cesty
 * RELATIVNÍ ke kořeni OMSI (zpětná lomítka), použitelné přímo v mapě. V prohlížeči
 * (dev náhled) není nativní dialog k dispozici → prázdné pole.
 */
export async function pickAssetFiles(kind: AssetKind, omsiRoot: string | null): Promise<string[]> {
  if (!window.omsiAPI?.pickAsset) return [];
  const r = await window.omsiAPI.pickAsset(omsiRoot, kind);
  if (r?.error) throw new Error(r.error);
  return r?.rels ?? [];
}

/**
 * Vytvoří zdroj assetů (modely/textury) pro danou mapu:
 *  - Electron: nativní čtení z kořene OMSI (odvozeno z cesty mapy),
 *  - DEV náhled: fetch přes /omsi/ middleware,
 *  - jinak: null (jen boxy).
 */
export function createAssetSource(map: OmsiMap): AssetSource | null {
  const omsiRoot = deriveOmsiRoot(map.rootPath);
  let base: AssetSource | null = null;
  if (window.omsiAPI?.isElectron && window.omsiAPI.readAsset && omsiRoot) {
    const api = window.omsiAPI;
    base = {
      async readFile(rel: string) {
        const u8 = await api.readAsset!(omsiRoot, rel);
        if (!u8) return null;
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      },
    };
  } else if (import.meta.env.DEV) {
    base = {
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
  if (!base) return null;
  // Negativní cache: cesty, které už vrátily null (chybějící soubory), se znovu
  // nečtou. textureCandidates zkouší až 9 variant na objekt → jinak stovky
  // opakovaných 404 v konzoli a zbytečné I/O u velkých map. Pozitivní výsledky
  // necachujeme (ArrayBuffery jsou velké; modely/splajny mají vlastní cache).
  const missing = new Set<string>();
  const inner = base;
  return {
    async readFile(rel: string) {
      if (missing.has(rel)) return null;
      const buf = await inner.readFile(rel);
      if (!buf) missing.add(rel);
      return buf;
    },
  };
}

/** Doplní záznamy [map] na konec global.cfg přes File System Access handle
 *  (prohlížeč). Zachová existující bajty i kódování (append-only). */
async function appendTileEntriesToHandle(
  dir: FileSystemDirectoryHandle,
  entries: { tileX: number; tileY: number; fileName: string }[]
): Promise<void> {
  const fh = await dir.getFileHandle("global.cfg", { create: false });
  const file = await fh.getFile();
  const buf = new Uint8Array(await file.arrayBuffer());
  const isUtf16 = buf[0] === 0xff && buf[1] === 0xfe;
  const isUtf8Bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const addText = "\r\n" + entries.map((e) => `[map]\r\n${e.tileX}\r\n${e.tileY}\r\n${e.fileName}`).join("\r\n") + "\r\n";
  let addBytes: Uint8Array;
  if (isUtf16) {
    addBytes = new Uint8Array(addText.length * 2);
    for (let i = 0; i < addText.length; i++) {
      const c = addText.charCodeAt(i);
      addBytes[i * 2] = c & 0xff; addBytes[i * 2 + 1] = (c >> 8) & 0xff;
    }
  } else if (isUtf8Bom) {
    addBytes = new TextEncoder().encode(addText);
  } else {
    addBytes = new Uint8Array(addText.length);
    for (let i = 0; i < addText.length; i++) addBytes[i] = addText.charCodeAt(i) & 0xff;
  }
  const out = new Uint8Array(buf.length + addBytes.length);
  out.set(buf, 0); out.set(addBytes, buf.length);
  const w = await fh.createWritable();
  await w.write(new Blob([out as BlobPart]));
  await w.close();
}

/** Uloží všechny „dirty" dlaždice zpět na disk. Vrátí počet uložených. */
export async function saveMap(map: OmsiMap): Promise<number> {
  const dirty = map.tiles.filter((t) => t.dirty);
  if (dirty.length === 0) return 0;

  const payload = dirty.map((t) => ({
    fileName: t.fileName,
    content: serializeTile(t),
  }));

  // Terén dirty dlaždic (úprava výšky) - binární *.terrain vedle *.map.
  const terrains = dirty
    .filter((t) => t.terrain)
    .map((t) => ({ fileName: t.fileName + ".terrain", data: serializeTerrain(t.terrain!) }));

  // Nové dlaždice (přidané v editoru) je třeba doplnit do global.cfg.
  const newTiles = dirty
    .filter((t) => t.isNew)
    .map((t) => ({ tileX: t.tileX, tileY: t.tileY, fileName: t.fileName }));

  if (window.omsiAPI?.isElectron) {
    const res = await window.omsiAPI.saveTiles(map.rootPath, payload);
    if (res.error) throw new Error(res.error);
    if (terrains.length && window.omsiAPI.saveTerrains) {
      const tr = await window.omsiAPI.saveTerrains(map.rootPath, terrains);
      if (tr.error) throw new Error(tr.error);
    }
    if (newTiles.length && window.omsiAPI.addTileEntries) {
      const ae = await window.omsiAPI.addTileEntries(map.rootPath, newTiles);
      if (ae.error) throw new Error(ae.error);
    }
    dirty.forEach((t) => { t.dirty = false; t.isNew = false; });
    return res.saved ?? dirty.length;
  }

  if (dirHandle) {
    for (const p of payload) {
      const fh = await dirHandle.getFileHandle(p.fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([encodeOmsiUtf16(p.content) as BlobPart]));
      await w.close();
    }
    for (const tr of terrains) {
      const fh = await dirHandle.getFileHandle(tr.fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([tr.data as BlobPart]));
      await w.close();
    }
    if (newTiles.length) await appendTileEntriesToHandle(dirHandle, newTiles);
    dirty.forEach((t) => { t.dirty = false; t.isNew = false; });
    return payload.length;
  }

  throw new Error("Není kam uložit - otevři mapu tlačítkem Otevřít mapu (desktop build).");
}
