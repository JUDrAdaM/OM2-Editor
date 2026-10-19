import {
  setFriendlyName,
  setMapName,
  getDescription,
  setDescription,
  getGroundTexEntries,
  setGroundTexEntries,
  type GroundTexEntry,
} from "../omsi/map";
import { saveGlobalCfg, pickAssetFiles, omsiRootOf, isElectronApp } from "../fs/loader";
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

/**
 * Modální okno „Vlastnosti mapy": editace global.cfg - přívětivý název, interní
 * název, popis a paleta terénních textur [groundtex] (přidat/odebrat/pořadí).
 * Ukládá přes saveGlobalCfg (bezpečný round-trip: ostatní sekce zůstanou). Po
 * uložení zavolá onSaved, aby editor obnovil náhled terénu a palety.
 */
export class MapPropsDialog {
  private overlay!: HTMLElement;
  private friendlyInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private descInput!: HTMLTextAreaElement;
  private groundListEl!: HTMLElement;
  private statusEl!: HTMLElement;
  /** Pracovní kopie palety - aplikuje se do mapy až při uložení. */
  private ground: GroundTexEntry[] = [];

  constructor(
    private map: OmsiMap,
    private onSaved: () => void
  ) {}

  open() {
    this.ground = getGroundTexEntries(this.map);
    this.render();
    document.body.append(this.overlay);
    window.addEventListener("keydown", this.onKeyDown, true);
    this.friendlyInput.focus();
  }

  close() {
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.overlay.remove();
  }

  private render() {
    this.overlay = el("div", "modal-overlay");
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });

    const card = el("div", "modal-card");
    const head = el("div", "modal-head");
    head.append(el("h2", "modal-title", "Vlastnosti mapy"));
    const x = el("button", "modal-close", "✕");
    x.title = "Zavřít";
    x.addEventListener("click", () => this.close());
    head.append(x);
    card.append(head);

    const body = el("div", "modal-body");

    body.append(el("div", "modal-section-title", "Identita"));
    body.append(el("div", "set-key", "Přívětivý název ([friendlyname])"));
    this.friendlyInput = el("input", "edit-input") as HTMLInputElement;
    this.friendlyInput.value = this.map.friendlyName || "";
    this.friendlyInput.style.width = "100%";
    body.append(this.friendlyInput);

    body.append(el("div", "set-key", "Interní název ([name])"));
    this.nameInput = el("input", "edit-input") as HTMLInputElement;
    this.nameInput.value = this.map.name || "";
    this.nameInput.style.width = "100%";
    body.append(this.nameInput);

    body.append(el("div", "set-key", "Popis ([description])"));
    this.descInput = el("textarea", "edit-input") as HTMLTextAreaElement;
    this.descInput.rows = 3;
    this.descInput.value = getDescription(this.map);
    this.descInput.style.width = "100%";
    this.descInput.style.resize = "vertical";
    body.append(this.descInput);

    body.append(el("div", "modal-section-title", "Terénní textury ([groundtex])"));
    body.append(el("div", "hint",
      "Pořadí = index: první je základní textura terénu (tráva), další jsou detaily " +
      "(cesty, dlažba). Cesty jsou relativní ke kořeni OMSI (např. texture\\gras.bmp)."));
    this.groundListEl = el("div", "binds");
    body.append(this.groundListEl);
    this.renderGround();

    const addRow = el("div", "set-update");
    const addBtn = el("button", "btn btn-sm", "+ Přidat texturu");
    addBtn.addEventListener("click", () => {
      this.ground.push({ main: "", detail: "", nums: ["0", "1", "60"] });
      this.renderGround();
    });
    const browseBtn = el("button", "btn btn-sm", "Procházet…");
    browseBtn.title = "Vybrat texturu z instalace OMSI a přidat do palety";
    browseBtn.addEventListener("click", () => this.browseAdd());
    if (!isElectronApp()) browseBtn.disabled = true;
    addRow.append(addBtn, browseBtn);
    body.append(addRow);

    this.statusEl = el("div", "set-update-status", "");
    body.append(this.statusEl);
    card.append(body);

    const foot = el("div", "modal-foot");
    const cancel = el("button", "btn", "Zrušit");
    cancel.addEventListener("click", () => this.close());
    const save = el("button", "btn btn-primary", "Uložit global.cfg");
    save.addEventListener("click", () => this.handleSave());
    foot.append(cancel, save);
    card.append(foot);

    this.overlay.append(card);
  }

  private renderGround() {
    this.groundListEl.innerHTML = "";
    if (this.ground.length === 0) {
      this.groundListEl.append(el("div", "hint", "Žádná textura - přidej alespoň základní."));
    }
    this.ground.forEach((g, i) => {
      const row = el("div", "set-row");
      const key = el("div", "set-key", i === 0 ? "0 · základní" : String(i));
      const val = el("div", "set-val");

      const main = el("input", "edit-input") as HTMLInputElement;
      main.value = g.main;
      main.placeholder = "texture\\gras.bmp";
      main.title = g.main || "cesta k textuře";
      main.style.minWidth = "180px";
      main.addEventListener("change", () => { g.main = main.value.trim(); });

      const up = el("button", "btn btn-sm", "↑");
      up.title = "Posunout nahoru";
      up.disabled = i === 0;
      up.addEventListener("click", () => { this.move(i, -1); });

      const down = el("button", "btn btn-sm", "↓");
      down.title = "Posunout dolů";
      down.disabled = i === this.ground.length - 1;
      down.addEventListener("click", () => { this.move(i, 1); });

      const del = el("button", "btn btn-sm btn-danger", "✕");
      del.title = "Odebrat";
      del.addEventListener("click", () => { this.ground.splice(i, 1); this.renderGround(); });

      val.append(main, up, down, del);
      row.append(key, val);
      this.groundListEl.append(row);
    });
  }

  private move(i: number, dir: number) {
    const j = i + dir;
    if (j < 0 || j >= this.ground.length) return;
    const tmp = this.ground[i];
    this.ground[i] = this.ground[j];
    this.ground[j] = tmp;
    this.renderGround();
  }

  private async browseAdd() {
    try {
      const rels = await pickAssetFiles("texture", omsiRootOf(this.map));
      for (const r of rels) this.ground.push({ main: r, detail: "", nums: ["0", "1", "60"] });
      if (rels.length) this.renderGround();
    } catch (err) {
      this.setStatus("Chyba výběru: " + (err as Error).message, true);
    }
  }

  private setStatus(text: string, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }

  private async handleSave() {
    try {
      setFriendlyName(this.map, this.friendlyInput.value.trim());
      if (this.nameInput.value.trim()) setMapName(this.map, this.nameInput.value.trim());
      setDescription(this.map, this.descInput.value);
      setGroundTexEntries(this.map, this.ground.filter((g) => g.main.trim()));
      this.setStatus("Ukládám…");
      await saveGlobalCfg(this.map);
      this.onSaved();
      this.close();
    } catch (err) {
      this.setStatus("Chyba uložení: " + (err as Error).message, true);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && t.tagName !== "TEXTAREA") { e.stopPropagation(); this.close(); }
  };
}

/** Pohodlné otevření dialogu Vlastnosti mapy. */
export function openMapProps(map: OmsiMap, onSaved: () => void) {
  new MapPropsDialog(map, onSaved).open();
}
