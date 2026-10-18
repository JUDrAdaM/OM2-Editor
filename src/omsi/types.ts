// Datový model mapy OMSI 2.
//
// Round-trip princip: ZDROJEM PRAVDY je pole `sections` každé dlaždice -
// přesné sekce .map souboru v původním pořadí (včetně hlavičky a sekcí, které
// neumíme interpretovat). Objekty a splajny jsou jen „pohled" s odkazem zpět
// (sectionIndex, pathIndex). Díky tomu uložíme soubor beze ztráty dat a ve
// správném kódování (UTF-16LE).

export const TILE_SIZE = 300; // metrů; jedna dlaždice OMSI je 300×300 m

/** Jedna sekce v OMSI konfiguračním souboru: `[name]` + následující řádky hodnot. */
export interface OmsiSection {
  name: string;
  values: string[];
}

/**
 * Výškmapa terénu dlaždice (binární *.terrain).
 * Formát: int32 hlavička (počet dílků, obvykle 60) + size×size float32 výšek (metry),
 * row-major. size = dílky+1 (typicky 61). Rozteč bodů = TILE_SIZE / dílky (= 5 m).
 */
export interface TerrainData {
  /** Počet bodů na stranu (typicky 61). */
  size: number;
  /** Výšky v metrech, row-major; délka = size*size. (Pole kvůli JSON-serializaci.) */
  heights: Float32Array | number[];
}

/** Objekt (scenery object, .sco) umístěný na dlaždici. */
export interface MapObject {
  id: number | null;
  /** Relativní cesta k .sco souboru. */
  path: string;
  /** Lokální pozice v rámci dlaždice (metry). */
  x: number;
  y: number;
  z: number;
  /** Rotace ve stupních (rotZ = heading kolem svislé osy). */
  rotX: number;
  rotY: number;
  rotZ: number;
  /** Per-instance výška stromu (metry) z přepisu v [object] - stromy se stejným
   *  .sco mají různou velikost (přirozený les). undef = použít výchozí ze .sco. */
  treeHeight?: number;
  /** Per-instance poměr šířka/výška billboardu stromu (z téhož přepisu). */
  treeRatio?: number;
  /** Per-instance textura stromu (druh) z téhož přepisu; relativní ke .sco složce. */
  treeTex?: string;
  /** Index sekce v `tile.sections`, odkud objekt pochází. */
  sectionIndex: number;
  /** Index řádku s cestou v rámci `section.values`. */
  pathIndex: number;
}

/** Spline (silnice, kolej, chodník …, .sli) na dlaždici. */
export interface MapSpline {
  id: number | null;
  /** ID navazujícího předchozího/dalšího splajnu (0 = žádný) - pro řetězení. */
  prevId: number | null;
  nextId: number | null;
  path: string;
  x: number;
  y: number;
  z: number;
  /** Směr (azimut) na začátku splajnu, stupně. */
  rotZ: number;
  /** Délka segmentu v metrech. */
  length: number;
  /** Poloměr oblouku (0 = rovný), metry. */
  radius: number;
  /** Převýšení (gradient) start/end. */
  gradientStart: number;
  gradientEnd: number;
  /** [spline_h]: celkové převýšení po délce (metry). Výška běží jako kubika mezi
   *  oběma gradienty a končí přesně o tolik výš. null = běžný [spline] (parabola). */
  deltaH: number | null;
  /**
   * Kumulativní offset tohoto splajnu v řetězci (metry) = vzdálenost začátku
   * tohoto splajnu od začátku CELÉHO řetězce (přes dlaždice). V OMSI uložen jako
   * `tex_offset` (poslední trojice čísel [spline] záznamu; verze ≥11). Používá se
   * k umístění řad [splineAttachement(_repeater)]: vzdálenost objektu podél tohoto
   * splajnu = startDist − chainOffset + j·interval. 0 = začátek řetězce.
   */
  chainOffset: number;
  sectionIndex: number;
  pathIndex: number;
}

/** [splineAttachement]: řada objektů podél splajnu (lampy, stožáry, značky, parkování). */
export interface SplineAttachment {
  /** ID záznamu řady (pro [attachObj], který visí na „kotvě" = 1. objektu řady). */
  id: number | null;
  /** true = [splineAttachement_repeater] (pokračování řady v sousední dlaždici).
   *  Repeater nikdy netvoří kotvu pro [attachObj] (dle openOMSI). */
  isRepeater: boolean;
  /** Cesta k .sco objektu. */
  path: string;
  /** Index splajnu v tile.splines, podél kterého se řada umisťuje. */
  splineIndex: number;
  /** Příčný offset (vpravo od směru splajnu, metry). */
  lateral: number;
  /** Výška nad splajnem (metry). */
  height: number;
  /** Vzdálenost prvního objektu od začátku řetězce splajnu (metry). */
  startDist: number;
  /** Natočení objektu vůči směru splajnu (stupně). */
  heading: number;
  /** Rozestup mezi objekty (metry); 0 = jeden objekt. */
  interval: number;
  /** Dosah řady od prvního objektu (metry). */
  range: number;
  sectionIndex: number;
}

/** [attachObj]: objekt zavěšený na bodu [new_attachment] rodičovského objektu. */
export interface AttachObject {
  /** Vlastní ID (aby na tomto objektu mohly viset další [attachObj] - vnořené). */
  id: number | null;
  /** Cesta k .sco. */
  path: string;
  /** ID rodičovského objektu v mapě (objekt, kotva řady, nebo jiný [attachObj]). */
  parentId: number | null;
  /** Index bodu [new_attachment] rodiče (0-based). */
  attachIndex: number;
  /** Vlastní natočení (heading, stupně). */
  heading: number;
  sectionIndex: number;
}

/** Jedna dlaždice mapy. */
export interface MapTile {
  /** Souřadnice dlaždice v mřížce (z global.cfg). */
  tileX: number;
  tileY: number;
  /** Název .map souboru. */
  fileName: string;
  /** ZDROJ PRAVDY: všechny sekce .map v původním pořadí (vč. hlavičky). */
  sections: OmsiSection[];
  /** Odvozený pohled - objekty. */
  objects: MapObject[];
  /** Odvozený pohled - splajny. */
  splines: MapSpline[];
  /** Odvozený pohled - řady objektů podél splajnů ([splineAttachement]). */
  splineAttachments: SplineAttachment[];
  /** Odvozený pohled - objekty zavěšené na rodičích ([attachObj]). */
  attachObjects: AttachObject[];
  /** Odkazy na textury terénu (groundtex), pořadí = index. */
  groundTextures: string[];
  /** Výškmapa terénu (pokud existuje *.terrain soubor). */
  terrain?: TerrainData;
  /** Dlaždice byla editována a čeká na uložení. */
  dirty: boolean;
  /** Nová dlaždice přidaná v editoru (ještě není v global.cfg na disku). Při
   *  uložení se zapíše její .map + .terrain a doplní záznam [map] do global.cfg. */
  isNew?: boolean;
}

/** Celá mapa. */
export interface OmsiMap {
  name: string;
  friendlyName: string;
  /** Jméno kořenové složky mapy. */
  rootName: string;
  /** Absolutní cesta ke složce mapy (pro ukládání v Electronu); prázdné v prohlížeči. */
  rootPath: string;
  tiles: MapTile[];
  /** Syrové sekce z global.cfg, které zatím jen uchováváme. */
  globalSections: OmsiSection[];
  /**
   * Paleta terénních textur z global.cfg `[groundtex]` (pořadí = index). Index 0
   * je základní textura terénu (typicky tráva); další jsou detaily nanášené přes
   * splatmapu (cesty, dlažba…). Cesty jsou relativní ke KOŘENI OMSI (např.
   * `texture\gras.bmp`). Zatím používáme jen základní (index 0) dlaždicově.
   */
  groundTex: { main: string; detail: string }[];
}
