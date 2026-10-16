const { contextBridge, ipcRenderer } = require("electron");

// Bezpečný most mezi rendererem a hlavním procesem.
// Renderer nemá přímý přístup k Node/fs – jen k těmto funkcím.
contextBridge.exposeInMainWorld("omsiAPI", {
  /**
   * Otevře nativní dialog pro výběr složky mapy a vrátí její obsah.
   * @returns {Promise<null | {error: string} | {rootName: string, globalText: string, tiles: Record<string,string>}>}
   */
  openMapFolder: () => ipcRenderer.invoke("omsi:openMapFolder"),
  /** Uloží dlaždice zpět do složky mapy. */
  saveTiles: (rootPath, tiles) => ipcRenderer.invoke("omsi:saveTiles", rootPath, tiles),
  readAsset: (omsiRoot, relPath) => ipcRenderer.invoke("omsi:readAsset", omsiRoot, relPath),
  isElectron: true,
});
