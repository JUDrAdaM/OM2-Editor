const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");

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
  return text.replace(/^﻿/, "");
}

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0e1116",
    title: "OMSI 2 Map Editor",
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
    // DevTools jen na vyžádání: OMSI_DEVTOOLS=1
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
      // klíč = název .map (bez .terrain); posíláme jako Uint8Array (structured clone)
      terrains[entry.name.slice(0, -".terrain".length)] = new Uint8Array(buf);
    } else if (lower.endsWith(".map")) {
      const buf = await fs.readFile(path.join(dirPath, entry.name));
      tiles[entry.name] = decodeOmsi(buf);
    }
  }

  return { rootName: path.basename(dirPath), rootPath: dirPath, globalText, tiles, terrains };
}

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
      // UTF-16LE s BOM (formát OMSI)
      await fs.writeFile(target, Buffer.from("﻿" + t.content, "utf16le"));
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
