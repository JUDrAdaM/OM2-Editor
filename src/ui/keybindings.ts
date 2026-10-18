// Konfigurovatelné klávesové zkratky (bindy).
//
// Diskrétní akce (uložit, zpět, gizmo, smazat...) jsou přemapovatelné a ukládají
// se do localStorage. Pohyb kamery (WASD + šipky) a myš jsou pevné a jen se
// zobrazují v Nápovědě. Modul je sdílený: Nastavení (editor bindů) i Nápověda
// čtou ze stejného zdroje, takže jsou vždy v souladu.

export type ActionId =
  | "save" | "undo" | "redo" | "duplicate" | "delete"
  | "rotate" | "gizmoMove" | "gizmoRotate" | "gizmoScale" | "cancel";

export interface ActionDef {
  id: ActionId;
  label: string;
  /** Výchozí binding (normalizovaný řetězec, viz comboFromEvent). */
  def: string;
}

/** Přemapovatelné akce + jejich výchozí klávesy. */
export const ACTIONS: ActionDef[] = [
  { id: "save", label: "Uložit", def: "Ctrl+S" },
  { id: "undo", label: "Zpět", def: "Ctrl+Z" },
  { id: "redo", label: "Znovu (vpřed)", def: "Ctrl+Y" },
  { id: "duplicate", label: "Duplikovat objekt", def: "Ctrl+D" },
  { id: "delete", label: "Smazat výběr", def: "Delete" },
  { id: "rotate", label: "Otočit výběr o 15 stupnu", def: "R" },
  { id: "gizmoMove", label: "Gizmo: Posun", def: "1" },
  { id: "gizmoRotate", label: "Gizmo: Rotace", def: "2" },
  { id: "gizmoScale", label: "Gizmo: Měřítko (stromy)", def: "3" },
  { id: "cancel", label: "Zrušit nástroj / výběr", def: "Escape" },
];

/** Pevné zkratky navigace (jen pro Nápovědu, nepřemapovatelné). */
export const FIXED_HELP: { keys: string; label: string }[] = [
  { keys: "W / A / S / D", label: "Pohyb kamery (vpřed/vlevo/vzad/vpravo)" },
  { keys: "Šipky", label: "Pohyb kamery (když nic není vybráno)" },
  { keys: "Šipky", label: "Jemný posun vybraného objektu (když je vybrán)" },
  { keys: "Shift + pohyb", label: "Rychlejší kamera / větší posun" },
  { keys: "Levé tlačítko + tah", label: "Výběr a posun objektu" },
  { keys: "Pravé tlačítko / prostřední + tah", label: "Otáčení / posun kamery myší" },
  { keys: "Kolečko", label: "Přiblížení (zoom)" },
];

const LS_KEY = "om2.keybinds.v1";

function loadOverrides(): Partial<Record<ActionId, string>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ActionId, string>>) : {};
  } catch {
    return {};
  }
}
function saveOverrides(o: Partial<Record<ActionId, string>>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

let overrides = loadOverrides();
const defMap: Record<ActionId, string> = Object.fromEntries(ACTIONS.map((a) => [a.id, a.def])) as Record<ActionId, string>;

/** Aktuální binding dané akce (override, jinak výchozí). */
export function bindingFor(id: ActionId): string {
  return overrides[id] ?? defMap[id];
}

/** Všechny akce s aktuálními klávesami (pro UI). */
export function allBindings(): { id: ActionId; label: string; key: string; isDefault: boolean }[] {
  return ACTIONS.map((a) => ({ id: a.id, label: a.label, key: overrides[a.id] ?? a.def, isDefault: !overrides[a.id] }));
}

/** Přemapuje akci. Prázdná/undefined klávesa = zpět na výchozí. */
export function setBinding(id: ActionId, key: string | null) {
  if (!key) delete overrides[id];
  else overrides[id] = key;
  saveOverrides(overrides);
}

/** Vrátí vše na výchozí hodnoty. */
export function resetBindings() {
  overrides = {};
  saveOverrides(overrides);
}

/** Je daná klávesa už přiřazená jiné akci? (vrátí její id nebo null) */
export function conflictOf(id: ActionId, key: string): ActionId | null {
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    if ((overrides[a.id] ?? a.def) === key) return a.id;
  }
  return null;
}

/** Normalizuje stisk na řetězec typu "Ctrl+Shift+S", "Delete", "ArrowUp", "1". */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  // samotné modifikátory nejsou platná klávesa
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return "";
  parts.push(key);
  return parts.join("+");
}

/** Najde akci přiřazenou ke stisku (Backspace je alias pro Delete). */
export function actionFromEvent(e: KeyboardEvent): ActionId | null {
  let combo = comboFromEvent(e);
  if (!combo) return null;
  for (const a of ACTIONS) {
    const b = overrides[a.id] ?? a.def;
    if (b === combo) return a.id;
    if (a.id === "delete" && b === "Delete" && combo === "Backspace") return "delete";
  }
  return null;
}

/** Hezčí popisek klávesy pro zobrazení (šipky jako symboly). */
export function prettyKey(key: string): string {
  return key
    .replace("ArrowUp", "↑").replace("ArrowDown", "↓")
    .replace("ArrowLeft", "←").replace("ArrowRight", "→")
    .replace("Escape", "Esc");
}
