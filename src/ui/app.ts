import { Viewport } from "../viewport/viewport";
import type { Selection, ObjField, SplField, GizmoMode, ToolId } from "../viewport/viewport";
import {
  openMapFolder, saveMap, createAssetSource, loadMapFromOmsiDev,
  pickAssetFiles, listAssetFolder, getKnownAssets, addKnownAsset, omsiRootOf, isElectronApp,
} from "../fs/loader";
import type { AssetKind } from "../fs/loader";
import { openSettings } from "./settings";
import { openHelp } from "./help";
import { openMapProps } from "./mapprops";
import { actionFromEvent } from "./keybindings";
import { usedObjectPaths, usedSplinePaths, createTile, suggestNewTileCoords } from "../omsi/map";
import type { OmsiMap } from "../omsi/types";

/** Nástroje v levém panelu: tool-y viewportu + „tile" (UI panel, ne klik-nástroj). */
type RailId = ToolId | "tile";

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
const TOOLS: { id: RailId; label: string; icon: string }[] = [
  { id: "select", label: "Výběr", icon: "⬚" },
  { id: "object", label: "Objekt", icon: "🏠" },
  { id: "road", label: "Silnice", icon: "🛣" },
  { id: "terrain", label: "Terén", icon: "⛰" },
  { id: "paint", label: "Povrch", icon: "🖌" },
  { id: "erase", label: "Guma", icon: "🧽" },
  { id: "tile", label: "Dlaždice", icon: "⊞" },
];

const GIZMOS: { id: GizmoMode; label: string; key: string }[] = [
  { id: "translate", label: "↔ Posun", key: "1" },
  { id: "rotate", label: "⟳ Rotace", key: "2" },
  { id: "scale", label: "⤢ Měřítko", key: "3" },
];

export class EditorApp {
  /** Zavolá se při kliknutí na „Menu" - shell přepne na úvodní obrazovku. */
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
  private activeTool: RailId = "select";
  private toolBtns: Partial<Record<RailId, HTMLButtonElement>> = {};
  private toolPanels: Partial<Record<RailId, HTMLElement>> = {};
  private tileXInput!: HTMLInputElement;
  private tileYInput!: HTMLInputElement;
  private baseTexInput!: HTMLInputElement;
  private gizmoBtns: Partial<Record<GizmoMode, HTMLButtonElement>> = {};

  private paletteListEl!: HTMLElement;
  private roadListEl!: HTMLElement;
  private paintListEl!: HTMLElement;
  private placeBanner!: HTMLElement;
  /** Dočasně vylistovaná složka assetů (přes „📁 Složka…") pro daný druh; null =
   *  paleta ukazuje známé/použité assety. */
  private folderAssets: Record<AssetKind, string[] | null> = { object: null, spline: null, texture: null };
  /** Aktuální text filtru palety pro daný druh. */
  private paletteFilter: Record<AssetKind, string> = { object: "", spline: "", texture: "" };
  /** Dočasně vylistovaná složka textur pro základní texturu terénu (null = palety). */
  private baseTexFolder: string[] | null = null;
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
    const mapPropsBtn = el("button", "btn btn-sm", "🗺 Mapa");
    mapPropsBtn.title = "Vlastnosti mapy (global.cfg): název, popis, terénní textury";
    mapPropsBtn.addEventListener("click", () => this.openMapProps());
    const settingsBtn = el("button", "btn btn-sm", "⚙ Nastavení");
    settingsBtn.addEventListener("click", () => openSettings());
    const helpBtn = el("button", "btn btn-sm", "? Nápověda");
    helpBtn.addEventListener("click", () => openHelp());

    // Přepínač vizualizace AI provozu (jízdní dráhy aut/chodců/kolejí + semafory)
    const aiBtn = el("button", "btn btn-sm", "🚦 AI provoz");
    aiBtn.title = "Zobrazit/skrýt AI dráhy (auta/chodci/kolej) a semafory";
    let aiOn = false;
    aiBtn.addEventListener("click", () => {
      aiOn = !aiOn;
      this.viewport.setAiTraffic(aiOn);
      aiBtn.classList.toggle("active", aiOn);
    });

    // Gizmo přepínač (posun / rotace / měřítko)
    const gizmoGroup = el("div", "gizmo-group");
    for (const g of GIZMOS) {
      const b = el("button", "btn btn-sm", g.label);
      b.title = `${g.label} (${g.key})`;
      b.addEventListener("click", () => this.viewport.setGizmoMode(g.id));
      this.gizmoBtns[g.id] = b;
      gizmoGroup.append(b);
    }

    this.mapNameEl = el("div", "map-name", "-");
    this.dirtyEl = el("div", "dirty-pill");
    this.dirtyEl.style.display = "none";
    this.statsEl = el("div", "stats", "");
    toolbar.append(brand, menuBtn, mapPropsBtn, settingsBtn, helpBtn, aiBtn, gizmoGroup, el("div", "spacer"), this.statsEl, this.dirtyEl, this.mapNameEl);

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
    const help = el("div", "help", "WASD / šipky = pohyb kamery · klávesy a zkratky viz ? Nápověda nahoře");
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
    sel.append(el("div", "hint", "Klikni na objekt nebo spline. Táhnutím ho posuneš. Gizmo: 1 posun · 2 rotace · 3 měřítko (stromy)."));
    this.toolPanels.select = sel;

    // Objekt (umístění .sco)
    const obj = el("div", "tool-panel");
    const objRow = el("div", "palette-add");
    this.objPathInput = el("input", "edit-input") as HTMLInputElement;
    this.objPathInput.placeholder = "Sceneryobjects\\…\\objekt.sco";
    const objFolder = el("button", "btn btn-sm", "📁 Složka…");
    objFolder.title = "Otevřít složku a zobrazit všechny objekty v ní";
    objFolder.addEventListener("click", () => this.browseAssetFolder("object"));
    const objBrowse = el("button", "btn btn-sm", "Soubor…");
    objBrowse.addEventListener("click", () => this.browseAsset("object"));
    const objPlace = el("button", "btn btn-sm btn-primary", "Umístit");
    objPlace.addEventListener("click", () => this.chooseAsset("object", this.objPathInput.value.trim()));
    objRow.append(this.objPathInput, objFolder, objBrowse, objPlace);
    const filter = el("input", "edit-input") as HTMLInputElement;
    filter.placeholder = "Filtr objektů…";
    filter.addEventListener("input", () => { this.paletteFilter.object = filter.value; this.renderAssetPalette("object"); });
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
    const roadFolder = el("button", "btn btn-sm", "📁 Složka…");
    roadFolder.title = "Otevřít složku a zobrazit všechny silnice/splajny v ní";
    roadFolder.addEventListener("click", () => this.browseAssetFolder("spline"));
    const roadBrowse = el("button", "btn btn-sm", "Soubor…");
    roadBrowse.addEventListener("click", () => this.browseAsset("spline"));
    const roadBtn = el("button", "btn btn-sm btn-primary", "Stavět");
    roadBtn.addEventListener("click", () => this.chooseAsset("spline", this.roadPathInput.value.trim()));
    roadRow.append(this.roadPathInput, roadFolder, roadBrowse, roadBtn);
    const roadFilter = el("input", "edit-input") as HTMLInputElement;
    roadFilter.placeholder = "Filtr silnic…";
    roadFilter.addEventListener("input", () => { this.paletteFilter.spline = roadFilter.value; this.renderAssetPalette("spline"); });
    this.roadListEl = el("div", "palette-list");
    road.append(el("div", "tool-head", "Stavba silnic"), roadRow, roadFilter, this.roadListEl);
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
    const paintFolder = el("button", "btn btn-sm", "📁 Složka…");
    paintFolder.title = "Otevřít složku a zobrazit všechny textury v ní";
    paintFolder.addEventListener("click", () => this.browseAssetFolder("texture"));
    const paintBrowse = el("button", "btn btn-sm", "Soubor…");
    paintBrowse.addEventListener("click", () => this.browseAsset("texture"));
    const paintBtn = el("button", "btn btn-sm btn-primary", "Malovat");
    paintBtn.addEventListener("click", () => this.chooseAsset("texture", this.paintPathInput.value.trim()));
    paintRow.append(this.paintPathInput, paintFolder, paintBrowse, paintBtn);
    const paintFilter = el("input", "edit-input") as HTMLInputElement;
    paintFilter.placeholder = "Filtr textur…";
    paintFilter.addEventListener("input", () => { this.paletteFilter.texture = paintFilter.value; this.renderAssetPalette("texture"); });
    // Velikost kreslení (štětec) - sdílí brushRadius s terénem.
    const pBrushRow = el("div", "slider-row");
    const pBrush = el("input") as HTMLInputElement;
    pBrush.type = "range"; pBrush.min = "3"; pBrush.max = "120"; pBrush.value = "25";
    const pBrushLbl = el("span", "hint", "Velikost kreslení: 25 m");
    pBrush.addEventListener("input", () => { this.viewport.setBrush(Number(pBrush.value)); pBrushLbl.textContent = `Velikost kreslení: ${pBrush.value} m`; });
    pBrushRow.append(pBrushLbl, pBrush);
    this.paintListEl = el("div", "palette-list");
    paint.append(el("div", "tool-head", "Malování povrchu"), paintRow, pBrushRow, paintFilter, this.paintListEl,
      el("div", "hint", "Vyber texturu a táhni po terénu. Malování je zatím jen v rámci relace (OMSI formát malby terénu není doložen)."));
    this.toolPanels.paint = paint;

    // Guma
    const erase = el("div", "tool-panel");
    erase.append(el("div", "hint", "Guma je aktivní: klikni na objekt nebo spline a smažeš ho. Smazání lze vrátit (Ctrl+Z)."));
    this.toolPanels.erase = erase;

    // Dlaždice (přidání nových dlaždic + základní textura terénu)
    const tile = el("div", "tool-panel");
    tile.append(el("div", "tool-head", "Přidat dlaždici"));
    const coordRow = el("div", "palette-add");
    this.tileXInput = el("input", "edit-input") as HTMLInputElement;
    this.tileXInput.type = "number"; this.tileXInput.title = "Souřadnice X (sloupec)";
    this.tileYInput = el("input", "edit-input") as HTMLInputElement;
    this.tileYInput.type = "number"; this.tileYInput.title = "Souřadnice Y (řádek)";
    coordRow.append(el("span", "edit-label", "X"), this.tileXInput, el("span", "edit-label", "Y"), this.tileYInput);
    const addTileBtn = el("button", "btn btn-sm btn-primary", "Přidat dlaždici");
    addTileBtn.addEventListener("click", () => this.addTile());
    tile.append(coordRow, addTileBtn,
      el("div", "hint", "Vytvoří prázdnou plochou dlaždici (300x300 m) vedle mapy. Uloží se do mapy včetně záznamu v global.cfg."));

    tile.append(el("div", "tool-head", "Základní textura terénu"));
    const texRow = el("div", "palette-add");
    this.baseTexInput = el("input", "edit-input") as HTMLInputElement;
    this.baseTexInput.placeholder = "Texture\\…\\gras.bmp";
    const texFolder = el("button", "btn btn-sm", "📁 Složka…");
    texFolder.title = "Otevřít složku a zobrazit všechny textury v ní";
    texFolder.addEventListener("click", () => this.browseBaseTexFolder());
    const texBrowse = el("button", "btn btn-sm", "Soubor…");
    texBrowse.addEventListener("click", () => this.browseBaseTexture());
    const texBtn = el("button", "btn btn-sm", "Použít");
    texBtn.addEventListener("click", () => this.applyBaseTexture(this.baseTexInput.value.trim()));
    texRow.append(this.baseTexInput, texFolder, texBrowse, texBtn);
    const texList = el("div", "palette-list");
    texList.id = "__baseTexList";
    tile.append(texRow, texList,
      el("div", "hint", "Náhled základní textury (tráva apod.) pro celou mapu. Změna palety v global.cfg se zatím neukládá."));
    this.toolPanels.tile = tile;

    for (const t of TOOLS) { const p = this.toolPanels[t.id]!; p.style.display = "none"; area.append(p); }
  }

  /** Přidá novou dlaždici na zadané (nebo navržené) souřadnice. */
  private addTile() {
    if (!this.map) return;
    const sug = suggestNewTileCoords(this.map);
    const tx = Number.isFinite(parseInt(this.tileXInput.value, 10)) ? parseInt(this.tileXInput.value, 10) : sug.tileX;
    const ty = Number.isFinite(parseInt(this.tileYInput.value, 10)) ? parseInt(this.tileYInput.value, 10) : sug.tileY;
    if (this.map.tiles.some((t) => t.tileX === tx && t.tileY === ty)) {
      this.setStatus(`Dlaždice [${tx}, ${ty}] už existuje.`, true);
      return;
    }
    const idx = createTile(this.map, tx, ty);
    this.viewport.focusTile(idx);
    this.renderTree(this.map);
    this.updateStats();
    this.updateDirty();
    // navrhni další volné souřadnice
    const next = suggestNewTileCoords(this.map);
    this.tileXInput.value = String(next.tileX);
    this.tileYInput.value = String(next.tileY);
    this.setStatus(`Přidána dlaždice [${tx}, ${ty}]. Ulož (Ctrl+S) pro zápis do mapy.`);
  }

  /** Otevře editaci vlastností mapy (global.cfg). Po uložení obnoví náhled. */
  private openMapProps() {
    if (!this.map) { this.setStatus("Nejprve otevři nebo vytvoř mapu.", true); return; }
    const map = this.map;
    openMapProps(map, () => {
      this.mapNameEl.textContent = map.friendlyName || map.name;
      this.viewport.reloadGround();
      this.renderAssetPalette("texture");
      this.renderBaseTexList();
      this.setStatus("Vlastnosti mapy uloženy (global.cfg).");
    });
  }

  private async browseBaseTexture() {
    if (!this.map) return;
    if (!isElectronApp()) { this.setStatus("Procházení funguje v desktop aplikaci.", true); return; }
    try {
      const rels = await pickAssetFiles("texture", omsiRootOf(this.map));
      if (rels[0]) { this.baseTexInput.value = rels[0]; this.applyBaseTexture(rels[0]); }
    } catch (err) { this.setStatus("Chyba: " + (err as Error).message, true); }
  }

  /** Otevře složku a zobrazí všechny textury v paletě základní textury. */
  private async browseBaseTexFolder() {
    if (!this.map) return;
    if (!isElectronApp()) { this.setStatus("Otevření složky funguje v desktop aplikaci.", true); return; }
    try {
      const rels = await listAssetFolder("texture", omsiRootOf(this.map));
      if (rels.length === 0) { this.setStatus("Ve zvolené složce nejsou žádné textury (nebo výběr zrušen)."); return; }
      this.baseTexFolder = rels;
      this.renderBaseTexList();
      this.setStatus(`Složka: ${rels.length} textur. Klikni pro použití.`);
    } catch (err) { this.setStatus("Chyba otevření složky: " + (err as Error).message, true); }
  }

  /** Nastaví základní texturu terénu mapy (náhled; groundTex[0]). */
  private applyBaseTexture(path: string) {
    if (!this.map || !path) return;
    if (this.map.groundTex.length === 0) this.map.groundTex.push({ main: path, detail: "" });
    else this.map.groundTex[0] = { main: path, detail: this.map.groundTex[0].detail };
    addKnownAsset("texture", path);
    this.viewport.reloadGround();
    this.renderBaseTexList();
    this.setStatus(`Základní textura: ${baseName(path)} (náhled).`);
  }

  private renderBaseTexList() {
    const list = document.getElementById("__baseTexList");
    if (!list || !this.map) return;
    list.innerHTML = "";
    if (this.baseTexFolder) {
      const back = el("div", "palette-item palette-back", "← zpět na použité");
      back.addEventListener("click", () => { this.baseTexFolder = null; this.renderBaseTexList(); });
      list.append(back);
      for (const p of this.baseTexFolder.slice(0, 1000)) {
        const item = el("div", "palette-item", baseName(p));
        item.title = p;
        item.addEventListener("click", () => { this.baseTexInput.value = p; this.applyBaseTexture(p); });
        list.append(item);
      }
      if (this.baseTexFolder.length === 0) list.append(el("div", "hint", "Ve složce nejsou textury."));
      return;
    }
    const seen = new Set<string>();
    // Textury mapy ([groundtex]) + dřív použité (perzistentně uložené).
    const sources = [...this.map.groundTex.map((g) => g.main), ...getKnownAssets("texture")];
    for (const tex of sources) {
      if (!tex || seen.has(tex.toLowerCase())) continue;
      seen.add(tex.toLowerCase());
      const item = el("div", "palette-item", baseName(tex));
      item.title = tex;
      item.addEventListener("click", () => { this.baseTexInput.value = tex; this.applyBaseTexture(tex); });
      list.append(item);
    }
    if (seen.size === 0) list.append(el("div", "hint", "Otevři složku (📁) nebo zadej cestu výše."));
  }

  /** Přepne aktivní nástroj (zobrazí jeho panel + aktivuje ve viewportu). */
  private selectTool(id: RailId) {
    this.activeTool = id;
    for (const t of TOOLS) {
      this.toolBtns[t.id]?.classList.toggle("active", t.id === id);
      if (this.toolPanels[t.id]) this.toolPanels[t.id]!.style.display = t.id === id ? "flex" : "none";
    }
    // Aktivace ve viewportu podle nástroje.
    if (id === "terrain") this.viewport.setTerrainMode("raise");
    else if (id === "erase") this.viewport.setEraseMode(true);
    else this.viewport.clearTools(); // select / object / road / paint / tile
    if (id === "tile" && this.map) {
      const sug = suggestNewTileCoords(this.map);
      if (!this.tileXInput.value) this.tileXInput.value = String(sug.tileX);
      if (!this.tileYInput.value) this.tileYInput.value = String(sug.tileY);
      this.renderBaseTexList();
    }
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
      // Všechny vybrané si zapamatuj (do palety), aktivuj první.
      for (const r of rels) addKnownAsset(kind, r);
      this.chooseAsset(kind, rels[0]);
      this.setStatus(`Vybráno: ${baseName(rels[0])}${rels.length > 1 ? ` (+${rels.length - 1} do palety)` : ""}`);
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
    // Starší zdroje (JSON z URL) nemusí mít totalTiles - dorovnej.
    if (typeof map.totalTiles !== "number") map.totalTiles = map.tiles.length;
    this.map = map;
    this.viewport.setAssetSource(createAssetSource(map));
    this.viewport.setMap(map);
    this.mapNameEl.textContent = map.friendlyName || map.name;
    this.updateStats();
    this.renderTree(map);
    this.folderAssets = { object: null, spline: null, texture: null };
    this.renderAssetPalette("object");
    this.renderAssetPalette("spline");
    this.renderAssetPalette("texture");
    this.renderInspector(null);
    this.updateDirty();
    // U velké mapy se renderuje jen shluk kolem středu (anti-crash) - dej vědět.
    if (map.totalTiles > map.tiles.length) {
      this.setStatus(
        `${status} - velká mapa: zobrazeno ${map.tiles.length} z ${map.totalTiles} dlaždic (střed). ` +
        `Limit změníš v Nastavení. Ukládají se jen upravené dlaždice, zbytek mapy zůstává beze změny.`
      );
    } else {
      this.setStatus(status);
    }
  }

  private updateStats() {
    if (!this.map) return;
    const o = this.map.tiles.reduce((a, t) => a + t.objects.length, 0);
    const s = this.map.tiles.reduce((a, t) => a + t.splines.length, 0);
    const tc = this.map.totalTiles > this.map.tiles.length
      ? `${this.map.tiles.length}/${this.map.totalTiles} dlaždic`
      : `${this.map.tiles.length} dlaždic`;
    this.statsEl.textContent = `${tc} · ${o} obj · ${s} splajnů`;
  }

  // ---------- Palety ----------

  /** Prvky palety pro daný druh: buď vylistovaná složka, nebo známé+použité. */
  private paletteSource(kind: AssetKind): { folder: boolean; items: string[] } {
    const folder = this.folderAssets[kind];
    if (folder) return { folder: true, items: folder };
    const used = !this.map ? []
      : kind === "object" ? usedObjectPaths(this.map)
      : kind === "spline" ? usedSplinePaths(this.map)
      : this.map.groundTex.map((g) => g.main).filter((m): m is string => !!m);
    // Známé (uložené) nejdřív, pak použité v mapě; deduplikace case-insensitive.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const p of [...getKnownAssets(kind), ...used]) {
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); merged.push(p); }
    }
    return { folder: false, items: merged };
  }

  /** Vybere asset (vyplní vstup, aktivuje nástroj) a zapamatuje si ho do palety. */
  private chooseAsset(kind: AssetKind, path: string): void {
    if (!path) return;
    addKnownAsset(kind, path);
    if (kind === "object") { this.objPathInput.value = path; this.viewport.setPlaceMode(path); }
    else if (kind === "spline") { this.roadPathInput.value = path; this.viewport.setRoadMode(path); }
    else { this.paintPathInput.value = path; this.viewport.setPaintMode(path); }
    this.renderAssetPalette(kind);
  }

  /** Vykreslí paletu daného druhu (složka nebo známé/použité) s filtrem. */
  private renderAssetPalette(kind: AssetKind): void {
    const listEl = kind === "object" ? this.paletteListEl : kind === "spline" ? this.roadListEl : this.paintListEl;
    listEl.innerHTML = "";
    if (!this.map) return;
    const { folder, items } = this.paletteSource(kind);
    const f = this.paletteFilter[kind].trim().toLowerCase();
    const filtered = f ? items.filter((p) => p.toLowerCase().includes(f) || baseName(p).toLowerCase().includes(f)) : items;
    if (folder) {
      const back = el("div", "palette-item palette-back", "← zpět na použité");
      back.addEventListener("click", () => { this.folderAssets[kind] = null; this.renderAssetPalette(kind); });
      listEl.append(back);
    }
    for (const p of filtered.slice(0, 1000)) {
      const item = el("div", "palette-item", baseName(p));
      item.title = p;
      item.addEventListener("click", () => this.chooseAsset(kind, p));
      listEl.append(item);
    }
    if (filtered.length === 0) {
      listEl.append(el("div", "hint", folder ? "Ve složce nic odpovídajícího." : "Zatím prázdné - otevři složku (📁) nebo zadej cestu výše."));
    }
  }

  /** Otevře složku (dialog) a zobrazí všechny assety daného druhu v paletě. */
  private async browseAssetFolder(kind: AssetKind): Promise<void> {
    if (!this.map) return;
    if (!isElectronApp()) { this.setStatus("Otevření složky funguje v desktop aplikaci.", true); return; }
    try {
      const rels = await listAssetFolder(kind, omsiRootOf(this.map));
      if (rels.length === 0) { this.setStatus("Ve zvolené složce nejsou žádné soubory (nebo výběr zrušen)."); return; }
      this.folderAssets[kind] = rels;
      this.renderAssetPalette(kind);
      this.setStatus(`Složka: ${rels.length} položek. Klikni pro výběr; výběr se uloží do palety.`);
    } catch (err) {
      this.setStatus("Chyba otevření složky: " + (err as Error).message, true);
    }
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
      ["ID", String(o.id ?? "-")],
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
      ["ID", String(s.id ?? "-")],
      ["Navázání", `prev ${s.prevId ?? "-"} · next ${s.nextId ?? "-"}`],
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
    this.renderAssetPalette("object");
  }

  private updateDirty() {
    const dirty = this.map ? this.map.tiles.filter((t) => t.dirty).length : 0;
    this.dirtyEl.style.display = dirty > 0 ? "inline-flex" : "none";
    this.dirtyEl.textContent = dirty > 0 ? `● neuloženo (${dirty}) - Ctrl+S` : "";
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

    // Konfigurovatelné bindy (viz Nastavení). Ctrl-zkratky a Esc fungují i v poli.
    const action = actionFromEvent(e);
    const ctrlLike = e.ctrlKey || e.metaKey;
    if (action && (ctrlLike || action === "cancel" || !inField)) {
      e.preventDefault();
      switch (action) {
        case "save": this.handleSave(); return;
        case "undo": this.setStatus(this.viewport.undo() ? "Vráceno zpět." : "Není co vrátit."); return;
        case "redo": this.setStatus(this.viewport.redo() ? "Znovu provedeno." : "Není co znovu provést."); return;
        case "duplicate": this.viewport.duplicateSelected(); return;
        case "delete": if (this.viewport.getSelection()) this.viewport.deleteSelected(); return;
        case "rotate": this.viewport.rotateSelected(e.shiftKey ? -15 : 15); return;
        case "gizmoMove": this.viewport.setGizmoMode("translate"); return;
        case "gizmoRotate": this.viewport.setGizmoMode("rotate"); return;
        case "gizmoScale": this.viewport.setGizmoMode("scale"); return;
        case "cancel":
          if (this.viewport.isToolActive()) { this.viewport.clearTools(); this.setStatus("Nástroj ukončen."); }
          this.selectTool("select");
          return;
      }
    }
    if (inField) return;
    // Jemný posun vybraného prvku šipkami (když je něco vybráno; jinak šipky =
    // pohyb kamery, který řeší viewport). Shift = větší krok.
    if (e.key.startsWith("Arrow") && this.viewport.getSelection()) {
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
