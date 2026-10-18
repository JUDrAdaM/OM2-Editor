import { parseOmsiConfig, num } from "./parser";

/**
 * Parser OMSI spline definic (*.sli) - příčný profil silnice/koleje/chodníku.
 *
 * Formát (ověřeno na reálných .sli v OMSI 2, mj. Ruede\rail_concrete_01.sli,
 * který obsahuje původní německou dokumentaci formátu):
 *
 *   [texture]        - jméno textury; pořadí určuje 0-based index.
 *   [profile]        - začíná nový extrudovaný pás; jediná hodnota = index textury.
 *   [profilepnt]     - jeden bod příčného profilu, 4 hodnoty:
 *                        1) x  = příčná poloha (vpravo kladně), metry
 *                        2) z  = výška nad osou splajnu, metry
 *                        3) U  = texturová souřadnice napříč profilem
 *                        4) sklon V = 1/m (0.2 → V=1 po 5 m podél splajnu); V začíná na 0
 *   [onlyeditor]     - pomocný spline (neviditelný ve hře), např. invis_sidewalk.
 *
 * Body profilu MUSÍ jít zleva doprava (kvůli správným normálám / viditelnosti
 * horní strany). Extruze profilu podél křivky splajnu dává výsledný mesh.
 *
 * Sekce [heightprofile], [length], [halfcantwidth], [path] se týkají navázání
 * na terén, převýšení v obloucích a jízdních drah (AI) - pro grafický mesh je
 * zatím nepotřebujeme a ignorujeme je.
 */

export interface SliProfilePoint {
  /** Příčná poloha (vpravo kladně), metry. */
  x: number;
  /** Výška nad osou splajnu, metry. */
  z: number;
  /** Texturová souřadnice U (napříč profilem). */
  u: number;
  /** Sklon V souřadnice v 1/m (jak rychle se textura opakuje podél splajnu). */
  vSlope: number;
}

export interface SliProfile {
  /** Index textury (do pole SliDef.textures). */
  texIndex: number;
  /** Body profilu v pořadí zleva doprava. */
  points: SliProfilePoint[];
}

export interface SliDef {
  /** Jména textur v pořadí definice (0-based index). */
  textures: string[];
  /** Grafické profily (každý = jeden extrudovaný pás). */
  profiles: SliProfile[];
  /** Pomocný spline jen pro editor (neviditelný ve hře). */
  onlyEditor: boolean;
}

/** Vybere z řádků sekce jen číselné hodnoty (ignoruje popisky typu „Lane:"). */
function numericValues(values: string[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const n = parseFloat(t.replace(",", "."));
    if (Number.isFinite(n) && !Number.isNaN(Number(t.replace(",", ".")))) out.push(n);
  }
  return out;
}

/** Rozparsuje obsah .sli souboru na definici profilu(ů) a textur. */
export function parseSli(text: string): SliDef {
  const sections = parseOmsiConfig(text);
  const textures: string[] = [];
  const profiles: SliProfile[] = [];
  let current: SliProfile | null = null;
  let onlyEditor = false;

  for (const sec of sections) {
    const name = sec.name.toLowerCase();
    if (name === "texture") {
      const file = sec.values.find((v) => v.trim().length > 0)?.trim() ?? "";
      textures.push(file);
    } else if (name === "profile") {
      const nums = numericValues(sec.values);
      current = { texIndex: nums.length ? Math.round(nums[0]) : 0, points: [] };
      profiles.push(current);
    } else if (name === "profilepnt") {
      if (!current) continue;
      const nums = numericValues(sec.values);
      if (nums.length < 2) continue;
      const prev = current.points[current.points.length - 1];
      current.points.push({
        x: num(String(nums[0])),
        z: num(String(nums[1])),
        u: nums.length >= 3 ? nums[2] : 0,
        // Sklon V může u posledního bodu chybět - zdědíme ho z předchozího bodu.
        vSlope: nums.length >= 4 ? nums[3] : prev?.vSlope ?? 0,
      });
    } else if (name === "onlyeditor") {
      onlyEditor = true;
    }
  }

  // Profily bez aspoň dvou bodů nelze extrudovat.
  return {
    textures,
    profiles: profiles.filter((p) => p.points.length >= 2),
    onlyEditor,
  };
}
