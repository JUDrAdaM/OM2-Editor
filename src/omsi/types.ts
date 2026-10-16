// Datový model mapy OMSI 2.
//
// Round-trip princip: ZDROJEM PRAVDY je pole `sections` každé dlaždice –
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
  /** Index sekce v `tile.sections`, odkud objekt pochází. */
  sectionIndex: number;
  /** Index řádku s cestou v rámci `section.values`. */
  pathIndex: number;
}

/** Spline (silnice, kolej, chodník …, .sli) na dlaždici. */
export interface MapSpline {
  id: number | null;
  /** ID navazujícího předchozího/dalšího splajnu (0 = žádný) – pro řetězení. */
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
  sectionIndex: number;
  pathIndex: number;
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
  /** Odvozený pohled – objekty. */
  objects: MapObject[];
  /** Odvozený pohled – splajny. */
  splines: MapSpline[];
  /** Odkazy na textury terénu (groundtex), pořadí = index. */
  groundTextures: string[];
  /** Výškmapa terénu (pokud existuje *.terrain soubor). */
  terrain?: TerrainData;
  /** Dlaždice byla editována a čeká na uložení. */
  dirty: boolean;
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
}
