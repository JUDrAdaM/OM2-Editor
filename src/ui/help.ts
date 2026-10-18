import { allBindings, FIXED_HELP, prettyKey } from "./keybindings";
import { openSettings } from "./settings";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Modální okno Nápověda: přehled klávesových zkratek (konfigurovatelné bindy +
 * pevná navigace) a základní tipy k ovládání. Zkratky se čtou z keybindings.ts,
 * takže odpovídají tomu, co si uživatel nastavil.
 */
export class HelpDialog {
  private overlay!: HTMLElement;

  open() {
    this.overlay = el("div", "modal-overlay");
    this.overlay.addEventListener("click", (e) => { if (e.target === this.overlay) this.close(); });

    const card = el("div", "modal-card");
    const head = el("div", "modal-head");
    head.append(el("h2", "modal-title", "Nápověda a klávesové zkratky"));
    const x = el("button", "modal-close", "✕");
    x.title = "Zavřít";
    x.addEventListener("click", () => this.close());
    head.append(x);
    card.append(head);

    const body = el("div", "modal-body");

    body.append(el("div", "modal-section-title", "Akce (lze přenastavit)"));
    for (const b of allBindings()) {
      body.append(this.row(prettyKey(b.key), b.label));
    }

    body.append(el("div", "modal-section-title", "Pohyb a myš"));
    for (const f of FIXED_HELP) body.append(this.row(f.keys, f.label));

    body.append(el("div", "modal-section-title", "Nástroje"));
    body.append(
      this.row("Panel vlevo", "Výběr / Objekt / Silnice / Terén / Povrch / Guma"),
      this.row("Gizmo nahoře", "Posun / Rotace / Měřítko vybraného prvku"),
      this.row("Silnice", "Klikej body; silnice plynule zatáčí (oblouky)")
    );
    card.append(body);

    const foot = el("div", "modal-foot");
    const customize = el("button", "btn btn-sm", "Přenastavit zkratky…");
    customize.addEventListener("click", () => { this.close(); openSettings(); });
    const closeBtn = el("button", "btn", "Zavřít");
    closeBtn.addEventListener("click", () => this.close());
    foot.append(customize, el("div", "spacer"), closeBtn);
    card.append(foot);

    this.overlay.append(card);
    document.body.append(this.overlay);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private row(keys: string, label: string): HTMLElement {
    const r = el("div", "set-row");
    const k = el("div", "set-val");
    k.append(el("kbd", "kbd", keys));
    const l = el("div", "set-key help-label", label);
    r.append(k, l);
    return r;
  }

  close() {
    window.removeEventListener("keydown", this.onKeyDown);
    this.overlay.remove();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); this.close(); }
  };
}

export function openHelp() { new HelpDialog().open(); }
