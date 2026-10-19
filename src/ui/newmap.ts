import { createNewMap } from "../omsi/map";
import { createNewMapOnDisk } from "../fs/loader";
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

/** Očistí text na bezpečný název složky (zrcadlí sanitizeFolder v main.cjs). */
function sanitizeFolder(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/, "").slice(0, 80);
}

/**
 * Modální okno „Nová mapa": název, přívětivý název, složka (pod maps/) a popis.
 * Po potvrzení založí mapu na disku (global.cfg + 1 prázdná dlaždice) a předá ji
 * callbackem do editoru. Jen desktop (Electron).
 */
export class NewMapDialog {
  private overlay!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private friendlyInput!: HTMLInputElement;
  private folderInput!: HTMLInputElement;
  private descInput!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private createBtn!: HTMLButtonElement;
  private folderEdited = false;

  constructor(
    private omsiRoot: string | null,
    private onCreated: (map: OmsiMap, status: string) => void
  ) {}

  open() {
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
    head.append(el("h2", "modal-title", "Nová mapa"));
    const x = el("button", "modal-close", "✕");
    x.title = "Zavřít";
    x.addEventListener("click", () => this.close());
    head.append(x);
    card.append(head);

    const body = el("div", "modal-body");

    this.friendlyInput = this.field(body, "Přívětivý název", "Např. Moje město") as HTMLInputElement;
    this.friendlyInput.addEventListener("input", () => {
      if (!this.folderEdited) {
        const sane = sanitizeFolder(this.friendlyInput.value);
        this.folderInput.value = sane;
        this.nameInput.value = sane;
      }
    });

    this.nameInput = this.field(body, "Interní název ([name])", "NovaMapa") as HTMLInputElement;

    this.folderInput = this.field(body, "Složka v maps/", "NovaMapa") as HTMLInputElement;
    this.folderInput.addEventListener("input", () => { this.folderEdited = true; });

    body.append(el("div", "set-key", "Popis (volitelné)"));
    this.descInput = el("textarea", "edit-input") as HTMLTextAreaElement;
    this.descInput.rows = 3;
    this.descInput.placeholder = "Popis mapy, linky…";
    this.descInput.style.width = "100%";
    this.descInput.style.resize = "vertical";
    body.append(this.descInput);

    body.append(el("div", "hint",
      "Vytvoří se nová složka pod maps/ s global.cfg (UTF-16) a jednou prázdnou " +
      "plochou dlaždicí [0,0]. Dlaždice, objekty a silnice přidáš pak v editoru."));

    this.statusEl = el("div", "set-update-status", "");
    body.append(this.statusEl);
    card.append(body);

    const foot = el("div", "modal-foot");
    const cancel = el("button", "btn", "Zrušit");
    cancel.addEventListener("click", () => this.close());
    this.createBtn = el("button", "btn btn-primary", "Vytvořit mapu") as HTMLButtonElement;
    this.createBtn.addEventListener("click", () => this.handleCreate());
    foot.append(cancel, this.createBtn);
    card.append(foot);

    this.overlay.append(card);
  }

  private field(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    parent.append(el("div", "set-key", label));
    const input = el("input", "edit-input") as HTMLInputElement;
    input.placeholder = placeholder;
    input.style.width = "100%";
    parent.append(input);
    return input;
  }

  private setStatus(text: string, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }

  private async handleCreate() {
    const friendly = this.friendlyInput.value.trim();
    const name = this.nameInput.value.trim() || sanitizeFolder(friendly);
    const folder = sanitizeFolder(this.folderInput.value || name);
    if (!friendly && !name) { this.setStatus("Zadej alespoň název mapy.", true); return; }
    if (!folder) { this.setStatus("Zadej platný název složky.", true); return; }
    this.createBtn.disabled = true;
    this.setStatus("Vytvářím mapu…");
    try {
      const draft = createNewMap({
        name: name || folder,
        friendlyName: friendly || name || folder,
        description: this.descInput.value,
      });
      const map = await createNewMapOnDisk(draft, this.omsiRoot, folder);
      this.close();
      this.onCreated(map, `Nová mapa vytvořena: ${map.friendlyName || map.name}`);
    } catch (err) {
      this.setStatus("Chyba: " + (err as Error).message, true);
      this.createBtn.disabled = false;
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); this.close(); }
  };
}

/** Pohodlné otevření dialogu Nová mapa. */
export function openNewMap(
  omsiRoot: string | null,
  onCreated: (map: OmsiMap, status: string) => void
) {
  new NewMapDialog(omsiRoot, onCreated).open();
}
