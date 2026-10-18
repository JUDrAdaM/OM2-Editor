const { contextBridge, ipcRenderer } = require("electron");

// Bezpečný most mezi rendererem a hlavním procesem.
// Renderer nemá přímý přístup k Node/fs – jen k těmto funkcím.
contextBridge.exposeInMainWorld("omsiAPI", {
  isElectron: true,

  // --- Instalace OMSI + seznam map ---
  /** Vrátí detekovaný (nebo uložený) kořen OMSI 2. */
  getRoot: () => ipcRenderer.invoke("omsi:getRoot"),
  /** Otevře dialog pro ruční výběr kořene OMSI 2 a uloží ho. */
  pickRoot: () => ipcRenderer.invoke("omsi:pickRoot"),
  /** Vrátí seznam map ve složce maps/. */
  listMaps: (omsiRoot) => ipcRenderer.invoke("omsi:listMaps", omsiRoot),
  /** Otevře mapu podle názvu složky pod <root>/maps. */
  openMapByFolder: (omsiRoot, folder) =>
    ipcRenderer.invoke("omsi:openMapByFolder", omsiRoot, folder),

  // --- Otevření libovolné složky dialogem + ukládání ---
  openMapFolder: () => ipcRenderer.invoke("omsi:openMapFolder"),
  saveTiles: (rootPath, tiles) => ipcRenderer.invoke("omsi:saveTiles", rootPath, tiles),
  saveTerrains: (rootPath, terrains) => ipcRenderer.invoke("omsi:saveTerrains", rootPath, terrains),
  readAsset: (omsiRoot, relPath) => ipcRenderer.invoke("omsi:readAsset", omsiRoot, relPath),
  /** Otevře dialog pro výběr souboru(ů) assetu; vrací cesty relativní ke kořeni OMSI. */
  pickAsset: (omsiRoot, kind) => ipcRenderer.invoke("omsi:pickAsset", omsiRoot, kind),

  // --- Verze + autoupdate ---
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
});
