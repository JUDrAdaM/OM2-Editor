import { parseOmsiConfig } from "./parser";

/** Mód průhlednosti materiálu z [matl_alpha]. 0 = neprůhledný, 1 = alpha-test
 *  (ostré hrany – stromy, ploty, sítě), 2 = alpha-blend (sklo, poloprůhledné). */
export type AlphaMode = 0 | 1 | 2;

/** Jeden materiál ze .sco: přepis textury pro daný index materiálu v meshi. */
export interface ScoMatl {
  /** Textura (soubor). */
  texture: string;
  /** Index materiálu v meshi (0-based), na který se přepis vztahuje. */
  matlIndex: number;
  /** Mód průhlednosti. */
  alpha: AlphaMode;
  /** Samostatná transparentní mapa ([matl_transmap]), pokud je. */
  transmap?: string;
}

/** Jeden mesh ze .sco s přiřazenými materiály (a LOD úrovní). */
export interface ScoMesh {
  file: string;
  matls: ScoMatl[];
  /** Hodnota [LOD] platná pro tento mesh (Infinity = plný detail / bez LOD). */
  lod: number;
  /** Posun originu [x,y,z] (origin_trans). */
  originTrans: [number, number, number];
  /** Rotace originu kolem svislé osy (origin_rot_y), stupně. */
  originRotY: number;
}

/** Strom/billboard ([tree]): alfa textura + rozměr. */
export interface ScoTree {
  texture: string;
  /** Šířka a výška billboardu (metry). */
  width: number;
  height: number;
}

export interface ScoInfo {
  /** Meshe pro nejvyšší detail (nejvyšší LOD). */
  meshes: ScoMesh[];
  /** Billboard stromy ([tree]); pokud je neprázdné, objekt se kreslí jako billboard. */
  trees: ScoTree[];
  /** Absolutní výška: [absheight] NEBO objekt má [path] (křižovatky, výhybky, kusy
   *  silnic). Takový objekt se umisťuje na svoji z (bez přičtení terénu) – viz OMSI. */
  absHeight: boolean;
  /** Body [new_attachment] (pro [attachObj]): každý je seznam operací attach_trans /
   *  attach_rot_x/y/z v pořadí, jak stojí v souboru. */
  attachments: { op: string; vals: number[] }[][];
}

/**
 * Rozparsuje .sco. Sleduje aktuální mesh: [mesh] zahájí nový mesh, následné
 * [matl]/[matl_alpha]/[matl_transmap] patří tomu meshi. [LOD] nastaví LOD
 * hodnotu pro následující meshe. origin_* řádky uvnitř animačních sekcí se
 * přiřadí poslednímu meshi.
 */
export function parseSco(text: string): ScoInfo {
  const sections = parseOmsiConfig(text);
  const all: ScoMesh[] = [];
  const trees: ScoTree[] = [];
  let currentLod = Infinity;
  let cur: ScoMesh | null = null;
  let absHeight = false;
  const attachments: { op: string; vals: number[] }[][] = [];
  let curAttach: { op: string; vals: number[] }[] | null = null;
  const ATTACH_ARGS: Record<string, number> = {
    attach_trans: 3, attach_rot_x: 1, attach_rot_y: 1, attach_rot_z: 1,
  };

  const firstVal = (s: { values: string[] }) => s.values.find((v) => v.trim().length > 0)?.trim();

  for (const s of sections) {
    const n = s.name.toLowerCase();
    if (n === "new_attachment") {
      curAttach = [];
      attachments.push(curAttach);
    }
    if (n === "absheight" || n === "path") {
      absHeight = true;
    } else if (n === "lod") {
      const v = firstVal(s);
      currentLod = v != null ? (parseFloat(v) || 0) : Infinity;
    } else if (n === "mesh") {
      const file = firstVal(s);
      if (file) {
        cur = { file, matls: [], lod: currentLod, originTrans: [0, 0, 0], originRotY: 0 };
        all.push(cur);
      }
    } else if (n === "matl" && cur) {
      // 1. řádek = textura, 2. řádek = index materiálu
      const vals = s.values.map((v) => v.trim()).filter((v) => v.length > 0);
      const texture = vals[0] ?? "";
      const matlIndex = vals[1] != null ? parseInt(vals[1], 10) || 0 : cur.matls.length;
      if (texture) cur.matls.push({ texture, matlIndex, alpha: 0 });
    } else if (n === "matl_alpha" && cur && cur.matls.length) {
      const v = firstVal(s);
      const mode = v != null ? (parseInt(v, 10) as AlphaMode) : 1;
      cur.matls[cur.matls.length - 1].alpha = (mode === 1 || mode === 2) ? mode : 1;
    } else if (n === "tree") {
      // [tree]: textura, minVýška, maxVýška, minPoměr(š/v), maxPoměr. Reálný strom
      // má navíc ŠABLONU s placeholdery ({texture}, {minheight}…), kterou OMSI
      // ignoruje – jinak by vznikl zelený fallback billboard „navíc".
      const vals = s.values.map((v) => v.trim()).filter((v) => v.length > 0);
      const tex = vals[0];
      if (tex && !tex.includes("{")) {
        const minH = parseFloat(vals[1]), maxH = parseFloat(vals[2]);
        const minR = parseFloat(vals[3]), maxR = parseFloat(vals[4]);
        const height = Number.isFinite(minH) && Number.isFinite(maxH) ? (minH + maxH) / 2 : (parseFloat(vals[2]) || parseFloat(vals[1]) || 14);
        const ratio = Number.isFinite(minR) && Number.isFinite(maxR) ? (minR + maxR) / 2 : 1;
        trees.push({ texture: tex, width: height * (ratio > 0 ? ratio : 1), height });
      }
    } else if (n === "matl_transmap" && cur && cur.matls.length) {
      const vals = s.values.map((v) => v.trim()).filter((v) => v.length > 0);
      const last = cur.matls[cur.matls.length - 1];
      if (vals[0]) last.transmap = vals[0];
      if (last.alpha === 0) last.alpha = 1;
    }

    // origin_rot_y / origin_trans jsou řádky uvnitř (často animačních) sekcí
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i].trim().toLowerCase();
      if (!cur) continue;
      if (v === "origin_rot_y" && s.values[i + 1]) cur.originRotY = parseFloat(s.values[i + 1]) || 0;
      if (v === "origin_trans" && s.values[i + 1]) {
        const parts = s.values[i + 1].trim().split(/\s+/).map(Number);
        if (parts.length >= 3) cur.originTrans = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
      }
    }

    // attach_trans / attach_rot_* řádky patří poslednímu [new_attachment] (i napříč
    // sekcemi – OMSI je čte jako celé řádky kdekoliv za ním).
    if (curAttach) {
      for (let i = 0; i < s.values.length; i++) {
        const tok = s.values[i].trim().toLowerCase();
        const argc = ATTACH_ARGS[tok];
        if (!argc) continue;
        const vals: number[] = [];
        for (let a = 1; a <= argc; a++) vals.push(parseFloat((s.values[i + a] || "0").replace(",", ".")) || 0);
        curAttach.push({ op: tok, vals });
        i += argc;
      }
    }
  }

  if (all.length === 0) return { meshes: [], trees, absHeight, attachments };

  // Vyber nejvyšší detail: skupina meshů s nejvyšší LOD hodnotou.
  // (Bez [LOD] mají všechny Infinity → vezmou se všechny.)
  let maxLod = -Infinity;
  for (const m of all) if (m.lod > maxLod) maxLod = m.lod;
  const meshes = all.filter((m) => m.lod === maxLod);
  return { meshes, trees, absHeight, attachments };
}
