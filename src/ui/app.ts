import { Viewport } from "../viewport/viewport";
import type { Selection, ObjField, SplField } from "../viewport/viewport";
import { openMapFolder, saveMap, createAssetSource, loadMapFromOmsiDev } from "../fs/loader";
import { openSettings } from "./settings";
import { createDemoMap } from "../omsi/demo";
import { usedObjectPaths } from "../omsi/map";
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

function baseName(p: string): string {
  return p.split("\\").pop() || p;
}

export class EditorApp {
  /** Zavolá se při kliknutí na „Menu" – shell přepne na úvodní obrazovku. */
  onBackToMenu: (() => void) | null = null;

  private viewport!: Viewport;
  private map: OmsiMap | null = null;

  private mapNameEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private inspectorEl!: HTMLElement;
  private saveBtn!: HTMLButtonElement;
  private paletteListEl!: HTMLElement;
  private placeBanner!: HTMLElement;
  private filterEl!: HTMLInputElement;

  mount(root: HTMLElement) {
    root.innerHTML = "";
    const editor = el("div", "editor");

    // --- Toolbar ---
    const toolbar = el("header", "toolbar");
    const brand = el("div", "brand");
    brand.append(el("span", "brand-mark", "◆"), el("span", "brand-name", "OM2-Editor"));
    const menuBtn = el("button", "btn", "☰ Menu");
    menuBtn.addEventListener("click", () => this.onBackToMenu?.());
    const openBtn = el("button", "btn btn-primary", "Otevřít mapu…");
    openBtn.addEventListener("click", () => this.handleOpen());
    const demoBtn = el("button", "btn", "Demo mapa");
    demoBtn.addEventListener("click", () => this.loadMap(createDemoMap(), "Demo mapa načtena"));
    this.saveBtn = el("button", "btn", "Uložit");
    this.saveBtn.addEventListener("click", () => this.handleSave());
    const settingsBtn = el("button", "btn", "⚙ Nastavení");
    settingsBtn.addEventListener("click", () => openSettings());
    this.mapNameEl = el("div", "map-name", "—");
    this.statsEl = el("div", "stats", "");
    toolbar.append(brand, menuBtn, openBtn, demoBtn, this.saveBtn, this.mapNameEl, el("div", "spacer"), this.statsEl, settingsBtn);

    // --- Body ---
    const body = el("div", "body");

    const sidebar = el("aside", "panel sidebar");
    // Paleta
    sidebar.append(el("div", "panel-title", "Paleta objektů"));
    const palette = el("div", "palette");
    const addRow = el("div", "palette-add");
    const pathInput = el("input", "edit-input") as HTMLInputElement;
    pathInput.placeholder = "Sceneryobjects\\…\\objekt.sco";
    const addBtn = el("button", "btn btn-sm", "Umístit");
    addBtn.addEventListener("click", () => {
      const p = pathInput.value.trim();
      if (p) this.viewport.setPlaceMode(p);
    });
    addRow.append(pathInput, addBtn);
    const filter = el("input", "edit-input") as HTMLInputElement;
    filter.placeholder = "Filtr použitých objektů…";
    filter.addEventListener("input", () => this.renderPalette(filter.value));
    this.filterEl = filter;
    this.paletteListEl = el("div", "palette-list");
    this.placeBanner = el("div", "place-banner");
    this.placeBanner.style.display = "none";
    palette.append(addRow, filter, this.placeBanner, this.paletteListEl);
    sidebar.append(palette);
    // Strom
    sidebar.append(el("div", "panel-title", "Dlaždice a objekty"));
    this.treeEl = el("div", "tree");
    sidebar.append(this.treeEl);

    const viewportEl = el("main", "viewport");

    const inspector = el("aside", "panel inspector");
    inspector.append(el("div", "panel-title", "Inspektor"));
    this.inspectorEl = el("div", "inspector-body");
    inspector.append(this.inspectorEl);

    body.append(sidebar, viewportEl, inspector);

    const statusbar = el("footer", "statusbar");
    this.statusEl = el("div", "status", "Připraveno.");
    const help = el("div", "help", "táhni = posun · klik = výběr · R = rotace · Del = smazat · Ctrl+D = duplikovat · Ctrl+Z/Y = zpět/vpřed · Ctrl+S = uložit · Esc = zrušit");
    statusbar.append(this.statusEl, el("div", "spacer"), help);

    editor.append(toolbar, body, statusbar);
    root.append(editor);

    this.viewport = new Viewport(viewportEl);
    this.viewport.onSelect = (sel) => this.renderInspector(sel);
    this.viewport.onChange = (sel) => this.onChange(sel);
    this.viewport.onStatus = (msg, err) => {
      this.setStatus(msg, err);
      this.updatePlaceBanner();
    };

    window.addEventListener("keydown", this.onKeyDown);
    this.renderInspector(null);
  }

  /** DEV náhled z URL (?omsimap=… / ?map=…). Vrátí true, pokud něco načetl. */
  tryLoadFromUrlParams(): boolean {
    const params = new URLSearchParams(location.search);
    const mapUrl = params.get("map");
    const omsiMap = params.get("omsimap");
    if (omsiMap) {
      this.loadMapFromOmsiFolder(omsiMap, Number(params.get("max")) || 25);
      return true;
    }
    if (mapUrl) {
      this.loadMapFromUrl(mapUrl);
      return true;
    }
    return false;
  }

  // ---------- Načítání ----------

  private async handleOpen() {
    try {
      this.setStatus("Otevírám složku mapy…");
      const map = await openMapFolder();
      if (map) this.loadMap(map, `Načteno: ${map.friendlyName || map.name}`);
      else this.setStatus("Výběr zrušen.");
    } catch (err) {
      this.setStatus("Chyba: " + (err as Error).message, true);
    }
  }

  private async loadMapFromUrl(url: string) {
    try {
      this.setStatus("Načítám " + url + " …");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const map = (await res.json()) as OmsiMap;
      this.loadMap(map, `Načteno z ${url}: ${map.friendlyName || map.name}`);
    } catch (err) {
      this.setStatus("Chyba načtení " + url + ": " + (err as Error).message, true);
    }
  }

  private async loadMapFromOmsiFolder(rel: string, max: number) {
    try {
      this.setStatus(`Načítám mapu ze složky ${rel} …`);
      const map = await loadMapFromOmsiDev(rel, max);
      this.loadMap(map, `Načteno ${rel}: ${map.friendlyName || map.name} (${map.tiles.length} dlaždic)`);
    } catch (err) {
      this.setStatus("Chyba načtení " + rel + ": " + (err as Error).message, true);
    }
  }

  loadMap(map: OmsiMap, status: string) {
    this.map = map;
    this.viewport.setAssetSource(createAssetSource(map));
    this.viewport.setMap(map);
    this.mapNameEl.textContent = map.friendlyName || map.name;
    this.updateStats();
    this.renderTree(map);
    this.renderPalette("");
    this.renderInspector(null);
    this.updateSaveButton();
    this.setStatus(status);
  }

  private updateStats() {
    if (!this.map) return;
    const o = this.map.tiles.reduce((a, t) => a + t.objects.length, 0);
    const s = this.map.tiles.reduce((a, t) => a + t.splines.length, 0);
    this.statsEl.textContent = `${this.map.tiles.length} dlaždic · ${o} objektů · ${s} splajnů`;
  }

  // ---------- Paleta ----------

  private renderPalette(filterText: string) {
    this.paletteListEl.innerHTML = "";
    if (!this.map) return;
    const f = filterText.trim().toLowerCase();
    const paths = usedObjectPaths(this.map).filter((p) => !f || p.toLowerCase().includes(f));
    for (const p of paths.slice(0, 400)) {
      const item = el("div", "palette-item", baseName(p));
      item.title = p;
      item.addEventListener("click", () => this.viewport.setPlaceMode(p));
      this.paletteListEl.append(item);
    }
    if (paths.length === 0) this.paletteListEl.append(el("div", "hint", "Nic nenalezeno."));
  }

  private updatePlaceBanner() {
    const placing = this.viewport.isPlacing();
    this.placeBanner.style.display = placing ? "flex" : "none";
    this.placeBanner.innerHTML = "";
    if (placing) {
      this.placeBanner.append(el("span", "", "Umísťování aktivní"));
      const cancel = el("button", "btn btn-sm", "Zrušit");
      cancel.addEventListener("click", () => this.viewport.setPlaceMode(null));
      this.placeBanner.append(cancel);
    }
  }

  // ---------- Strom ----------

  private renderTree(map: OmsiMap) {
    this.treeEl.innerHTML = "";
    map.tiles.forEach((t, ti) => {
      const group = el("div", "tree-group");
      const head = el("div", "tree-head");
      head.append(
        el("span", "tree-caret", "▸"),
        el("span", "tree-label", `Dlaždice [${t.tileX}, ${t.tileY}]`),
        el("span", "tree-count", String(t.objects.length))
      );
      const list = el("div", "tree-children");
      list.style.display = "none";
      head.addEventListener("click", () => {
        const open = list.style.display === "none";
        list.style.display = open ? "block" : "none";
        (head.firstChild as HTMLElement).textContent = open ? "▾" : "▸";
        list.innerHTML = "";
        if (open) {
          t.objects.forEach((o, oi) => {
            const item = el("div", "tree-item", baseName(o.path));
            item.title = o.path;
            item.addEventListener("click", () => this.viewport.focusObject(ti, oi));
            list.append(item);
          });
        }
      });
      group.append(head, list);
      this.treeEl.append(group);
    });
  }

  // ---------- Inspektor ----------

  private inspInputs: Partial<Record<string, HTMLInputElement>> = {};

  private renderInspector(sel: Selection | null) {
    this.inspectorEl.innerHTML = "";
    this.inspInputs = {};
    if (!sel) {
      this.inspectorEl.append(el("div", "hint", "Klikni na objekt nebo spline. Táhnutím ho posuneš. Z palety můžeš přidat nový objekt."));
      return;
    }
    if (sel.kind === "object") this.renderObjectInspector(sel);
    else this.renderSplineInspector(sel);
  }

  private renderObjectInspector(sel: Extract<Selection, { kind: "object" }>) {
    const o = sel.object;
    const tile = this.map!.tiles[sel.tileIndex];
    this.addMeta([
      ["Typ", "Objekt (.sco)"],
      ["Soubor", baseName(o.path)],
      ["ID", String(o.id ?? "—")],
      ["Dlaždice", `${tile.tileX}, ${tile.tileY}`],
    ]);
    this.inspectorEl.append(el("div", "prop-sep", "Transformace"));
    this.addFields<ObjField>([
      ["x", "Pozice X"], ["y", "Pozice Y"], ["z", "Výška Z"], ["rotZ", "Rotace °"],
    ], o, (f, v) => this.viewport.setSelectedObjectField(f, v));

    const actions = el("div", "insp-actions");
    actions.append(
      this.actionBtn("⟲ −15°", () => this.viewport.rotateSelected(-15)),
      this.actionBtn("⟳ +15°", () => this.viewport.rotateSelected(15)),
      this.actionBtn("Duplikovat", () => this.viewport.duplicateSelected()),
      this.actionBtn("Smazat", () => this.viewport.deleteSelected(), true)
    );
    this.inspectorEl.append(actions);
    this.addMeta([["Cesta", o.path]]);
  }

  private renderSplineInspector(sel: Extract<Selection, { kind: "spline" }>) {
    const s = sel.spline;
    const tile = this.map!.tiles[sel.tileIndex];
    this.addMeta([
      ["Typ", "Spline (.sli)"],
      ["Soubor", baseName(s.path)],
      ["ID", String(s.id ?? "—")],
      ["Navázání", `prev ${s.prevId ?? "—"} · next ${s.nextId ?? "—"}`],
      ["Dlaždice", `${tile.tileX}, ${tile.tileY}`],
    ]);
    this.inspectorEl.append(el("div", "prop-sep", "Geometrie"));
    this.addFields<SplField>([
      ["x", "Start X"], ["y", "Start Y"], ["z", "Výška Z"],
      ["rotZ", "Azimut °"], ["length", "Délka"], ["radius", "Poloměr"],
    ], s, (f, v) => this.viewport.setSelectedSplineField(f, v));

    const actions = el("div", "insp-actions");
    actions.append(
      this.actionBtn("⟲ −5°", () => this.viewport.rotateSelected(-5)),
      this.actionBtn("⟳ +5°", () => this.viewport.rotateSelected(5)),
      this.actionBtn("Smazat", () => this.viewport.deleteSelected(), true)
    );
    this.inspectorEl.append(actions);
    this.addMeta([["Cesta", s.path]]);
  }

  private addMeta(rows: [string, string][]) {
    for (const [k, v] of rows) {
      const row = el("div", "prop-row");
      row.append(el("div", "prop-key", k), el("div", "prop-val", v));
      this.inspectorEl.append(row);
    }
  }

  private addFields<F extends string>(
    fields: [F, string][],
    source: object,
    apply: (field: F, value: number) => void
  ) {
    const data = source as Record<string, number>;
    for (const [field, label] of fields) {
      const row = el("div", "edit-row");
      row.append(el("label", "edit-label", label));
      const input = el("input", "edit-input") as HTMLInputElement;
      input.type = "number";
      input.step = field === "rotZ" ? "5" : "0.5";
      input.value = String(roundN(data[field], 3));
      input.addEventListener("change", () => {
        const val = parseFloat(input.value.replace(",", "."));
        if (Number.isFinite(val)) apply(field, val);
      });
      this.inspInputs[field] = input;
      row.append(input);
      this.inspectorEl.append(row);
    }
  }

  private actionBtn(label: string, fn: () => void, danger = false): HTMLButtonElement {
    const b = el("button", "btn btn-sm" + (danger ? " btn-danger" : ""), label);
    b.addEventListener("click", fn);
    return b;
  }

  private refreshInspectorValues(sel: Selection) {
    const data: Record<string, number> = sel.kind === "object"
      ? (sel.object as unknown as Record<string, number>)
      : (sel.spline as unknown as Record<string, number>);
    for (const [field, input] of Object.entries(this.inspInputs)) {
      if (input && document.activeElement !== input && typeof data[field] === "number") {
        input.value = String(roundN(data[field], 3));
      }
    }
  }

  // ---------- Stav ----------

  private onChange(sel: Selection | null) {
    if (sel) this.refreshInspectorValues(sel);
    else this.renderInspector(null);
    this.updateSaveButton();
    this.updateStats();
    this.renderPalette(this.filterEl?.value || "");
  }

  private updateSaveButton() {
    const dirty = this.map ? this.map.tiles.filter((t) => t.dirty).length : 0;
    this.saveBtn.textContent = dirty > 0 ? `Uložit (${dirty})` : "Uložit";
    this.saveBtn.classList.toggle("btn-primary", dirty > 0);
    this.saveBtn.disabled = dirty === 0;
    this.mapNameEl.classList.toggle("dirty", dirty > 0);
  }

  private async handleSave() {
    if (!this.map) return;
    try {
      this.setStatus("Ukládám…");
      const n = await saveMap(this.map);
      this.updateSaveButton();
      this.setStatus(n > 0 ? `Uloženo ${n} dlaždic.` : "Nebylo co uložit.");
    } catch (err) {
      this.setStatus("Chyba uložení: " + (err as Error).message, true);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.handleSave();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      this.setStatus(this.viewport.undo() ? "Vráceno zpět (Ctrl+Z)." : "Není co vrátit.");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault();
      this.setStatus(this.viewport.redo() ? "Znovu provedeno (Ctrl+Y)." : "Není co znovu provést.");
      return;
    }
    if (e.key === "Escape") {
      if (this.viewport.isPlacing()) this.viewport.setPlaceMode(null);
      return;
    }
    if (inField) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      this.viewport.duplicateSelected();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (this.viewport.getSelection()) {
        e.preventDefault();
        this.viewport.deleteSelected();
      }
    } else if (e.key === "r") {
      this.viewport.rotateSelected(e.shiftKey ? -15 : 15);
    }
  };

  private setStatus(text: string, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }
}

function roundN(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
