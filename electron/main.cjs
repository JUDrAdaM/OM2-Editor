const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const { execFileSync } = require("child_process");

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5180";

// OMSI soubory bývají UTF-16LE (BOM FF FE), výjimečně UTF-8 nebo Windows-1252.
const utf16 = new TextDecoder("utf-16le");
const utf8 = new TextDecoder("utf-8");
const win1252 = new TextDecoder("windows-1252");
function decodeOmsi(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = utf16.decode(buf);
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = utf8.decode(buf);
  else text = win1252.decode(buf);
  return text.replace(/^\uFEFF/, "");
}

/** @type {BrowserWindow | null} */
let win = null;

// ---------------------------------------------------------------------------
// Konfigurace (userData/config.json) – pamatuje si cestu k OMSI.
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function loadConfig() {
  try {
    return JSON.parse(fssync.readFileSync(configPath(), "utf8")) || {};
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fssync.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    /* ignoruj – není kritické */
  }
}

// ---------------------------------------------------------------------------
// Detekce instalace OMSI 2.
// ---------------------------------------------------------------------------
/** Vypadá daná složka jako kořen OMSI 2? (Omsi.exe nebo složka maps) */
function looksLikeOmsiRoot(dir) {
  if (!dir) return false;
  try {
    if (!fssync.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const names = (() => {
    try {
      return fssync.readdirSync(dir);
    } catch {
      return [];
    }
  })();
  const lower = names.map((n) => n.toLowerCase());
  return lower.includes("omsi.exe") || lower.includes("maps");
}

/** Cesta ke Steamu z registru (HKCU\Software\Valve\Steam \ SteamPath). */
function steamPathFromRegistry() {
  if (process.platform !== "win32") return null;
  for (const key of [
    "HKCU\\Software\\Valve\\Steam",
    "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
    "HKLM\\SOFTWARE\\Valve\\Steam",
  ]) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "SteamPath"], {
        encoding: "utf8",
      });
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) return m[1].trim().replace(/\\/g, "/");
    } catch {
      /* zkus další klíč */
    }
    try {
      const out = execFileSync("reg", ["query", key, "/v", "InstallPath"], {
        encoding: "utf8",
      });
      const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (m) return m[1].trim().replace(/\\/g, "/");
    } catch {
      /* nic */
    }
  }
  return null;
}

/** Všechny knihovny Steamu z libraryfolders.vdf. */
function steamLibraries(steamPath) {
  const libs = [steamPath];
  for (const rel of ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"]) {
    const vdf = path.join(steamPath, rel);
    try {
      const text = fssync.readFileSync(vdf, "utf8");
      const re = /"path"\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(text))) libs.push(m[1].replace(/\\\\/g, "/").replace(/\\/g, "/"));
    } catch {
      /* vdf nemusí existovat */
    }
  }
  return [...new Set(libs)];
}

/** Najde kořen OMSI 2. Pořadí: uložená cesta → Steam registr/knihovny → běžné cesty. */
function detectOmsiRoot() {
  const cfg = loadConfig();
  if (cfg.omsiRoot && looksLikeOmsiRoot(cfg.omsiRoot)) return cfg.omsiRoot;

  const candidates = [];
  const steam = steamPathFromRegistry();
  if (steam) {
    for (const lib of steamLibraries(steam)) {
      candidates.push(path.join(lib, "steamapps/common/OMSI 2"));
    }
  }
  // Běžné pevné cesty (včetně této instalace).
  candidates.push(
    "C:/Program Files (x86)/Steam/steamapps/common/OMSI 2",
    "C:/Program Files/Steam/steamapps/common/OMSI 2",
    "D:/Steam/steamapps/common/OMSI 2",
    "D:/steam app/steamapps/common/OMSI 2",
    "D:/SteamLibrary/steamapps/common/OMSI 2",
    "E:/SteamLibrary/steamapps/common/OMSI 2"
  );
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/");
    if (looksLikeOmsiRoot(norm)) return norm;
  }
  return null;
}

/** Vyčte "přívětivý" název mapy z global.cfg (sekce [friendlyname]). */
function readFriendlyName(globalText, fallback) {
  const lines = globalText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === "[friendlyname]") {
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j].trim();
        if (v) return v;
      }
    }
  }
  return fallback;
}

/** Seznam map pod <root>/maps: složky obsahující global.cfg. */
function listMaps(omsiRoot) {
  const mapsDir = path.join(omsiRoot, "maps");
  let entries;
  try {
    entries = fssync.readdirSync(mapsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(mapsDir, e.name);
    let names;
    try {
      names = fssync.readdirSync(dir);
    } catch {
      continue;
    }
    const gc = names.find((n) => n.toLowerCase() === "global.cfg");
    if (!gc) continue;
    let friendly = e.name;
    let tileCount = 0;
    try {
      const buf = fssync.readFileSync(path.join(dir, gc));
      const text = decodeOmsi(buf);
      friendly = readFriendlyName(text, e.name);
      tileCount = (text.match(/\[map\]/gi) || []).length;
    } catch {
      /* ponech výchozí */
    }
    out.push({ folder: e.name, name: friendly, tileCount });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "cs"));
  return out;
}

// ---------------------------------------------------------------------------
// Okno
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0e1116",
    title: "OM2-Editor",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    win.loadURL(DEV_SERVER_URL);
    if (process.env.OMSI_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  }

  win.on("closed", () => {
    win = null;
  });
}

/** Přečte složku mapy OMSI 2: global.cfg + všechny *.map dlaždice. */
async function readMapFolder(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let globalText = "";
  /** @type {Record<string,string>} */
  const tiles = {};
  /** @type {Record<string,Uint8Array>} */
  const terrains = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower === "global.cfg") {
      const buf = await fs.readFile(path.join(dirPath, entry.name));
      globalText = decodeOmsi(buf);
    } else if (lower.endsWith(".map.terrain")) {
      const buf = await fs.readFile(path.join(dirPath, entry.name));
      terrains[entry.name.slice(0, -".terrain".length)] = new Uint8Array(buf);
    } else if (lower.endsWith(".map")) {
      const buf = await fs.readFile(path.join(dirPath, entry.name));
      tiles[entry.name] = decodeOmsi(buf);
    }
  }

  return { rootName: path.basename(dirPath), rootPath: dirPath, globalText, tiles, terrains };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle("omsi:getRoot", async () => {
  const root = detectOmsiRoot();
  return { root: root || null };
});

ipcMain.handle("omsi:pickRoot", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Vyber složku instalace OMSI 2 (obsahuje Omsi.exe a složku maps)",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { root: null };
  const dir = result.filePaths[0].replace(/\\/g, "/");
  if (!looksLikeOmsiRoot(dir)) {
    return { error: "Tato složka nevypadá jako OMSI 2 (chybí Omsi.exe i složka maps)." };
  }
  const cfg = loadConfig();
  cfg.omsiRoot = dir;
  saveConfig(cfg);
  return { root: dir };
});

ipcMain.handle("omsi:listMaps", async (_e, omsiRoot) => {
  try {
    const root = omsiRoot || detectOmsiRoot();
    if (!root) return { error: "OMSI 2 nenalezeno.", root: null, maps: [] };
    return { root, maps: listMaps(root) };
  } catch (err) {
    return { error: String((err && err.message) || err), maps: [] };
  }
});

ipcMain.handle("omsi:openMapByFolder", async (_e, omsiRoot, folder) => {
  try {
    const root = omsiRoot || detectOmsiRoot();
    if (!root) return { error: "OMSI 2 nenalezeno." };
    const dirPath = path.join(root, "maps", folder);
    if (!path.resolve(dirPath).startsWith(path.resolve(path.join(root, "maps")))) {
      return { error: "Neplatná cesta mapy." };
    }
    const data = await readMapFolder(dirPath);
    if (!data.globalText) return { error: "Ve složce není global.cfg." };
    return data;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("omsi:openMapFolder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Vyber složku mapy OMSI 2 (obsahuje global.cfg)",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dirPath = result.filePaths[0];
  const data = await readMapFolder(dirPath);
  if (!data.globalText) {
    return { error: "Ve složce není global.cfg – nevypadá to jako mapa OMSI 2." };
  }
  return data;
});

ipcMain.handle("omsi:saveTiles", async (_e, rootPath, tiles) => {
  try {
    if (!rootPath) return { error: "Chybí cesta ke složce mapy." };
    let saved = 0;
    for (const t of tiles) {
      const target = path.join(rootPath, t.fileName);
      await fs.writeFile(target, Buffer.from("\uFEFF" + t.content, "utf16le"));
      saved++;
    }
    return { saved };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("omsi:saveTerrains", async (_e, rootPath, terrains) => {
  try {
    if (!rootPath) return { error: "Chybí cesta ke složce mapy." };
    let saved = 0;
    for (const t of terrains) {
      const target = path.join(rootPath, t.fileName);
      await fs.writeFile(target, Buffer.from(t.data));
      saved++;
    }
    return { saved };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("omsi:readAsset", async (_e, omsiRoot, relPath) => {
  try {
    if (!omsiRoot) return null;
    const target = path.resolve(path.join(omsiRoot, String(relPath).replace(/[\\/]+/g, path.sep)));
    if (!target.startsWith(path.resolve(omsiRoot))) return null; // mimo kořen
    const buf = await fs.readFile(target);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
});

ipcMain.handle("omsi:pickAsset", async (_e, omsiRoot, kind) => {
  try {
    const root = (omsiRoot || detectOmsiRoot());
    if (!root) return { error: "OMSI 2 nenalezeno." };
    const spec = {
      object: { sub: "Sceneryobjects", filters: [{ name: "OMSI objekty (.sco)", extensions: ["sco"] }] },
      spline: { sub: "Splines", filters: [{ name: "OMSI splajny (.sli)", extensions: ["sli"] }] },
      texture: { sub: "Texture", filters: [{ name: "Textury", extensions: ["dds", "tga", "bmp", "png", "jpg", "jpeg"] }] },
    }[kind] || { sub: "", filters: [{ name: "Vše", extensions: ["*"] }] };
    let defaultPath = path.join(root, spec.sub);
    if (!fssync.existsSync(defaultPath)) defaultPath = root;
    const result = await dialog.showOpenDialog(win, {
      title: "Vyber soubor(y) z instalace OMSI 2",
      defaultPath,
      properties: ["openFile", "multiSelections"],
      filters: [...spec.filters, { name: "Všechny soubory", extensions: ["*"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const rootResolved = path.resolve(root);
    const rels = [];
    for (const fp of result.filePaths) {
      const rel = path.relative(rootResolved, path.resolve(fp));
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // mimo kořen OMSI
      rels.push(rel.replace(/\//g, "\\")); // OMSI používá zpětná lomítka
    }
    if (rels.length === 0) return { error: "Soubor musí být uvnitř složky OMSI 2." };
    return { rels };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("app:getVersion", async () => app.getVersion());

// ---------------------------------------------------------------------------
// Autoupdate (electron-updater, jen v zabalené aplikaci)
// ---------------------------------------------------------------------------
function setupAutoUpdate() {
  if (!app.isPackaged) {
    // Ve vývoji (nezabalená app) autoupdate neběží – ať UI dostane čistou hlášku
    // místo „No handler registered".
    ipcMain.handle("update:check", async () => ({
      ok: false,
      message: "Aktualizace jsou dostupné jen v nainstalované aplikaci (ne ve vývoji).",
    }));
    ipcMain.handle("update:install", async () => ({ ok: false }));
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return; // závislost nedostupná
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Jsme na prerelease kanálu (alpha/beta) → ber i prerelease vydání z GitHubu.
  autoUpdater.allowPrerelease = true;

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  autoUpdater.on("checking-for-update", () => send("update:status", { state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    send("update:status", { state: "available", version: info.version })
  );
  autoUpdater.on("update-not-available", () => send("update:status", { state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    send("update:status", { state: "downloading", percent: Math.round(p.percent) })
  );
  autoUpdater.on("update-downloaded", (info) =>
    send("update:status", { state: "downloaded", version: info.version })
  );
  autoUpdater.on("error", (err) =>
    send("update:status", { state: "error", message: String((err && err.message) || err) })
  );

  ipcMain.handle("update:check", async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("update:install", async () => {
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  // Kontrola krátce po startu.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
