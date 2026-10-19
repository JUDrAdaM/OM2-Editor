import {
  getOmsiRoot,
  pickOmsiRoot,
  listOmsiMaps,
  openMapByFolder,
  openMapFolder,
  isElectronApp,
  getAppVersion,
  formatVersion,
  type OmsiMapEntry,
  type UpdateStatus,
} from "../fs/loader";
import { openSettings } from "./settings";
import { openNewMap } from "./newmap";
import { createDemoMap } from "../omsi/demo";
import type { OmsiMap } from "../omsi/types";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Úvodní obrazovka: detekce OMSI, seznam map, ruční cesta, demo, autoupdate. */
export class StartMenu {
  private root: HTMLElement;
  private onMap: (map: OmsiMap, status: string) => void;
  private omsiRoot: string | null = null;
  private maps: OmsiMapEntry[] = [];

  private rootPathEl!: HTMLElement;
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private updateEl!: HTMLElement;
  private versionEl!: HTMLElement;
  private unsubUpdate: (() => void) | null = null;

  constructor(root: HTMLElement, onMap: (map: OmsiMap, status: string) => void) {
    this.root = root;
    this.onMap = onMap;
  }

  async show() {
    this.render();
    await this.refreshRootAndMaps();
    this.setupUpdates();
  }

  private render() {
    this.root.innerHTML = "";
    const screen = el("div", "menu-screen");

    const card = el("div", "menu-card");

    const header = el("div", "menu-header");
    header.append(
      el("span", "brand-mark menu-mark", "◆"),
      el("div", "menu-titles")
    );
    const titles = header.lastChild as HTMLElement;
    titles.append(
      el("h1", "menu-title", "OM2-Editor"),
      el("div", "menu-subtitle", "Moderní 3D editor map pro OMSI 2")
    );
    const settingsBtn = el("button", "btn btn-sm", "⚙ Nastavení");
    settingsBtn.addEventListener("click", () =>
      openSettings(() => this.refreshRootAndMaps())
    );
    header.append(el("div", "spacer"), settingsBtn);
    card.append(header);

    // Verze editoru (vedle hlavičky).
    this.versionEl = el("div", "menu-version", "");
    titles.append(this.versionEl);
    void this.loadVersion();

    // Řádek s cestou k OMSI
    const pathRow = el("div", "menu-path");
    this.rootPathEl = el("div", "menu-path-val", "Hledám instalaci OMSI 2…");
    const changeBtn = el("button", "btn btn-sm", "Změnit cestu…");
    changeBtn.addEventListener("click", () => this.handlePickRoot());
    pathRow.append(el("span", "menu-path-key", "OMSI 2:"), this.rootPathEl, changeBtn);
    card.append(pathRow);

    // Akce
    const actions = el("div", "menu-actions");
    const newMapBtn = el("button", "btn btn-primary", "✚ Nová mapa");
    newMapBtn.addEventListener("click", () => this.handleNewMap());
    if (!isElectronApp()) {
      newMapBtn.disabled = true;
      newMapBtn.title = "Vytvoření nové mapy je dostupné jen v desktop aplikaci.";
    }
    const openFolderBtn = el("button", "btn", "Otevřít složku mapy…");
    openFolderBtn.addEventListener("click", () => this.handleOpenFolder());
    const demoBtn = el("button", "btn", "Demo mapa");
    demoBtn.addEventListener("click", () =>
      this.onMap(createDemoMap(), "Demo mapa načtena.")
    );
    const refreshBtn = el("button", "btn", "Obnovit seznam");
    refreshBtn.addEventListener("click", () => this.refreshRootAndMaps());
    actions.append(newMapBtn, openFolderBtn, demoBtn, refreshBtn);
    card.append(actions);

    // Seznam map
    card.append(el("div", "menu-section-title", "Mapy ve složce maps/"));
    this.listEl = el("div", "menu-maps");
    card.append(this.listEl);

    // Status + update
    this.statusEl = el("div", "menu-status", "");
    this.updateEl = el("div", "menu-update", "");
    this.updateEl.style.display = "none";
    card.append(this.statusEl, this.updateEl);

    screen.append(card);
    this.root.append(screen);
  }

  private async loadVersion() {
    const raw = await getAppVersion();
    this.versionEl.textContent = raw ? "v" + formatVersion(raw) : "";
  }

  private async refreshRootAndMaps() {
    if (!isElectronApp()) {
      this.rootPathEl.textContent =
        "Jen v desktop aplikaci (prohlížeč: použij Otevřít složku mapy / Demo).";
      this.listEl.innerHTML = "";
      this.listEl.append(
        el("div", "menu-hint", "Automatický seznam map je dostupný v nainstalované aplikaci.")
      );
      return;
    }
    this.listEl.innerHTML = "";
    this.listEl.append(el("div", "menu-hint", "Načítám mapy…"));
    try {
      this.omsiRoot = await getOmsiRoot();
      const res = await listOmsiMaps(this.omsiRoot);
      this.omsiRoot = res.root ?? this.omsiRoot;
      this.maps = res.maps;
      this.renderPath();
      this.renderMaps();
    } catch (err) {
      this.setStatus("Chyba: " + (err as Error).message, true);
    }
  }

  private renderPath() {
    this.rootPathEl.textContent = this.omsiRoot || "Nenalezeno - nastav cestu ručně.";
    this.rootPathEl.classList.toggle("missing", !this.omsiRoot);
  }

  private renderMaps() {
    this.listEl.innerHTML = "";
    if (!this.omsiRoot) {
      this.listEl.append(
        el(
          "div",
          "menu-hint",
          "OMSI 2 nebylo nalezeno automaticky. Klikni na „Změnit cestu…“ a vyber složku s Omsi.exe."
        )
      );
      return;
    }
    if (this.maps.length === 0) {
      this.listEl.append(el("div", "menu-hint", "Ve složce maps/ nebyly nalezeny žádné mapy."));
      return;
    }
    for (const m of this.maps) {
      const item = el("button", "menu-map");
      item.append(
        el("div", "menu-map-name", m.name),
        el("div", "menu-map-meta", `${m.folder} · ${m.tileCount} dlaždic`)
      );
      item.addEventListener("click", () => this.handleOpenMap(m));
      this.listEl.append(item);
    }
  }

  private async handleOpenMap(m: OmsiMapEntry) {
    try {
      this.setStatus(`Načítám „${m.name}"…`);
      const map = await openMapByFolder(this.omsiRoot, m.folder);
      this.teardown();
      this.onMap(map, `Načteno: ${map.friendlyName || map.name}`);
    } catch (err) {
      this.setStatus("Chyba načtení: " + (err as Error).message, true);
    }
  }

  private handleNewMap() {
    if (!isElectronApp()) {
      this.setStatus("Nová mapa je dostupná jen v desktop aplikaci.", true);
      return;
    }
    openNewMap(this.omsiRoot, (map, status) => {
      this.teardown();
      this.onMap(map, status);
    });
  }

  private async handleOpenFolder() {
    try {
      this.setStatus("Otevírám složku mapy…");
      const map = await openMapFolder();
      if (map) {
        this.teardown();
        this.onMap(map, `Načteno: ${map.friendlyName || map.name}`);
      } else {
        this.setStatus("Výběr zrušen.");
      }
    } catch (err) {
      this.setStatus("Chyba: " + (err as Error).message, true);
    }
  }

  private async handlePickRoot() {
    try {
      const root = await pickOmsiRoot();
      if (root) {
        this.omsiRoot = root;
        await this.refreshRootAndMaps();
      }
    } catch (err) {
      this.setStatus("Chyba: " + (err as Error).message, true);
    }
  }

  private setStatus(text: string, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }

  // ---------- Autoupdate ----------
  private setupUpdates() {
    const api = window.omsiAPI;
    if (!api?.onUpdateStatus) return;
    this.unsubUpdate = api.onUpdateStatus((s: UpdateStatus) => this.renderUpdate(s));
  }

  private renderUpdate(s: UpdateStatus) {
    const box = this.updateEl;
    box.innerHTML = "";
    box.classList.remove("ready");
    if (s.state === "none" || s.state === "checking") {
      box.style.display = "none";
      return;
    }
    box.style.display = "flex";
    if (s.state === "available") {
      box.append(el("span", "", `Stahuji aktualizaci ${s.version ?? ""}…`));
    } else if (s.state === "downloading") {
      box.append(el("span", "", `Stahuji aktualizaci… ${s.percent ?? 0} %`));
    } else if (s.state === "downloaded") {
      box.classList.add("ready");
      box.append(el("span", "", `Aktualizace ${s.version ?? ""} připravena.`));
      const btn = el("button", "btn btn-sm btn-primary", "Restartovat a aktualizovat");
      btn.addEventListener("click", () => window.omsiAPI?.installUpdate?.());
      box.append(btn);
    } else if (s.state === "error") {
      box.append(el("span", "", "Aktualizace selhala: " + (s.message ?? "")));
    }
  }

  private teardown() {
    this.unsubUpdate?.();
    this.unsubUpdate = null;
  }
}
