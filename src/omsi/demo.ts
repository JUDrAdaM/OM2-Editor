import type { OmsiMap, MapTile } from "./types";
import { parseTile } from "./map";

// Syntetická demo mapa - generuje reálný .map text a parsuje ho stejným
// pipeline jako skutečná mapa, takže funguje i editace a serializace.

function demoTileText(tileX: number, tileY: number): string {
  const seed = ((tileX * 73856093) ^ (tileY * 19349663)) >>> 0;
  const rng = mulberry32(seed);
  const lines: string[] = ["Demo tile created by OMSI 2 Map Editor", ""];

  const count = 12 + Math.floor(rng() * 10);
  let id = (Math.abs(tileX) * 100 + Math.abs(tileY) * 10) * 50 + 1;
  for (let i = 0; i < count; i++) {
    lines.push(
      "[object]", "0", "Sceneryobjects\\demo\\budova.sco",
      String(id++),
      (rng() * 300).toFixed(3), // X
      (rng() * 300).toFixed(3), // Y
      "0",                      // Z
      (rng() * 360).toFixed(2), // heading
      "0", "0", "",             // rotX, rotY, (prázdný konec)
      ""
    );
  }

  // Jeden rovný spline přes dlaždici
  lines.push(
    "[spline]", "0", "Splines\\demo\\silnice.sli",
    String(id++),
    "0", "0",   // prevId, nextId
    "0",        // X
    "0",        // Z (výška)
    "150",      // Y
    "0",        // heading
    "300",      // délka
    "0",        // poloměr
    "0", "0",   // sklon start/end
    ""
  );

  return lines.join("\r\n");
}

function demoTile(tileX: number, tileY: number): MapTile {
  return parseTile(demoTileText(tileX, tileY), tileX, tileY, `demo_${tileX}_${tileY}.map`);
}

export function createDemoMap(): OmsiMap {
  const tiles: MapTile[] = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      tiles.push(demoTile(x, y));
    }
  }
  return {
    name: "demo",
    friendlyName: "Ukázková mapa (demo)",
    rootName: "demo",
    rootPath: "",
    tiles,
    globalSections: [],
    groundTex: [],
  };
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
