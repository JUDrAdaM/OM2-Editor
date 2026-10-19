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
 * Sekce [heightprofile], [length], [halfcantwidth] se týkají navázání na terén
 * a převýšení v obloucích - pro grafický mesh je nepotřebujeme a ignorujeme je.
 *
 * [path] = AI dráha (jízdní pruh / chodník / kolej). Formát je zdokumentovaný
 * přímo německou šablonou v Ruede\rail_concrete_01.sli:
 *   {type}     Typ: 0 = AI-Straßenverkehr (auta), 1 = AI-Menschen (chodci),
 *                   2 = Schiene (kolej, AI i hráč)
 *   {offsetX}  příčný offset od osy splajnu (vpravo kladně), metry
 *   {offsetZ}  výška nad osou splajnu (nahoru kladně), metry
 *   {width}    šířka dráhy (u aut/chodců dovoluje vyhýbání), metry
 *   {5. pole}  směr/pruh: u 2 autopruhů silnice typicky 1 (protisměr) a 0 (po
 *              směru splajnu; OMSI jezdí vpravo), u chodníků/koleje bývá 2.
 * Splajn „nese AI provoz" právě tehdy, když má aspoň jednu [path]. První [path]
 * v některých souborech je ŠABLONA s placeholdery `{type}`,`0:`… (nečíselné) -
 * ta se odfiltruje (viz parseSli), aby nevznikla falešná dráha.
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

/** Typ AI dráhy ([path]) ve splajnu. */
export const PATH_CAR = 0;      // AI-Straßenverkehr (auta)
export const PATH_PED = 1;      // AI-Menschen (chodci)
export const PATH_RAIL = 2;     // Schiene (kolej)

/** Jedna AI dráha ([path]) splajnu: jízdní pruh, chodník nebo kolej. */
export interface SliPath {
  /** Typ: 0 = auta, 1 = chodci, 2 = kolej (PATH_CAR/PED/RAIL). */
  type: number;
  /** Příčný offset od osy splajnu (vpravo kladně), metry. */
  offsetX: number;
  /** Výška nad osou splajnu (nahoru kladně), metry. */
  offsetZ: number;
  /** Šířka dráhy, metry. */
  width: number;
  /** 5. pole: směr/pruh (0 = po směru splajnu, 1 = protisměr; u chodníků/koleje bývá 2). */
  dir: number;
}

export interface SliDef {
  /** Jména textur v pořadí definice (0-based index). */
  textures: string[];
  /** Grafické profily (každý = jeden extrudovaný pás). */
  profiles: SliProfile[];
  /** AI dráhy (jízdní pruhy / chodníky / koleje) - viz SliPath. Prázdné = splajn
   *  nenese AI provoz (dekorace, zdi, ploty…). */
  paths: SliPath[];
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
  const paths: SliPath[] = [];
  let current: SliProfile | null = null;
  let onlyEditor = false;

  for (const sec of sections) {
    const name = sec.name.toLowerCase();
    if (name === "path") {
      // Pozor: první [path] v některých souborech je dokumentační ŠABLONA s
      // placeholdery (`{type}`, `0:` …) - numericValues je zahodí, takže zbyde
      // < 4 čísel → dráha se nevytvoří. Reálná [path] má type 0/1/2 + 3-4 čísla.
      const n = numericValues(sec.values);
      const type = n.length ? Math.round(n[0]) : -1;
      if (n.length >= 4 && (type === PATH_CAR || type === PATH_PED || type === PATH_RAIL)) {
        paths.push({ type, offsetX: n[1], offsetZ: n[2], width: n[3], dir: n.length >= 5 ? Math.round(n[4]) : 0 });
      }
    } else if (name === "texture") {
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
    paths,
    onlyEditor,
  };
}
