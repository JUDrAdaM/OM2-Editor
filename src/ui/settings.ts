import {
  getAppVersion,
  formatVersion,
  versionChannel,
  checkForUpdate,
  installUpdate,
  onUpdateStatus,
  getOmsiRoot,
  pickOmsiRoot,
  isElectronApp,
  type UpdateStatus,
} from "../fs/loader";

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
 * Modální okno Nastavení: verze editoru, aktualizace (ruční kontrola +
 * live stav z autoupdatu) a cesta k OMSI 2. Otevírá se z úvodního menu
 * i z editoru. Spravuje si vlastní úklid (ESC / klik mimo / Zavřít).
 */
export class SettingsDialog {
  private overlay!: HTMLElement;
  private unsub: (() => void) | null = null;

  private versionEl!: HTMLElement;
  private channelEl!: HTMLElement;
  private updateStatusEl!: HTMLElement;
  private checkBtn!: HTMLButtonElement;
  private installBtn!: HTMLButtonElement;
  private pathEl!: HTMLElement;

  /** Zavolá se po změně cesty k OMSI (aby menu mohlo obnovit seznam map). */
  constructor(private onRootChanged?: (root: string | null) => void) {}

  open() {
    this.render();
    document.body.append(this.overlay);
    window.addEventListener("keydown", this.onKeyDown);

    // Live stav aktualizací.
    this.unsub = onUpdateStatus((s) => this.renderUpdate(s));

    void this.loadVersion();
    void this.loadPath();
  }

  close() {
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener("keydown", this.onKeyDown);
    this.overlay.remove();
  }

  // ---------- Render ----------

  private render() {
    this.overlay = el("div", "modal-overlay");
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });

    const card = el("div", "modal-card");

    const head = el("div", "modal-head");
    head.append(el("h2", "modal-title", "Nastavení"));
    const x = el("button", "modal-close", "✕");
    x.title = "Zavřít";
    x.addEventListener("click", () => this.close());
    head.append(x);
    card.append(head);

    const bodyEl = el("div", "modal-body");

    // --- Sekce: Aktualizace ---
    bodyEl.append(el("div", "modal-section-title", "Aktualizace"));

    const verRow = el("div", "set-row");
    verRow.append(el("div", "set-key", "Verze editoru"));
    const verVal = el("div", "set-val");
    this.versionEl = el("span", "set-version", "…");
    this.channelEl = el("span", "set-badge", "");
    verVal.append(this.versionEl, this.channelEl);
    verRow.append(verVal);
    bodyEl.append(verRow);

    const updRow = el("div", "set-update");
    this.checkBtn = el("button", "btn btn-sm", "Zkontrolovat aktualizace") as HTMLButtonElement;
    this.checkBtn.addEventListener("click", () => this.handleCheck());
    this.installBtn = el(
      "button",
      "btn btn-sm btn-primary",
      "Restartovat a aktualizovat"
    ) as HTMLButtonElement;
    this.installBtn.style.display = "none";
    this.installBtn.addEventListener("click", () => installUpdate());
    updRow.append(this.checkBtn, this.installBtn);
    bodyEl.append(updRow);

    this.updateStatusEl = el("div", "set-update-status", "");
    bodyEl.append(this.updateStatusEl);

    // --- Sekce: OMSI 2 ---
    bodyEl.append(el("div", "modal-section-title", "OMSI 2"));
    const pathRow = el("div", "set-row");
    pathRow.append(el("div", "set-key", "Instalace"));
    const pathVal = el("div", "set-val");
    this.pathEl = el("span", "set-path", "…");
    pathVal.append(this.pathEl);
    pathRow.append(pathVal);
    bodyEl.append(pathRow);

    const changeRow = el("div", "set-update");
    const changeBtn = el("button", "btn btn-sm", "Změnit cestu…");
    changeBtn.addEventListener("click", () => this.handlePickRoot());
    if (!isElectronApp()) changeBtn.disabled = true;
    changeRow.append(changeBtn);
    bodyEl.append(changeRow);

    card.append(bodyEl);

    const foot = el("div", "modal-foot");
    const closeBtn = el("button", "btn", "Zavřít");
    closeBtn.addEventListener("click", () => this.close());
    foot.append(closeBtn);
    card.append(foot);

    this.overlay.append(card);
  }

  // ---------- Verze ----------

  private async loadVersion() {
    const raw = await getAppVersion();
    this.versionEl.textContent = formatVersion(raw) || "—";
    const ch = versionChannel(raw);
    this.channelEl.textContent = ch;
    this.channelEl.style.display = ch ? "inline-flex" : "none";
    if (!raw) {
      this.updateStatusEl.textContent =
        "Verzi a aktualizace lze zobrazit jen v desktop aplikaci.";
    }
  }

  // ---------- Aktualizace ----------

  private async handleCheck() {
    this.checkBtn.disabled = true;
    this.installBtn.style.display = "none";
    this.setUpdateStatus("Kontroluji aktualizace…");
    try {
      const res = await checkForUpdate();
      if (!res.ok) {
        this.setUpdateStatus(res.message || "Kontrola se nezdařila.", true);
      }
      // Při úspěchu dorazí konkrétní stav přes onUpdateStatus (available/none/…).
    } catch (err) {
      this.setUpdateStatus("Chyba: " + (err as Error).message, true);
    } finally {
      // Krátká ochrana proti dvojkliku; pokud běží stahování, stav to přepíše.
      setTimeout(() => (this.checkBtn.disabled = false), 1200);
    }
  }

  private renderUpdate(s: UpdateStatus) {
    this.installBtn.style.display = "none";
    switch (s.state) {
      case "checking":
        this.setUpdateStatus("Kontroluji aktualizace…");
        break;
      case "available":
        this.setUpdateStatus(`Nalezena verze ${s.version ?? ""} – stahuji…`);
        break;
      case "downloading":
        this.setUpdateStatus(`Stahuji aktualizaci… ${s.percent ?? 0} %`);
        break;
      case "downloaded":
        this.setUpdateStatus(`Aktualizace ${s.version ?? ""} je připravena.`, false, true);
        this.installBtn.style.display = "inline-flex";
        break;
      case "none":
        this.setUpdateStatus("Máš nejnovější verzi.");
        break;
      case "error":
        this.setUpdateStatus("Aktualizace selhala: " + (s.message ?? ""), true);
        break;
    }
  }

  private setUpdateStatus(text: string, error = false, ready = false) {
    this.updateStatusEl.textContent = text;
    this.updateStatusEl.classList.toggle("error", error);
    this.updateStatusEl.classList.toggle("ready", ready);
  }

  // ---------- Cesta k OMSI ----------

  private async loadPath() {
    if (!isElectronApp()) {
      this.pathEl.textContent = "Jen v desktop aplikaci.";
      return;
    }
    try {
      const root = await getOmsiRoot();
      this.setPath(root);
    } catch {
      this.setPath(null);
    }
  }

  private setPath(root: string | null) {
    this.pathEl.textContent = root || "Nenalezeno – nastav cestu ručně.";
    this.pathEl.classList.toggle("missing", !root);
  }

  private async handlePickRoot() {
    try {
      const root = await pickOmsiRoot();
      if (root) {
        this.setPath(root);
        this.onRootChanged?.(root);
      }
    } catch (err) {
      this.setUpdateStatus("Chyba: " + (err as Error).message, true);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.close();
    }
  };
}

/** Pohodlné otevření okna Nastavení. */
export function openSettings(onRootChanged?: (root: string | null) => void) {
  new SettingsDialog(onRootChanged).open();
}
