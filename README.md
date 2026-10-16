# OMSI 2 Map Editor

Moderní 3D editor map pro **OMSI 2** – desktop aplikace (Electron + Vite + TypeScript + Three.js).
Cíl: přehledné a vymakané UI, výrazně lepší UX než vestavěný editor OMSI 2.

> Stav: **funkční editor s reálnými modely.** Načtení reálné mapy, 3D náhled
> s **terénem** (výškmapa z `*.terrain`) a **skutečnými modely objektů**
> (parser binárního `.o3d` + multimateriálové textury z `.dds/.tga/.bmp`),
> výběr, posun tažením, rotace, mazání, duplikace, paleta pro přidávání objektů
> a bezeztrátové ukládání zpět do `.map` (UTF-16LE).

## Vykreslení reálných objektů

Editor čte skutečné 3D modely OMSI:
- **`.o3d`** – binární mesh (vertexy, trojúhelníky, UV, index materiálu).
  Parser je adaptivní (krátké/dlouhé indexy), ověřeno na stovkách modelů.
- **`.sco`** – scenery objekt: odkaz na mesh(e), textury a origin.
- **Textury** – `.dds` (DXT), `.tga`, `.bmp`, `.png`; název z `.o3d` materiálu
  nebo z `[matl]` v `.sco`, s automatickým prohozením přípony (OMSI mívá
  v configu `.bmp`, na disku `.dds`).
- Soubory se čtou z kořene OMSI (odvozeno z cesty mapy) – v Electronu nativně,
  v dev náhledu přes `/omsi/` middleware (`OMSI_ROOT`).
- Objekty se stejným `.sco` se **instancují** (výkon).

## Editace

- **Výběr** – klikni na objekt (box) nebo na spline (silnici) ve scéně, nebo na
  objekt ve stromu vlevo.
- **Posun** – táhni vybraný objekt/spline myší po zemi (během tahu se vypne
  otáčení kamery).
- **Rotace** – tlačítka ⟲/⟳ v inspektoru, nebo klávesy `R` / `Shift+R`.
- **Přesné hodnoty** – edituj pozici/rotaci (objekt) nebo start/azimut/délku/
  poloměr (spline) přímo v polích inspektoru.
- **Přidání objektu** – v **paletě** vlevo klikni na typ (seznam použitých `.sco`)
  nebo zadej vlastní cestu k `.sco`, pak klikni na terén. Nový objekt dostane
  unikátní ID; formát se převezme ze stejného objektu v mapě, pokud existuje.
- **Duplikace** – tlačítko *Duplikovat* nebo `Ctrl+D`.
- **Mazání** – tlačítko *Smazat* nebo `Delete` (objekt i spline).
- **Zrušení** – `Esc` zruší umisťovací režim.
- **Uložení** – tlačítko *Uložit* nebo `Ctrl+S`; uloží jen změněné dlaždice
  zpět do `.map` v původním kódování (UTF-16LE) a struktuře. Neinterpretovaná
  pole (textury, názvy…) zůstávají beze změny.

## Spuštění

```bash
npm install
npm run electron:dev   # desktop okno (Electron) + dev server (hot reload)
```

Další skripty:

| Skript | Co dělá |
|---|---|
| `npm run dev` | jen Vite dev server (otevřít v prohlížeči na http://localhost:5180) |
| `npm run electron:dev` | Vite + nativní Electron okno |
| `npm run build` | typecheck + produkční build rendereru do `dist/` |
| `npm run dist` | zabalí desktop instalačku (NSIS) + portable do `release/` |
| `npm run dist:dir` | rozbalená appka bez instalačky (rychlé ověření) |

DevTools v dev režimu: spusť s `OMSI_DEVTOOLS=1`.

## Jak otevřít reálnou mapu

1. V appce klikni **Otevřít mapu…**
2. Vyber složku mapy OMSI 2 – tu, která obsahuje `global.cfg`
   (typicky `…\OMSI 2\maps\<nazev_mapy>\`).

Editor přečte `global.cfg` (seznam dlaždic) a všechny `*.map` soubory.

## Architektura

```
electron/
  main.cjs        Hlavní proces: okno, nativní dialog, čtení složky mapy (fs)
  preload.cjs     Bezpečný most (contextBridge) → window.omsiAPI
src/
  omsi/
    parser.ts     Generický tokenizer OMSI .cfg/.map (sekce [name] + hodnoty)
    map.ts        Interpretace global.cfg + .map → datový model
    terrain.ts    Parser binární výškmapy *.terrain + interpolace výšky
    types.ts      Datový model (dlaždice, objekty, splajny, terén)
    demo.ts       Syntetická demo mapa pro náhled bez reálných dat
  fs/loader.ts    Načtení složky (Electron nativně / File System Access API)
  viewport/
    viewport.ts   Three.js scéna: dlaždice, objekty (instanced), splajny, výběr
  ui/app.ts       Layout, toolbar, strom dlaždic/objektů, inspektor
  style.css       Tmavé UI
```

## Poznámka k formátu OMSI

Formát `.map`/`.sco`/`.sli` není oficiálně zdokumentovaný – pořadí polí vychází
z komunitního reverse-engineeringu. Parser je proto **tolerantní**: u objektů a
splajnů si drží i syrové řádky (`raw`), aby se žádná data neztratila a mapování
polí se dalo doladit podle reálné mapy. Výškmapa terénu (`*.terrain`) je binární
a bude řešena samostatně.
