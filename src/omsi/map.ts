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
  // layout (index splajnu, příčný offset, interval podél silnice) - parsovat je jako
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
 * 3. koncové číslo (při 1-2 je to 1.; při 0 je 0). map_chain_offset = tex_offset,
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
 * 2 řádky PŘED cestou (master tile idx, pořadí 1. objektu) - ty findPathLine
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
  // Starší verze (v<10) adresují rodiče indexem záznamu - zatím nepodporováno.
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
      // dlaždice + pořadí 1. objektu) - findPathLine je přeskočí a pro umístění
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
      // [groundtex]: main textura, detail textura, pak 3 čísla (měřítka) - jen 1./2. řádek.
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
  includeTile?: (tileX: number, tileY: number) => boolean,
  maxTiles = 0
): OmsiMap {
  const g = parseGlobalCfg(globalText);
  const totalTiles = g.tiles.length;

  // Výběr dlaždic k načtení. Explicitní `includeTile` má přednost. Jinak u
  // velkých map (více než `maxTiles`) vezmeme jen shluk kolem středu - renderovat
  // stovky dlaždic najednou (600+, 3000+ objektů) jinak přetíží GPU/paměť a
  // aplikace spadne. Ukládání je bezpečné: zapisují se jen změněné dlaždice a
  // global.cfg se nepřepisuje, takže nenačtené dlaždice zůstanou beze změny.
  let selected = g.tiles;
  if (!includeTile && maxTiles > 0 && g.tiles.length > maxTiles) {
    const cx = g.tiles.reduce((a, t) => a + t.tileX, 0) / g.tiles.length;
    const cy = g.tiles.reduce((a, t) => a + t.tileY, 0) / g.tiles.length;
    selected = [...g.tiles]
      .sort((a, b) =>
        ((a.tileX - cx) ** 2 + (a.tileY - cy) ** 2) -
        ((b.tileX - cx) ** 2 + (b.tileY - cy) ** 2))
      .slice(0, maxTiles);
  }

  const tiles: MapTile[] = [];
  for (const t of selected) {
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
    totalTiles,
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

/** Serializuje sekce zpět na text OMSI configu (CRLF, blok mezi sekcemi). */
function serializeSections(sections: OmsiSection[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    if (s.name === "__header__") {
      parts.push(s.values.join("\r\n"));
    } else {
      parts.push("[" + s.name + "]\r\n" + s.values.join("\r\n"));
    }
  }
  return parts.join("\r\n\r\n") + "\r\n";
}

/** Serializuje dlaždici zpět na text .map (CRLF, blok mezi sekcemi). */
export function serializeTile(tile: MapTile): string {
  return serializeSections(tile.sections);
}

/** Serializuje global.cfg (globalSections) zpět na text (CRLF). */
export function serializeGlobalCfg(sections: OmsiSection[]): string {
  return serializeSections(sections);
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

/**
 * Nastaví výšku/poměr stromového přepisu ve [object] (per-instance velikost -
 * jediné „měřítko", které OMSI u objektů ukládá). Přepíše první dvě číselné
 * hodnoty v override bloku (count na pathIndex+8, pak count řádků). Vrací true,
 * když blok existuje a má ≥2 čísla; jinak false (běžný objekt / repaint bez čísel).
 */
export function setTreeOverride(
  tile: MapTile,
  obj: MapObject,
  height: number,
  ratio: number
): boolean {
  const section = tile.sections[obj.sectionIndex];
  const v = section.values;
  const pi = obj.pathIndex;
  const count = parseInt((v[pi + 8] ?? "0").trim(), 10);
  if (!Number.isFinite(count) || count <= 0) return false;
  const numIdx: number[] = [];
  for (let k = 1; k <= count && pi + 8 + k < v.length; k++) {
    const t = (v[pi + 8 + k] ?? "").trim();
    if (t && !Number.isNaN(Number(t.replace(",", ".")))) numIdx.push(pi + 8 + k);
    if (numIdx.length >= 2) break;
  }
  if (numIdx.length < 2) return false;
  v[numIdx[0]] = fmt(height);
  v[numIdx[1]] = fmt(ratio);
  obj.treeHeight = height;
  obj.treeRatio = ratio;
  tile.dirty = true;
  return true;
}

/** Všechny unikátní cesty .sli použité v mapě (pro paletu stavby silnic). */
export function usedSplinePaths(map: OmsiMap): string[] {
  const set = new Set<string>();
  for (const t of map.tiles) for (const s of t.splines) if (s.path) set.add(s.path);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Najde libovolný spline s danou cestou (šablona pro nový spline - formát/cant). */
export function findTemplateSpline(map: OmsiMap, path: string): OmsiSection | null {
  const lp = path.toLowerCase();
  for (const t of map.tiles) {
    const sp = t.splines.find((s) => s.path.toLowerCase() === lp);
    if (sp) return t.sections[sp.sectionIndex];
  }
  return null;
}

/**
 * Vytvoří nový spline (segment silnice/koleje) na dlaždici. Když je k dispozici
 * šablona (existující spline téže cesty), naklonuje její sekci (zachová formát),
 * jinak vytvoří minimální [spline]. Vrátí nový MapSpline.
 */
export function createSpline(
  tile: MapTile,
  path: string,
  newId: number,
  x: number, y: number, z: number,
  heading: number, length: number, radius: number,
  prevId = 0, nextId = 0,
  template?: OmsiSection
): MapSpline {
  let section: OmsiSection;
  if (template) {
    section = { name: template.name, values: [...template.values] };
    const pi = findPathLine(section.values, ".sli");
    const base = pi >= 0 ? pi : 1;
    const set = (off: number, val: string) => {
      while (section.values.length <= base + off) section.values.push("0");
      section.values[base + off] = val;
    };
    set(0, path);
    set(SPL.id, String(newId));
    set(SPL.prevId, String(prevId));
    set(SPL.nextId, String(nextId));
    set(SPL.x, fmt(x)); set(SPL.z, fmt(z)); set(SPL.y, fmt(y));
    set(SPL.rotZ, fmt(heading)); set(SPL.length, fmt(length)); set(SPL.radius, fmt(radius));
  } else {
    section = {
      name: "spline",
      values: ["0", path, String(newId), String(prevId), String(nextId),
        fmt(x), fmt(z), fmt(y), fmt(heading), fmt(length), fmt(radius), "0", "0"],
    };
  }
  tile.sections.push(section);
  deriveTile(tile);
  tile.dirty = true;
  return tile.splines.find((s) => s.id === newId) ?? tile.splines[tile.splines.length - 1];
}

/** Prázdná (plochá) výškmapa dané velikosti a výšky. */
function flatTerrain(size: number, height: number): { size: number; heights: Float32Array } {
  const heights = new Float32Array(size * size);
  heights.fill(height);
  return { size, heights };
}

/** Navrhne souřadnice volné dlaždice vedle stávající mapy (vpravo, pak další). */
export function suggestNewTileCoords(map: OmsiMap): { tileX: number; tileY: number } {
  if (map.tiles.length === 0) return { tileX: 0, tileY: 0 };
  const used = new Set(map.tiles.map((t) => `${t.tileX},${t.tileY}`));
  let maxX = -Infinity, minY = Infinity;
  for (const t of map.tiles) { maxX = Math.max(maxX, t.tileX); minY = Math.min(minY, t.tileY); }
  for (let y = minY; y < minY + 64; y++) {
    const key = `${maxX + 1},${y}`;
    if (!used.has(key)) return { tileX: maxX + 1, tileY: y };
  }
  return { tileX: maxX + 1, tileY: minY };
}

/**
 * Přidá novou (prázdnou, plochou) dlaždici do mapy. Strukturu sekcí (hlavička,
 * verze, groundtex...) naklonuje z existující dlaždice, aby formát přesně seděl;
 * vyhodí jen obsah (objekty/splajny). Terén je plochý ve výšce `baseHeight`.
 * Dlaždice se označí `isNew` -> při uložení se zapíše .map/.terrain a doplní
 * záznam [map] do global.cfg. Vrátí index nové dlaždice.
 */
export function createTile(map: OmsiMap, tileX: number, tileY: number, baseHeight?: number): number {
  const template = map.tiles[0];
  const CONTENT = new Set([
    "object", "spline", "spline_h", "splineattachement",
    "splineattachement_repeater", "attachobj",
  ]);
  const sections: OmsiSection[] = template
    ? template.sections
        .filter((s) => !CONTENT.has(s.name.toLowerCase()))
        .map((s) => ({ name: s.name, values: [...s.values] }))
    : // Prázdná dlaždice bez vzoru (nová mapa): kostra přesně jako .map z OMSI-Editoru
      // (ověřeno na Grundorf/tile_0_0.map) - hlavička, [version] 14 a prázdné
      // terénní sekce. Bez nich OMSI dlaždici nenačte.
      [
        { name: "__header__", values: ["File created with OM2-Editor"] },
        { name: "version", values: ["14"] },
        { name: "terrain", values: [] },
        { name: "variable_terrainlightmap", values: [] },
        { name: "variable_terrain", values: [] },
      ];

  // Unikátní jméno souboru dlaždice.
  const existing = new Set(map.tiles.map((t) => t.fileName.toLowerCase()));
  let fileName = `tile_${tileX}_${tileY}.map`;
  let n = 1;
  while (existing.has(fileName.toLowerCase())) fileName = `tile_${tileX}_${tileY}_${n++}.map`;

  // Výchozí výška: zadaná, jinak průměr terénu vzoru, jinak 0.
  let h = baseHeight ?? 0;
  if (baseHeight == null && template?.terrain) {
    const hs = template.terrain.heights;
    let sum = 0; for (let i = 0; i < hs.length; i++) sum += hs[i] as number;
    h = hs.length ? sum / hs.length : 0;
  }
  const size = template?.terrain?.size ?? 61;

  const tile: MapTile = {
    tileX, tileY, fileName, sections,
    objects: [], splines: [], splineAttachments: [], attachObjects: [],
    groundTextures: [],
    terrain: flatTerrain(size, h),
    dirty: true,
    isNew: true,
  };
  deriveTile(tile);
  map.tiles.push(tile);

  // Doplň záznam [map] do in-memory global sekcí (konzistence + budoucí zápis).
  map.globalSections.push({ name: "map", values: [String(tileX), String(tileY), fileName] });

  return map.tiles.length - 1;
}

/** Nastaví nextId existujícího splajnu (pro řetězení nových segmentů). */
export function setSplineNext(tile: MapTile, spline: MapSpline, nextId: number): void {
  spline.nextId = nextId;
  const section = tile.sections[spline.sectionIndex];
  const idx = spline.pathIndex + SPL.nextId;
  while (section.values.length <= idx) section.values.push("0");
  section.values[idx] = String(nextId);
  tile.dirty = true;
}

// ---------- Nová mapa + editace global.cfg ----------

/** Výchozí základní textura terénu (tráva) - existuje v každé instalaci OMSI 2. */
export const DEFAULT_GROUND_MAIN = "texture\\gras.bmp";
export const DEFAULT_GROUND_DETAIL = "texture\\gras_det.bmp";

export interface NewMapOptions {
  /** Interní název mapy (sekce [name]); obvykle = název složky. */
  name: string;
  /** Přívětivý název zobrazený v OMSI (sekce [friendlyname]). */
  friendlyName: string;
  /** Popis mapy (sekce [description]); volitelné. */
  description?: string;
  /** Základní / detailní textura terénu (sekce [groundtex]). */
  groundMain?: string;
  groundDetail?: string;
}

/**
 * Vytvoří zcela novou prázdnou mapu v paměti: kompletní global.cfg sekce
 * (hlavička, [name]/[friendlyname]/[description], [version] 14, [NextIDCode],
 * [groundtex]) a jednu prázdnou plochou dlaždici [0,0]. Výsledek je připraven
 * k zápisu na disk (serializeGlobalCfg + serializeTile) a k otevření v editoru.
 */
export function createNewMap(opts: NewMapOptions): OmsiMap {
  const name = opts.name.trim() || "NovaMapa";
  const friendly = opts.friendlyName.trim() || name;
  const groundMain = (opts.groundMain || DEFAULT_GROUND_MAIN).trim();
  const groundDetail = (opts.groundDetail || DEFAULT_GROUND_DETAIL).trim();
  const descLines = (opts.description ?? "").length
    ? (opts.description as string).split(/\r?\n/)
    : [];

  const globalSections: OmsiSection[] = [
    { name: "__header__", values: ["File created with OM2-Editor"] },
    { name: "name", values: [name] },
    { name: "friendlyname", values: [friendly] },
    { name: "description", values: descLines },
    { name: "end", values: [] },
    { name: "version", values: ["14"] },
    { name: "NextIDCode", values: ["1"] },
    { name: "groundtex", values: [groundMain, groundDetail, "0", "1", "60"] },
  ];

  const map: OmsiMap = {
    name,
    friendlyName: friendly,
    rootName: name,
    rootPath: "",
    tiles: [],
    totalTiles: 0,
    globalSections,
    groundTex: [{ main: groundMain, detail: groundDetail }],
  };

  // Jedna výchozí plochá dlaždice [0,0]. createTile doplní záznam [map] do
  // globalSections a vytvoří kostru .map (bez vzoru -> OMSI tile skeleton).
  createTile(map, 0, 0, 0);
  map.totalTiles = map.tiles.length;
  return map;
}

/** Index první sekce daného jména (case-insensitive), nebo -1. */
function sectionIndex(sections: OmsiSection[], name: string): number {
  const n = name.toLowerCase();
  return sections.findIndex((s) => s.name.toLowerCase() === n);
}

/** Nastaví přívětivý název mapy ([friendlyname]); sekci v případě potřeby vytvoří. */
export function setFriendlyName(map: OmsiMap, value: string): void {
  const secs = map.globalSections;
  const i = sectionIndex(secs, "friendlyname");
  if (i >= 0) {
    secs[i].values = [value];
  } else {
    const after = sectionIndex(secs, "name");
    secs.splice(after >= 0 ? after + 1 : 0, 0, { name: "friendlyname", values: [value] });
  }
  map.friendlyName = value;
}

/** Nastaví interní název mapy ([name]). */
export function setMapName(map: OmsiMap, value: string): void {
  const secs = map.globalSections;
  const i = sectionIndex(secs, "name");
  if (i >= 0) secs[i].values = [value];
  else secs.unshift({ name: "name", values: [value] });
  map.name = value;
}

/** Vrátí popis mapy ([description]) jako víceřádkový text. */
export function getDescription(map: OmsiMap): string {
  const i = sectionIndex(map.globalSections, "description");
  return i >= 0 ? map.globalSections[i].values.join("\n") : "";
}

/** Nastaví popis mapy ([description] + následné [end]); sekci vytvoří/doplní. */
export function setDescription(map: OmsiMap, text: string): void {
  const secs = map.globalSections;
  const lines = text.length ? text.split(/\r?\n/) : [];
  const i = sectionIndex(secs, "description");
  if (i >= 0) {
    secs[i].values = lines;
    // OMSI uzavírá popis sekcí [end]; zajisti, že hned následuje.
    if (!(secs[i + 1] && secs[i + 1].name.toLowerCase() === "end")) {
      secs.splice(i + 1, 0, { name: "end", values: [] });
    }
  } else {
    let at = sectionIndex(secs, "version");
    if (at < 0) at = sectionIndex(secs, "friendlyname");
    at = at >= 0 ? at + (sectionIndex(secs, "version") >= 0 ? 0 : 1) : secs.length;
    secs.splice(at, 0, { name: "description", values: lines }, { name: "end", values: [] });
  }
}

/** Jedna položka palety terénních textur z global.cfg ([groundtex]). */
export interface GroundTexEntry {
  main: string;
  detail: string;
  /** 3 koncová čísla sekce (měřítka/index); zachováváme je beze změny. */
  nums: string[];
}

/** Vyčte paletu [groundtex] z global.cfg (pořadí = index; 0 = základní textura). */
export function getGroundTexEntries(map: OmsiMap): GroundTexEntry[] {
  const out: GroundTexEntry[] = [];
  for (const s of map.globalSections) {
    if (s.name.toLowerCase() !== "groundtex") continue;
    const v = s.values.map((x) => x.trim());
    out.push({
      main: v[0] ?? "",
      detail: v[1] ?? "",
      nums: v.slice(2).filter((x) => x.length > 0),
    });
  }
  return out;
}

/**
 * Přepíše celou paletu [groundtex] v global.cfg zadaným seznamem (pořadí = index).
 * Odstraní stávající [groundtex] sekce a vloží nové před první [map] záznam
 * (ostatní sekce zůstanou beze změny). Aktualizuje i odvozené `map.groundTex`.
 */
export function setGroundTexEntries(map: OmsiMap, entries: GroundTexEntry[]): void {
  const secs = map.globalSections;
  for (let i = secs.length - 1; i >= 0; i--) {
    if (secs[i].name.toLowerCase() === "groundtex") secs.splice(i, 1);
  }
  const newSecs: OmsiSection[] = entries
    .filter((e) => e.main.trim())
    .map((e) => ({
      name: "groundtex",
      values: [e.main.trim(), e.detail.trim(), ...(e.nums.length ? e.nums : ["0", "1", "60"])],
    }));
  let at = sectionIndex(secs, "map");
  if (at < 0) at = secs.length;
  secs.splice(at, 0, ...newSecs);
  map.groundTex = newSecs.map((s) => ({ main: s.values[0], detail: s.values[1] ?? "" }));
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
