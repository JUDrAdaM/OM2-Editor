import { Viewport } from "../viewport/viewport";
import type { Selection, ObjField, SplField, GizmoMode, ToolId } from "../viewport/viewport";
import {
  openMapFolder, saveMap, createAssetSource, loadMapFromOmsiDev,
  pickAssetFiles, omsiRootOf, isElectronApp,
} from "../fs/loader";
import type { AssetKind } from "../fs/loader";
import { openSettings } from "./settings";
import { usedObjectPaths, usedSplinePaths } from "../omsi/map";
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

/** Definice nástrojů v levém panelu (přepínač). */
const TOOLS: { id: ToolId; label: string; icon: string }[] = [
  { id: "select", label: "Výběr", icon: "⬚" },
  { id: "object", label: "Objekt", icon: "🏠" },
  { id: "road", label: "Silnice", icon: "🛣" },
  { id: "terrain", label: "Terén", icon: "⛰" },
  { id: "paint", label: "Povrch", icon: "🖌" },
  { id: "erase", label: "Guma", icon: "🧽" },
];

const GIZMOS: { id: GizmoMode; label: string; key: string }[] = [
  { id: "translate", label: "↔ Posun", key: "W" },
  { id: "rotate", label: "⟳ Rotace", key: "E" },
  { id: "scale", label: "⤢ Měřítko", key: "T" },
];

export class EditorApp {
  /** Zavolá se při kliknutí na „Menu" – shell přepne na úvodní obrazovku. */
  onBackToMenu: (() => void) | null = null;

  private viewport!: Viewport;
  private map: OmsiMap | null = null;

  private mapNameEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private dirtyEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private inspectorEl!: HTMLElement;

  // Panel nástrojů
  private activeTool: ToolId = "select";
  private toolBtns: Partial<Record<ToolId, HTMLButtonElement>> = {};
  private toolPanels: Partial<Record<ToolId, HTMLElement>> = {};
  private gizmoBtns: Partial<Record<GizmoMode, HTMLButtonElement>> = {};

  private paletteListEl!: HTMLElement;
  private roadListEl!: HTMLElement;
  private paintListEl!: HTMLElement;
  private placeBanner!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private objPathInput!: HTMLInputElement;
  private roadPathInput!: HTMLInputElement;
  private paintPathInput!: HTMLInputElement;

  mount(root: HTMLElement) {
    root.innerHTML = "";
    const editor = el("div", "editor");

    // --- Toolbar: jen Menu + Nastavení + gizmo (kompaktní) ---
    const toolbar = el("header", "toolbar");
    const brand = el("div", "brand");
    brand.append(el("span", "brand-mark", "◆"), el("span", "brand-name", "OM2-Editor"));
    const menuBtn = el("button", "btn btn-sm", "☰ Menu");
    menuBtn.addEventListener("click", () => this.onBackToMenu?.());
    const settingsBtn = el("button", "btn btn-sm", "⚙ Nastavení");
    settingsBtn.addEventListener("click", () => openSettings());

    // Gizmo přepínač (posun / rotace / měřítko)
    const gizmoGroup = el("div", "gizmo-group");
    for (const g of GIZMOS) {
      const b = el("button", "btn btn-sm", g.label);
      b.title = `${g.label} (${g.key})`;
      b.addEventListener("click", () => this.viewport.setGizmoMode(g.id));
      this.gizmoBtns[g.id] = b;
      gizmoGroup.append(b);
    }

    this.mapNameEl = el("div", "map-name", "—");
    this.dirtyEl = el("div", "dirty-pill");
    this.dirtyEl.style.display = "none";
    this.statsEl = el("div", "stats", "");
    toolbar.append(brand, menuBtn, settingsBtn, gizmoGroup, el("div", "spacer"), this.statsEl, this.dirtyEl, this.mapNameEl);

    // --- Body ---
    const body = el("div", "body");

    // Levý panel: rail nástrojů + panel aktivního nástroje + strom
    const sidebar = el("aside", "panel sidebar");
    const rail = el("div", "tool-rail");
    for (const t of TOOLS) {
      const b = el("button", "tool-btn");
      b.append(el("span", "tool-ico", t.icon), el("span", "tool-lbl", t.label));
      b.title = t.label;
      b.addEventListener("click", () => this.selectTool(t.id));
      this.toolBtns[t.id] = b;
      rail.append(b);
    }
    sidebar.append(rail);

    const toolArea = el("div", "tool-area");
    this.buildToolPanels(toolArea);
    sidebar.append(toolArea);

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
    const help = el("div", "help", "gizmo: W posun · E rotace · T měřítko (stromy) · táhni = posun · šipky = jemný posun · R = rotace · Del = smazat · Ctrl+D = duplikovat · Ctrl+Z/Y = zpět/vpřed · Ctrl+S = uložit · Esc = zrušit");
    statusbar.append(this.statusEl, el("div", "spacer"), help);

    editor.append(toolbar, body, statusbar);
    root.append(editor);

    this.viewport = new Viewport(viewportEl);
    this.viewport.onSelect = (sel) => this.renderInspector(sel);
    this.viewport.onChange = (sel) => this.onChange(sel);
    this.viewport.onStatus = (msg, err) => { this.setStatus(msg, err); this.updatePlaceBanner(); };
    this.viewport.onGizmoMode = (mode) => this.updateGizmoButtons(mode);
    this.viewport.onTool = (tool) => this.syncToolRail(tool);

    this.updateGizmoButtons(this.viewport.getGizmoMode());
    this.selectTool("select");
    window.addEventListener("keydown", this.onKeyDown);
    this.renderInspector(null);
  }

  // ---------- Panel nástrojů ----------

  private buildToolPanels(area: HTMLElement) {
    // Výběr
    const sel = el("div", "tool-panel");
    sel.append(el("div", "hint", "Klikni na objekt nebo spline. Táhnutím ho posuneš. Gizmo: W posun · E rotace · T měřítko (stromy)."));
    this.toolPanels.select = sel;

    // Objekt (umístění .sco)
    const obj = el("div", "tool-panel");
    const objRow = el("div", "palette-add");
    this.objPathInput = el("input", "edit-input") as HTMLInputElement;
    this.objPathInput.placeholder = "Sceneryobjects\\…\\objekt.sco";
    const objBrowse = el("button", "btn btn-sm", "Procházet…");
    objBrowse.addEventListener("click", () => this.browseAsset("object"));
    const objPlace = el("button", "btn btn-sm btn-primary", "Umístit");
    objPlace.addEventListener("click", () => { const p = this.objPathInput.value.trim(); if (p) this.viewport.setPlaceMode(p); });
    objRow.append(this.objPathInput, objBrowse, objPlace);
    const filter = el("input", "edit-input") as HTMLInputElement;
    filter.placeholder = "Filtr použitých objektů…";
    filter.addEventListener("input", () => this.renderPalette(filter.value));
    this.filterEl = filter;
    this.placeBanner = el("div", "place-banner");
    this.placeBanner.style.display = "none";
    this.paletteListEl = el("div", "palette-list");
    obj.append(el("div", "tool-head", "Umístit objekt"), objRow, filter, this.placeBanner, this.paletteListEl);
    this.toolPanels.object = obj;

    // Silnice (.sli)
    const road = el("div", "tool-panel");
    const roadRow = el("div", "palette-add");
    this.roadPathInput = el("input", "edit-input") as HTMLInputElement;
    this.roadPathInput.placeholder = "Splines\\…\\silnice.sli";
    const roadBrowse = el("button", "btn btn-sm", "Procházet…");
    roadBrowse.addEventListener("click", () => this.browseAsset("spline"));
    const roadBtn = el("button", "btn btn-sm btn-primary", "Stavět");
    roadBtn.addEventListener("click", () => { const p = this.roadPathInput.value.trim(); if (p) this.viewport.setRoadMode(p); });
    roadRow.append(this.roadPathInput, roadBrowse, roadBtn);
    this.roadListEl = el("div", "palette-list");
    road.append(el("div", "tool-head", "Stavba silnic"), roadRow, this.roadListEl);
    this.toolPanels.road = road;

    // Terén (štětec výšky)
    const terr = el("div", "tool-panel");
    const opRow = el("div", "btn-grid");
    const mkOp = (label: string, op: "raise" | "lower" | "flatten" | "smooth") => {
      const b = el("button", "btn btn-sm", label);
      b.addEventListener("click", () => this.viewport.setTerrainMode(op));
      opRow.append(b);
    };
    mkOp("▲ Zvýšit", "raise"); mkOp("▼ Snížit", "lower");
    mkOp("▬ Vyrovnat", "flatten"); mkOp("∿ Vyhladit", "smooth");
    const brushRow = el("div", "slider-row");
    const brush = el("input") as HTMLInputElement;
    brush.type = "range"; brush.min = "5"; brush.max = "120"; brush.value = "25";
    const brushLbl = el("span", "hint", "Štětec: 25 m");
    brush.addEventListener("input", () => { this.viewport.setBrush(Number(brush.value)); brushLbl.textContent = `Štětec: ${brush.value} m`; });
    brushRow.append(brushLbl, brush);
    const strRow = el("div", "slider-row");
    const str = el("input") as HTMLInputElement;
    str.type = "range"; str.min = "1"; str.max = "40"; str.value = "12";
    const strLbl = el("span", "hint", "Síla: 1.2");
    str.addEventListener("input", () => { const v = Number(str.value) / 10; this.viewport.setBrush(undefined, v); strLbl.textContent = `Síla: ${v.toFixed(1)}`; });
    strRow.append(strLbl, str);
    terr.append(el("div", "tool-head", "Úprava terénu"), opRow, brushRow, strRow,
      el("div", "hint", "Vyber operaci a táhni po terénu. Vyrovnat srovná na výšku prvního kliknutí."));
    this.toolPanels.terrain = terr;

    // Povrch (malování)
    const paint = el("div", "tool-panel");
    const paintRow = el("div", "palette-add");
    this.paintPathInput = el("input", "edit-input") as HTMLInputElement;
    this.paintPathInput.placeholder = "Texture\\…\\dlazba.bmp";
    const paintBrowse = el("button", "btn btn-sm", "Procházet…");
    paintBrowse.addEventListener("click", () => this.browseAsset("texture"));
    const paintBtn = el("button", "btn btn-sm btn-primary", "Malovat");
    paintBtn.addEventListener("click", () => { const p = this.paintPathInput.value.trim(); if (p) this.viewport.setPaintMode(p); });
    paintRow.append(this.paintPathInput, paintBrowse, paintBtn);
    this.paintListEl = el("div", "palette-list");
    paint.append(el("div", "tool-head", "Malování povrchu"), paintRow, this.paintListEl,
      el("div", "hint", "Malování je zatím jen v rámci relace (OMSI formát malby terénu není doložen)."));
    this.toolPanels.paint = paint;

    // Guma
    const erase = el("div", "tool-panel");
    erase.append(el("div", "hint", "Guma je aktivní: klikni na objekt nebo spline a smažeš ho. Smazání lze vrátit (Ctrl+Z)."));
    this.toolPanels.erase = erase;

    for (const t of TOOLS) { const p = this.toolPanels[t.id]!; p.style.display = "none"; area.append(p); }
  }

  /** Přepne aktivní nástroj (zobrazí jeho panel + aktivuje ve viewportu). */
  private selectTool(id: ToolId) {
    this.activeTool = id;
    for (const t of TOOLS) {
      this.toolBtns[t.id]?.classList.toggle("active", t.id === id);
      if (this.toolPanels[t.id]) this.toolPanels[t.id]!.style.display = t.id === id ? "flex" : "none";
    }
    // Aktivace ve viewportu podle nástroje.
    if (id === "terrain") this.viewport.setTerrainMode("raise");
    else if (id === "erase") this.viewport.setEraseMode(true);
    else this.viewport.clearTools(); // select / object / road / paint – mód začne výběrem souboru
  }

  /** Udrží zvýraznění railu v souladu s reálným stavem viewportu (Esc apod.). */
  private syncToolRail(tool: ToolId) {
    // Při umísťování/stavbě/malbě zůstává zvýrazněný odpovídající nástroj;
    // při návratu do výběru přepni rail na „Výběr".
    if (tool === "select" && this.activeTool !== "select") {
      // jen když je skutečně bez nástroje (ne během přechodného výběru souboru
      // v panelu object/road/paint)
      if (this.activeTool === "terrain" || this.activeTool === "erase") {
        this.activeTool = "select";
        for (const t of TOOLS) {
          this.toolBtns[t.id]?.classList.toggle("active", t.id === "select");
          if (this.toolPanels[t.id]) this.toolPanels[t.id]!.style.display = t.id === "select" ? "flex" : "none";
        }
      }
    }
  }

  private updateGizmoButtons(mode: GizmoMode) {
    for (const g of GIZMOS) this.gizmoBtns[g.id]?.classList.toggle("btn-primary", g.id === mode);
  }

  /** Otevře dialog pro výběr souboru assetu a aktivuje odpovídající nástroj. */
  private async browseAsset(kind: AssetKind) {
    if (!this.map) return;
    if (!isElectronApp()) {
      this.setStatus("Procházení souborů funguje v desktop aplikaci. V náhledu zadej cestu ručně.", true);
      return;
    }
    try {
      const rels = await pickAssetFiles(kind, omsiRootOf(this.map));
      if (rels.length === 0) return;
      const first = rels[0];
      if (kind === "object") { this.objPathInput.value = first; this.viewport.setPlaceMode(first); }
      else if (kind === "spline") { this.roadPathInput.value = first; this.viewport.setRoadMode(first); }
      else { this.paintPathInput.value = first; this.viewport.setPaintMode(first); }
      this.setStatus(`Vybráno: ${baseName(first)}${rels.length > 1 ? ` (+${rels.length - 1})` : ""}`);
    } catch (err) {
      this.setStatus("Chyba výběru souboru: " + (err as Error).message, true);
    }
  }

  /** DEV náhled z URL (?omsimap=… / ?map=…). Vrátí true, pokud něco načetl. */
  tryLoadFromUrlParams(): boolean {
    const params = new URLSearchParams(location.search);
    const mapUrl = params.get("map");
    const omsiMap = params.get("omsimap");
    if (omsiMap) { this.loadMapFromOmsiFolder(omsiMap, Number(params.get("max")) || 25); return true; }
    if (mapUrl) { this.loadMapFromUrl(mapUrl); return true; }
    return false;
  }

  // ---------- Načítání ----------

  async handleOpen() {
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
    this.renderRoadPalette();
    this.renderPaintPalette();
    this.renderInspector(null);
    this.updateDirty();
    this.setStatus(status);
  }

  private updateStats() {
    if (!this.map) return;
    const o = this.map.tiles.reduce((a, t) => a + t.objects.length, 0);
    const s = this.map.tiles.reduce((a, t) => a + t.splines.length, 0);
    this.statsEl.textContent = `${this.map.tiles.length} dlaždic · ${o} obj · ${s} splajnů`;
  }

  // ---------- Palety ----------

  private renderPalette(filterText: string) {
    this.paletteListEl.innerHTML = "";
    if (!this.map) return;
    const f = filterText.trim().toLowerCase();
    const paths = usedObjectPaths(this.map).filter((p) => !f || p.toLowerCase().includes(f));
    for (const p of paths.slice(0, 400)) {
      const item = el("div", "palette-item", baseName(p));
      item.title = p;
      item.addEventListener("click", () => { this.objPathInput.value = p; this.viewport.setPlaceMode(p); });
      this.paletteListEl.append(item);
    }
    if (paths.length === 0) this.paletteListEl.append(el("div", "hint", "Nic nenalezeno."));
  }

  private renderRoadPalette() {
    this.roadListEl.innerHTML = "";
    if (!this.map) return;
    const paths = usedSplinePaths(this.map);
    for (const p of paths.slice(0, 400)) {
      const item = el("div", "palette-item", baseName(p));
      item.title = p;
      item.addEventListener("click", () => { this.roadPathInput.value = p; this.viewport.setRoadMode(p); });
      this.roadListEl.append(item);
    }
    if (paths.length === 0) this.roadListEl.append(el("div", "hint", "Žádné silnice v mapě."));
  }

  private renderPaintPalette() {
    this.paintListEl.innerHTML = "";
    if (!this.map) return;
    const seen = new Set<string>();
    for (const g of this.map.groundTex) {
      const tex = g.main;
      if (!tex || seen.has(tex.toLowerCase())) continue;
      seen.add(tex.toLowerCase());
      const item = el("div", "palette-item", baseName(tex));
      item.title = tex;
      item.addEventListener("click", () => { this.paintPathInput.value = tex; this.viewport.setPaintMode(tex); });
      this.paintListEl.append(item);
    }
    if (seen.size === 0) this.paintListEl.append(el("div", "hint", "Zadej cestu k textuře výše."));
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
      this.inspectorEl.append(el("div", "hint", "Klikni na objekt nebo spline. Táhnutím ho posuneš. Z panelu vlevo přidáš nový objekt, silnici, upravíš terén…"));
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
    this.updateDirty();
    this.updateStats();
    this.renderPalette(this.filterEl?.value || "");
  }

  private updateDirty() {
    const dirty = this.map ? this.map.tiles.filter((t) => t.dirty).length : 0;
    this.dirtyEl.style.display = dirty > 0 ? "inline-flex" : "none";
    this.dirtyEl.textContent = dirty > 0 ? `● neuloženo (${dirty}) — Ctrl+S` : "";
    this.mapNameEl.classList.toggle("dirty", dirty > 0);
  }

  private async handleSave() {
    if (!this.map) return;
    try {
      this.setStatus("Ukládám…");
      const n = await saveMap(this.map);
      this.updateDirty();
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
      if (this.viewport.isToolActive()) { this.viewport.clearTools(); this.setStatus("Nástroj ukončen."); }
      this.selectTool("select");
      return;
    }
    if (inField) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      this.viewport.duplicateSelected();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (this.viewport.getSelection()) { e.preventDefault(); this.viewport.deleteSelected(); }
    } else if (e.key === "r") {
      this.viewport.rotateSelected(e.shiftKey ? -15 : 15);
    } else if (e.key === "w" || e.key === "W") {
      this.viewport.setGizmoMode("translate");
    } else if (e.key === "e" || e.key === "E") {
      this.viewport.setGizmoMode("rotate");
    } else if (e.key === "t" || e.key === "T") {
      this.viewport.setGizmoMode("scale");
    } else if (e.key.startsWith("Arrow") && this.viewport.getSelection()) {
      const step = e.shiftKey ? 5 : 0.5;
      const d: Record<string, [number, number]> = {
        ArrowRight: [step, 0], ArrowLeft: [-step, 0],
        ArrowUp: [0, step], ArrowDown: [0, -step],
      };
      const nd = d[e.key];
      if (nd) { e.preventDefault(); this.viewport.nudgeSelected(nd[0], nd[1]); }
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
