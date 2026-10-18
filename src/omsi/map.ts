import { parseOmsiConfig, num } from "./parser";
import { parseTerrain } from "./terrain";
import type {
  OmsiMap,
  MapTile,
  MapObject,
  MapSpline,
  SplineAttachment,
  AttachObject,
  OmsiSection,
} from "./types";

/**
 * Mapování polí (ověřeno na reálné mapě Grundorf, OMSI 2):
 *   [object]  flag, PATH, id, X, Y, Z, heading°, rotX, rotY, [texCount, textury…], název
 *   [spline]  flag, PATH, id, prevId, nextId, X, Z(výška), Y, heading°, délka, poloměr, sklonStart, sklonEnd
 * Offsety níže jsou relativní k řádku s cestou (pathIndex).
 */
const OBJ = { id: 1, x: 2, y: 3, z: 4, rotZ: 5, rotX: 6, rotY: 7 } as const;
const SPL = {
  id: 1, prevId: 2, nextId: 3, x: 4, z: 5, y: 6,
  rotZ: 7, length: 8, radius: 9, gradS: 10, gradE: 11,
} as const;

function isObjectSection(name: string) {
  // Jen [object]. [splineAttachement]/[splineAttachement_repeater] mají ÚPLNĚ jiný
  // layout (index splajnu, příčný offset, interval podél silnice) – parsovat je jako
  // běžný objekt by je rozházelo na náhodná místa. Řeší je deriveSplineAttachment,
  // [attachObj] deriveAttachObject.
  return name.toLowerCase() === "object";
}
function isSplineSection(name: string) {
  const n = name.toLowerCase();
  return n === "spline" || n === "spline_h";
}

function toInt(v: string | undefined): number | null {
  if (v == null) return null;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Najde v hodnotách řádek, který vypadá jako cesta k souboru dané přípony. */
function findPathLine(values: string[], ext: string): number {
  for (let i = 0; i < values.length; i++) {
    const t = values[i].trim().toLowerCase();
    if (t.endsWith(ext) || (t.includes("\\") && t.includes(ext))) return i;
  }
  for (let i = 0; i < values.length; i++) {
    const t = values[i].trim();
    if (t.length > 0 && Number.isNaN(Number(t.replace(",", ".")))) return i;
  }
  return -1;
}

/**
 * Přepis [object] za rotacemi: pole `count` (pathIndex+8) a `count` řádků. U
 * stromů je přepis `textura, výška, poměr` (každý billboard má vlastní velikost
 * i texturu). Vytáhneme 2 číselné hodnoty = výška + poměr (texturu zatím ne).
 * U běžných repaintů jsou přepisy jen názvy textur (žádná čísla) → vrátí null.
 */
function parseTreeOverride(v: string[], pathIndex: number): { height: number; ratio: number; tex?: string } | null {
  const count = parseInt((v[pathIndex + 8] ?? "0").trim(), 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  const nums: number[] = [];
  let tex: string | undefined;
  for (let k = 1; k <= count && pathIndex + 8 + k < v.length; k++) {
    const t = (v[pathIndex + 8 + k] ?? "").trim();
    if (!t) continue;
    const n = parseFloat(t.replace(",", "."));
    if (Number.isFinite(n) && !Number.isNaN(Number(t.replace(",", ".")))) nums.push(n);
    else if (!tex && /\.(dds|tga|bmp|png|jpg)$/i.test(t)) tex = t;
  }
  if (nums.length >= 2 && nums[0] > 0) return { height: nums[0], ratio: nums[1] > 0 ? nums[1] : 1, tex };
  return null;
}

function deriveObject(section: OmsiSection, sectionIndex: number): MapObject | null {
  const pathIndex = findPathLine(section.values, ".sco");
  if (pathIndex < 0) return null;
  const v = section.values;
  const treeOv = parseTreeOverride(v, pathIndex);
  return {
    id: toInt(v[pathIndex + OBJ.id]),
    path: v[pathIndex].trim(),
    x: num(v[pathIndex + OBJ.x]),
    y: num(v[pathIndex + OBJ.y]),
    z: num(v[pathIndex + OBJ.z]),
    rotZ: num(v[pathIndex + OBJ.rotZ]),
    rotX: num(v[pathIndex + OBJ.rotX]),
    rotY: num(v[pathIndex + OBJ.rotY]),
    treeHeight: treeOv?.height,
    treeRatio: treeOv?.ratio,
    treeTex: treeOv?.tex,
    sectionIndex,
    pathIndex,
  };
}

/**
 * Kumulativní offset splajnu v řetězci (OMSI `tex_offset`, verze ≥11). Záznam
 * [spline] po gradientech (a u [spline_h] po delta_h) obsahuje cant_start/end
 * (verze ≥5) a pak koncová čísla skew_start/skew_end/tex_offset. tex_offset je
 * 3. koncové číslo (při 1–2 je to 1.; při 0 je 0). map_chain_offset = tex_offset,
 * pokud je konečný a kladný, jinak 0 (přesně jako openOMSI read_spline).
 */
function splineChainOffset(v: string[], trailingStart: number): number {
  const nums: number[] = [];
  for (let i = trailingStart; i < v.length; i++) {
    const t = (v[i] ?? "").trim();
    if (t === "") continue;
    if (/^mirror/i.test(t)) break;
    if (/^object\s+nr/i.test(t)) continue;
    const n = parseFloat(t.replace(",", "."));
    if (Number.isFinite(n)) nums.push(n);
  }
  let texOffset = 0;
  if (nums.length >= 3) texOffset = nums[2];
  else if (nums.length >= 1) texOffset = nums[0];
  return Number.isFinite(texOffset) && texOffset > 0 ? texOffset : 0;
}

function deriveSpline(section: OmsiSection, sectionIndex: number, version: number): MapSpline | null {
  const pathIndex = findPathLine(section.values, ".sli");
  if (pathIndex < 0) return null;
  const v = section.values;
  // [spline_h] má po gradientech navíc jedno pole: celkové převýšení (delta_h).
  const isH = section.name.toLowerCase() === "spline_h";
  // Po gradS/gradE následuje (u _h) delta_h, pak cant_start/cant_end (verze ≥5),
  // pak koncová čísla (skew/tex_offset). Spočítáme index 1. koncového čísla.
  const hasCant = version >= 5 || version === 0;
  const trailingStart = pathIndex + SPL.gradE + 1 + (isH ? 1 : 0) + (hasCant ? 2 : 0);
  return {
    id: toInt(v[pathIndex + SPL.id]),
    prevId: toInt(v[pathIndex + SPL.prevId]),
    nextId: toInt(v[pathIndex + SPL.nextId]),
    path: v[pathIndex].trim(),
    x: num(v[pathIndex + SPL.x]),
    z: num(v[pathIndex + SPL.z]),
    y: num(v[pathIndex + SPL.y]),
    rotZ: num(v[pathIndex + SPL.rotZ]),
    length: num(v[pathIndex + SPL.length]),
    radius: num(v[pathIndex + SPL.radius]),
    gradientStart: num(v[pathIndex + SPL.gradS]),
    gradientEnd: num(v[pathIndex + SPL.gradE]),
    deltaH: isH ? num(v[pathIndex + SPL.gradE + 1]) : null,
    chainOffset: splineChainOffset(v, trailingStart),
    sectionIndex,
    pathIndex,
  };
}

/** Verze dlaždice z [version] (ovlivňuje layout záznamů); default 14 (moderní). */
function tileVersion(sections: OmsiSection[]): number {
  for (const s of sections) {
    if (s.name.toLowerCase() === "version") {
      const v = parseInt((s.values.find((x) => x.trim()) || "").trim(), 10);
      if (Number.isFinite(v)) return v;
    }
  }
  return 14;
}

/**
 * [splineAttachement]: řada objektů podél splajnu. Layout (po řádku s cestou .sco):
 *   id, splineIndex, lateral, height, startDist, heading, [v>=12: pitch, bank],
 *   interval, range, [v>=12: tilt], [v>=4: počet stringů + stringy]
 * [splineAttachement_repeater] (pokračování řady v sousední dlaždici) má navíc
 * 2 řádky PŘED cestou (master tile idx, pořadí 1. objektu) – ty findPathLine
 * přeskočí; pole za cestou jsou identická, takže se parsuje stejně.
 */
function deriveSplineAttachment(
  section: OmsiSection,
  sectionIndex: number,
  version: number
): SplineAttachment | null {
  const pathIndex = findPathLine(section.values, ".sco");
  if (pathIndex < 0) return null;
  const v = section.values;
  const modern = version >= 12 || version === 0;
  const intervalIdx = pathIndex + (modern ? 9 : 7);
  return {
    id: toInt(v[pathIndex + 1]),
    isRepeater: section.name.toLowerCase() === "splineattachement_repeater",
    path: v[pathIndex].trim(),
    splineIndex: Math.round(num(v[pathIndex + 2])),
    lateral: num(v[pathIndex + 3]),
    height: num(v[pathIndex + 4]),
    startDist: num(v[pathIndex + 5]),
    heading: num(v[pathIndex + 6]),
    interval: num(v[intervalIdx]),
    range: num(v[intervalIdx + 1]),
    sectionIndex,
  };
}

/**
 * [attachObj]: dítě zavěšené na rodiči. Layout (po cestě .sco, v>=10):
 *   id, parentId, instance("0"), attachIndex, heading, [v>=12: pitch, bank], labely.
 */
function deriveAttachObject(
  section: OmsiSection,
  sectionIndex: number,
  version: number
): AttachObject | null {
  const pathIndex = findPathLine(section.values, ".sco");
  if (pathIndex < 0) return null;
  const v = section.values;
  // Starší verze (v<10) adresují rodiče indexem záznamu – zatím nepodporováno.
  if (version < 10 && version !== 0) return null;
  return {
    id: toInt(v[pathIndex + 1]),
    path: v[pathIndex].trim(),
    parentId: toInt(v[pathIndex + 2]),
    attachIndex: Math.max(0, Math.round(num(v[pathIndex + 4]))),
    heading: num(v[pathIndex + 5]),
    sectionIndex,
  };
}

/** Odvodí objekty/splajny/textury ze sekcí dlaždice (sekce = zdroj pravdy). */
export function deriveTile(tile: MapTile): void {
  const objects: MapObject[] = [];
  const splines: MapSpline[] = [];
  const splineAttachments: SplineAttachment[] = [];
  const attachObjects: AttachObject[] = [];
  const groundTextures: string[] = [];
  const version = tileVersion(tile.sections);
  tile.sections.forEach((s, i) => {
    const n = s.name.toLowerCase();
    if (isObjectSection(s.name)) {
      const o = deriveObject(s, i);
      if (o) objects.push(o);
    } else if (isSplineSection(s.name)) {
      const sp = deriveSpline(s, i, version);
      if (sp) splines.push(sp);
    } else if (n === "splineattachement" || n === "splineattachement_repeater") {
      // Běžné i repeater (přes hranice dlaždic). Rozložení polí za cestou je
      // u obou identické; repeater má navíc 2 řádky PŘED cestou (index master
      // dlaždice + pořadí 1. objektu) – findPathLine je přeskočí a pro umístění
      // se nepoužívají (OMSI je bere jen pro konzistenční kontrolu).
      const a = deriveSplineAttachment(s, i, version);
      if (a) splineAttachments.push(a);
    } else if (n === "attachobj") {
      const a = deriveAttachObject(s, i, version);
      if (a) attachObjects.push(a);
    } else if (n === "groundtex") {
      for (const val of s.values) if (val.trim()) groundTextures.push(val.trim());
    }
  });
  tile.objects = objects;
  tile.splines = splines;
  tile.splineAttachments = splineAttachments;
  tile.attachObjects = attachObjects;
  tile.groundTextures = groundTextures;
}

/** Rozparsuje obsah jedné .map dlaždice do round-trip modelu. */
export function parseTile(
  text: string,
  tileX: number,
  tileY: number,
  fileName: string
): MapTile {
  const sections = parseOmsiConfig(text);
  const tile: MapTile = {
    tileX,
    tileY,
    fileName,
    sections,
    objects: [],
    splines: [],
    splineAttachments: [],
    attachObjects: [],
    groundTextures: [],
    dirty: false,
  };
  deriveTile(tile);
  return tile;
}

/** Rozparsuje global.cfg na seznam dlaždic. */
export function parseGlobalCfg(text: string): {
  name: string;
  friendlyName: string;
  tiles: { tileX: number; tileY: number; fileName: string }[];
  sections: OmsiSection[];
  groundTex: { main: string; detail: string }[];
} {
  const sections = parseOmsiConfig(text);
  const tiles: { tileX: number; tileY: number; fileName: string }[] = [];
  const groundTex: { main: string; detail: string }[] = [];
  let name = "";
  let friendlyName = "";
  for (const s of sections) {
    const n = s.name.toLowerCase();
    if (n === "name" && s.values[0]) name = s.values[0].trim();
    if (n === "friendlyname" && s.values[0]) friendlyName = s.values[0].trim();
    if (n === "groundtex") {
      // [groundtex]: main textura, detail textura, pak 3 čísla (měřítka) – jen 1./2. řádek.
      const v = s.values.map((x) => x.trim()).filter((x) => x.length > 0);
      if (v.length >= 1) groundTex.push({ main: v[0], detail: v[1] ?? "" });
    }
    if (n === "map") {
      const v = s.values.filter((l) => l.trim().length > 0);
      if (v.length >= 3) {
        tiles.push({
          tileX: Math.round(num(v[0])),
          tileY: Math.round(num(v[1])),
          fileName: v[2].trim(),
        });
      }
    }
  }
  return { name, friendlyName, tiles, sections, groundTex };
}

/** Sloučí global.cfg + obsah .map souborů do kompletního modelu. */
export function buildMap(
  rootName: string,
  globalText: string,
  tileTexts: Map<string, string>,
  rootPath = "",
  terrains?: Map<string, ArrayBuffer>,
  includeTile?: (tileX: number, tileY: number) => boolean
): OmsiMap {
  const g = parseGlobalCfg(globalText);
  const tiles: MapTile[] = [];
  for (const t of g.tiles) {
    if (includeTile && !includeTile(t.tileX, t.tileY)) continue;
    const text = tileTexts.get(t.fileName) ?? "";
    const tile = parseTile(text, t.tileX, t.tileY, t.fileName);
    const terrainBuf = terrains?.get(t.fileName);
    if (terrainBuf) {
      const terr = parseTerrain(terrainBuf);
      if (terr) tile.terrain = terr;
    }
    tiles.push(tile);
  }
  return {
    name: g.name || rootName,
    friendlyName: g.friendlyName,
    rootName,
    rootPath,
    tiles,
    globalSections: g.sections,
    groundTex: g.groundTex,
  };
}

// ---------- Serializace zpět do .map (bezeztrátově) ----------

/** Naformátuje číslo bez exponentu a bez zbytečných nul. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Serializuje dlaždici zpět na text .map (CRLF, blok mezi sekcemi). */
export function serializeTile(tile: MapTile): string {
  const parts: string[] = [];
  for (const s of tile.sections) {
    if (s.name === "__header__") {
      parts.push(s.values.join("\r\n"));
    } else {
      parts.push("[" + s.name + "]\r\n" + s.values.join("\r\n"));
    }
  }
  return parts.join("\r\n\r\n") + "\r\n";
}

// ---------- Editace ----------

type ObjField = "x" | "y" | "z" | "rotZ" | "rotX" | "rotY";

/** Nastaví jedno pole objektu a zapíše ho zpět do sekce (zdroje pravdy). */
export function setObjectField(
  tile: MapTile,
  obj: MapObject,
  field: ObjField,
  value: number
): void {
  obj[field] = value;
  const section = tile.sections[obj.sectionIndex];
  const idx = obj.pathIndex + OBJ[field];
  while (section.values.length <= idx) section.values.push("0");
  section.values[idx] = fmt(value);
  tile.dirty = true;
}

/** Smaže objekt (odebere jeho sekci) a přepočítá odvozený pohled. */
export function deleteObject(tile: MapTile, obj: MapObject): void {
  tile.sections.splice(obj.sectionIndex, 1);
  deriveTile(tile);
  tile.dirty = true;
}

/** Největší ID objektu/splajnu v celé mapě (pro přidělení nového). */
export function maxId(map: OmsiMap): number {
  let m = 0;
  for (const t of map.tiles) {
    for (const o of t.objects) if (o.id && o.id > m) m = o.id;
    for (const s of t.splines) if (s.id && s.id > m) m = s.id;
  }
  return m;
}

type SplField = "x" | "y" | "z" | "rotZ" | "length" | "radius" | "gradientStart" | "gradientEnd";
const SPL_OFF: Record<SplField, number> = {
  x: SPL.x, y: SPL.y, z: SPL.z, rotZ: SPL.rotZ,
  length: SPL.length, radius: SPL.radius,
  gradientStart: SPL.gradS, gradientEnd: SPL.gradE,
};

/** Nastaví jedno pole splajnu a zapíše ho zpět do sekce. */
export function setSplineField(
  tile: MapTile,
  spline: MapSpline,
  field: SplField,
  value: number
): void {
  spline[field] = value;
  const section = tile.sections[spline.sectionIndex];
  const idx = spline.pathIndex + SPL_OFF[field];
  while (section.values.length <= idx) section.values.push("0");
  section.values[idx] = fmt(value);
  tile.dirty = true;
}

/** Smaže spline (odebere jeho sekci) a přepočítá odvozený pohled. */
export function deleteSpline(tile: MapTile, spline: MapSpline): void {
  tile.sections.splice(spline.sectionIndex, 1);
  deriveTile(tile);
  tile.dirty = true;
}

/** Najde v mapě libovolný objekt s danou cestou (jako šablonu pro nový objekt). */
export function findTemplateObject(map: OmsiMap, path: string): { tile: MapTile; obj: MapObject } | null {
  const lp = path.toLowerCase();
  for (const t of map.tiles) {
    const obj = t.objects.find((o) => o.path.toLowerCase() === lp);
    if (obj) return { tile: t, obj };
  }
  return null;
}

/** Všechny unikátní cesty .sco použité v mapě (pro paletu). */
export function usedObjectPaths(map: OmsiMap): string[] {
  const set = new Set<string>();
  for (const t of map.tiles) for (const o of t.objects) if (o.path) set.add(o.path);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Vytvoří nový objekt na dlaždici. Pokud je k dispozici šablona (existující
 * objekt se stejnou cestou), naklonuje její sekci (zachová textury/formát),
 * jinak vytvoří minimální [object] sekci. Vrátí nový MapObject.
 */
export function createObject(
  tile: MapTile,
  path: string,
  newId: number,
  x: number,
  y: number,
  heading = 0,
  template?: OmsiSection
): MapObject {
  let section: OmsiSection;
  if (template) {
    section = { name: template.name, values: [...template.values] };
    const pi = findPathLine(section.values, ".sco");
    const base = pi >= 0 ? pi : 1;
    section.values[base] = path;
    section.values[base + OBJ.id] = String(newId);
    section.values[base + OBJ.x] = fmt(x);
    section.values[base + OBJ.y] = fmt(y);
    section.values[base + OBJ.rotZ] = fmt(heading);
  } else {
    section = {
      name: "object",
      values: ["0", path, String(newId), fmt(x), fmt(y), "0", fmt(heading), "0", "0", "0"],
    };
  }
  tile.sections.push(section);
  deriveTile(tile);
  tile.dirty = true;
  return tile.objects.find((o) => o.id === newId) ?? tile.objects[tile.objects.length - 1];
}

/** Duplikuje objekt (klon sekce) s novým ID a posunem; vrátí nový MapObject. */
export function duplicateObject(
  tile: MapTile,
  src: MapObject,
  newId: number,
  offset = 5
): MapObject {
  const srcSection = tile.sections[src.sectionIndex];
  const clone: OmsiSection = {
    name: srcSection.name,
    values: [...srcSection.values],
  };
  // nové ID a posun pozice
  clone.values[src.pathIndex + OBJ.id] = String(newId);
  clone.values[src.pathIndex + OBJ.x] = fmt(src.x + offset);
  clone.values[src.pathIndex + OBJ.y] = fmt(src.y + offset);
  // vlož hned za zdrojovou sekci
  tile.sections.splice(src.sectionIndex + 1, 0, clone);
  deriveTile(tile);
  tile.dirty = true;
  // najdi odvozený objekt s novým ID
  return (
    tile.objects.find((o) => o.id === newId) ??
    tile.objects[tile.objects.length - 1]
  );
}
