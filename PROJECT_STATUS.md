# OMSI 2 Map Editor — Stav projektu a plán

Shrnutí celé dosavadní práce a seznam toho, co zbývá. Slouží k pokračování
(klidně i v nové session — obsahuje i reverse-engineering formátů OMSI, aby se
ta znalost neztratila).

---

## 1. Cíl projektu

Vlastní **3D desktop editor map pro OMSI 2** — má dělat to co vestavěný OMSI
editor, ale **přehledněji, modernějším UI a plně funkčně samostatně** (standalone
desktop appka). Má reálně načíst celou mapu tak, jak je (skutečné modely a
textury), a umožnit tvorbu plnohodnotné mapy.

Referenční vzhled vestavěného OMSI editoru: pravý panel se záložkami (Tile,
Objects, Splines, Terrain, Chrono, Traffic Rules…), modrá obloha, status lišta
s pozicí kurzoru a číslem dlaždice.

---

## 2. Kde to je / jak spustit

- Složka projektu: `C:\Users\adamd\Desktop\omsi 2 editor`
- Stack: **Vite + TypeScript + Three.js** (renderer), **Electron** (desktop obal).

```bash
npm install
npm run electron:dev     # desktop okno (Electron) + dev server
# nebo jen web/náhled:
OMSI_ROOT="D:/steam app/steamapps/common/OMSI 2" npm run dev   # http://localhost:5180
```

Skripty: `dev`, `electron:dev`, `build`, `dist` (NSIS+portable), `dist:dir`.

Testovací data: uživatel má **OMSI 2 na `D:\steam app\steamapps\common\OMSI 2`**,
mapy: **Grundorf** (19 dlaždic, malá – hlavní testovací), Berlin-Spandau (329),
Lisen (678).

Dev náhled reálné mapy: `http://localhost:5180/?map=/grundorf.json`
(JSON se generuje bundlem přes esbuild z reálné Grundorf; middleware `/omsi/`
servíruje soubory OMSI instalace pro načítání modelů/textur v prohlížeči).

---

## 3. Architektura

```
electron/
  main.cjs        Hlavní proces: okno, nativní dialog, čtení/zápis .map,
                  čtení assetů (modely/textury) z kořene OMSI (IPC)
  preload.cjs     Bezpečný most → window.omsiAPI (openMapFolder, saveTiles, readAsset)
src/
  omsi/
    parser.ts     Tokenizer OMSI .cfg/.map/.sco (sekce [name] + hodnoty)
    types.ts      Datový model (dlaždice, objekty, splajny, terén)
    map.ts        global.cfg + .map → model; ZDROJ PRAVDY = sekce; serializace zpět;
                  editační helpery (setObjectField, setSplineField, create/delete/duplicate)
    terrain.ts    Parser binární výškmapy *.terrain + bilineární výška
    o3d.ts        Parser binárního meshe .o3d (vertexy, trojúhelníky, UV, materiály)
    sco.ts        Parser scenery objektu .sco (mesh/textury/origin)
    demo.ts       Syntetická demo mapa
  fs/loader.ts    Načtení/uložení mapy (Electron IPC / File System Access API),
                  BOM-aware dekód, UTF-16 enkód, createAssetSource()
  viewport/
    viewport.ts   Three.js scéna: terén, objekty (reálné modely instancované +
                  box fallback), splajny, výběr/tažení/editace, umisťování
    models.ts     ModelCache + loadModel: .sco→.o3d geometrie + textury (DDS/TGA/BMP/PNG)
  ui/app.ts       Layout, toolbar, paleta, strom, inspektor, ukládání, zkratky
  style.css       Tmavé UI
```

**Round-trip princip:** zdrojem pravdy je pole `sections` každé dlaždice (přesné
sekce .map v původním pořadí). Objekty/splajny jsou „pohled" s odkazem zpět
(sectionIndex, pathIndex). Uložení je proto bezeztrátové — zachová UTF-16,
strukturu i neinterpretovaná pole (textury, názvy, animace…).

---

## 4. HOTOVO (ověřeno na reálné mapě Grundorf)

- **Načtení reálné mapy** (global.cfg + všechny .map dlaždice).
- **Terén** z binární `*.terrain` výškmapy, vykreslený meshem; objekty i splajny
  sedí na terénu (výška bilineárně interpolovaná).
- **Reálné 3D modely objektů** — parser binárního `.o3d` (ověřeno na stovkách
  modelů, 100 %), `.sco`, **multimateriálové textury** (`.dds` DXT, `.tga`,
  `.bmp`, `.png`) s automatickým prohozením přípony; instancing per `.sco`.
  Fallback box pro modely, co nejdou načíst (např. `.x`-only).
- **Editace objektů:** výběr (klik/strom), posun tažením po terénu, rotace
  (tlačítka + R/Shift+R), přesné hodnoty v inspektoru, duplikace (Ctrl+D, nové
  ID), mazání (Del).
- **Paleta objektů:** seznam použitých `.sco` + vlastní cesta → umístění klikem
  na terén (nové unikátní ID, formát převzatý ze šablony).
- **Editace splajnů:** výběr kliknutím (raycast), posun, úprava
  azimutu/délky/poloměru, mazání. Zobrazení řetězení prev/next.
- **Bezeztrátové ukládání** změněných dlaždic zpět do `.map` (UTF-16LE + CRLF +
  zachování struktury). Dirty indikátor, Ctrl+S.
- **Desktop appka** (Electron okno, nativní dialog výběru složky, IPC).
- Moderní tmavé UI: toolbar, boční panel (paleta + strom dlaždic/objektů),
  inspektor, status lišta, orbit kamera.

---

## 5. Reverse-engineering formátů OMSI (klíčové, ověřené znalosti)

### Kódování
- `global.cfg`, `.map`, `.terrain`-sousedící texty: **UTF-16LE** (BOM `FF FE`).
- `.sco`: **ANSI / UTF-8** (bez BOM). → dekodér řeší podle BOM.
- Zápis: UTF-16LE s BOM, CRLF.

### global.cfg
- `[map]` = `tileX`, `tileY`, `fileNameOfTile.map`.
- Dále [name], [friendlyname], [groundtex] (textura, detail, 3 čísla), [mapcam],
  [NextIDCode] (další volné ID), [addseason]…

### .map dlaždice — pořadí polí (ověřeno na Grundorfu)
- `[object]`: `flag, PATH(.sco), id, X, Y, Z, heading°, rotX, rotY, [texCount, textury…], název`
  - X,Y = lokální pozice na dlaždici 0..300 m; heading = rotace kolem svislé osy.
- `[spline]`: `flag, PATH(.sli), id, prevId, nextId, X, Z(výška), Y, heading°, délka, poloměr, sklonStart, sklonEnd`
  - prevId/nextId = řetězení; poloměr 0 = rovný; délka ≤300 m (segmentováno).
- Dlaždice OMSI = **300×300 m**.

### *.terrain (výškmapa) — binární
- Velikost pro Grundorf **14888 B** = `int32 hlavička (=60, počet dílků)` +
  **61×61 float32 výšek** (metry), row-major. Rozteč = 300/60 = **5 m**.
- POZN.: tento soubor obsahuje **jen výšky**. Ground-layer textury (malování
  povrchu) jsou uloženy JINDE — zatím neprozkoumáno (viz TODO terén).

### .sco (scenery objekt) — text (ANSI)
- `[mesh]` → soubor meshe (často `.x`, ale na disku je zkompilovaný `.o3d`).
- `[matl]` → textura (+ index); `[matl_alpha]`/`[matl_transmap]` → průhlednost.
- `origin_trans`, `origin_rot_y` → posun/rotace originu (uvnitř anim. sekcí).
- POZOR: **mnoho objektů (budovy) nemá `[matl]`** — textury jsou v materiálovém
  chunku `.o3d` (viz níže).

### .o3d (binární mesh) — ověřeno na stovkách souborů (100 %)
- `0x84`, flags, pak chunky s tagem:
  - **`0x17` vertices**: count (uint16, u velkých uint32 — detekuje se adaptivně),
    pak count × 32 B = 3 float pozice + 3 float normála + 2 float UV.
  - **`0x49` triangles**: `uint32 count`, pak count × trojúhelník:
    `3× index + uint16 materiál`. Index = **uint16** (8 B stride) nebo
    **uint32** u velkých meshů (14 B stride) — detekuje se podle platnosti indexů.
  - **`0x54` materials**: barvy + **název textury** (string). Z tohoto chunku
    bereme textury objektů bez `[matl]`.
- Osy: mesh je **Z-nahoru** → v editoru přemapováno na Y-nahoru `(x, z, -y)`.
  Normály OMSI nejsou po přemapování spolehlivé → `computeVertexNormals()`.

### Textury
- `.dds` (DXT1/3/5 — DDSLoader), `.tga` (TGALoader), `.bmp/.png/.jpg` (Image).
- Hledají se ve složce objektu: `<scoDir>/texture/`, `<scoDir>/`.
- OMSI v configu často uvádí `.bmp`, na disku je `.dds` → zkoušíme varianty přípon.
- Meshe (.o3d) bývají v podsložce `<scoDir>/model/`.
- Kořen OMSI se odvodí z cesty mapy (`…\OMSI 2\maps\<mapa>` → `…\OMSI 2`).

---

## 6. ZBÝVÁ UDĚLAT (roadmapa k plné paritě + lépe)

### A. Editace terénu (nejvýraznější chybějící funkce — rozpracováno)
- [ ] **Zjistit, kde OMSI ukládá ground-layer textury** (malování povrchu) —
      v `.terrain` jsou jen výšky. Prověřit: další soubory u dlaždice, nebo
      splat/alpha mapy, nebo data v `.map`.
- [ ] **Výškový štětec**: zvednout / snížit / nastavit výšku, velikost štětce,
      síla; úprava mřížky 61×61 a živý re-mesh terénu.
- [ ] **Zarovnání terénu na objekty/splajny** (jako „Align Terrain").
- [ ] **Malování ground-layer textur** (Ground Layers: přidat/upravit/smazat
      vrstvu, štětec „Paint/Rubber on Layer").
- [ ] **Zápis zpět do binárního `.terrain`** (výšky; a cokoli pro vrstvy).

### B. Plné vlastnosti objektů a splajnů
- [ ] **Pitch/Bank** u objektů (rotX/rotY už se čtou — přidat do inspektoru a
      aplikovat na model).
- [ ] **Attach to Object / to Spline** (přichycení, offset podél splajnu).
- [ ] **Align to terrain** u objektu (dorovnat Z na terén).
- [ ] **Kreslení nových splajnů** (silnic) — klikání bodů, napojení prev/next,
      poloměr/délka, výběr typu `.sli`.
- [ ] **Paleta i pro splajny** (seznam `.sli`, náhled).
- [ ] **Aktualizace `[NextIDCode]`** v global.cfg při přidání objektu/splajnu
      (teď se jen bere maxId+1, ale global.cfg se neupravuje).

### C. Správa dlaždic a mapy
- [ ] **Přidat/odebrat dlaždici** (+ zápis do global.cfg).
- [ ] **Vytvořit novou mapu** (prázdná global.cfg + dlaždice + .terrain).
- [ ] Číslo dlaždice a pozice kurzoru ve status liště.

### D. App-shell / UX (plnohodnotná standalone appka)
- [ ] **Úvodní stránka s projekty** (poslední mapy, otevřít, nová mapa).
- [ ] **Menu Soubor** (Otevřít / Uložit / Uložit jako / Nová / Zavřít).
- [ ] **Nastavení** (cesta k OMSI, ovládání, vzhled, výkon…).
- [ ] Modrá obloha / volitelný vzhled scény blíž OMSI (volitelně).

### E. Vizuální doladění
- [ ] **Alpha textury stromů/plotů** (billboardy — teď šedé; zprovoznit
      průhlednost `.tga/.dds` s alfou + správné `matl_alpha`).
- [ ] Správné UV/flip u některých textur, případně per-materiál alpha.
- [ ] Načíst i `.x` meshe (objekty bez `.o3d`) — teď fallback box (~37/110 u
      Grundorfu). Nebo je ignorovat, pokud existuje `.o3d` varianta.

### F. Distribuce
- [ ] **Autoupdate** (electron-updater).
- [ ] **Dát projekt na GitHub** (repo + Releases pro autoupdate).
- [ ] **Zabalit standalone instalačku** (`npm run dist` — NSIS + portable),
      ošetřit chyby balení.

---

## 7. Známá omezení / drobnosti
- Dev náhled `?map=/grundorf.json` používá předpřipravený JSON (bez IPC); reálné
  modely se v něm načítají přes `/omsi/` middleware. `public/grundorf.json` je
  v `.gitignore`.
- Během tažení objektu se reálný model překreslí až po puštění (hýbe se jen
  rámeček výběru) — kvůli výkonu (plný rebuild na pointerup).
- Editace terénu, přidávání splajnů a správa dlaždic zatím chybí (viz roadmapa).
