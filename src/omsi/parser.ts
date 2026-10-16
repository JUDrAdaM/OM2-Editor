import type { OmsiSection } from "./types";

/**
 * Generický tokenizer OMSI konfiguračních souborů (.cfg, .map, .sco, .sli).
 *
 * Formát je jednoduchý: řádky `[nazev]` uvozují sekci, následující řádky až
 * do další `[...]` jsou její hodnoty (každá na vlastním řádku). Prázdné řádky
 * se uvnitř sekce zachovávají jen jako oddělovače a ořezávají se z okrajů.
 *
 * Tolerance je záměr: nikdy neházíme chybu kvůli neznámé sekci, jen ji
 * vrátíme tak, jak je. Interpretaci dělají až vyšší vrstvy (map.ts).
 */
export function parseOmsiConfig(text: string): OmsiSection[] {
  // OMSI soubory bývají v CP-1252; čtení řeší loader. Tady jen normalizujeme konce řádků.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const sections: OmsiSection[] = [];
  let current: OmsiSection | null = null;
  // Řádky před první sekcí (hlavička/verze) uložíme do pseudosekce "__header__".
  let header: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.trim().match(/^\[([^\]]+)\]$/);

    if (sectionMatch) {
      if (current) sections.push(trimTrailingBlanks(current));
      // Původní velikost písmen zachováváme kvůli věrnému uložení; porovnává se case-insensitive.
      current = { name: sectionMatch[1].trim(), values: [] };
      continue;
    }

    if (!current) {
      if (line.trim().length > 0) header.push(line);
      continue;
    }
    current.values.push(line);
  }

  if (current) sections.push(trimTrailingBlanks(current));
  if (header.length > 0) {
    sections.unshift({ name: "__header__", values: header });
  }
  return sections;
}

function trimTrailingBlanks(section: OmsiSection): OmsiSection {
  const values = [...section.values];
  while (values.length > 0 && values[values.length - 1].trim() === "") {
    values.pop();
  }
  return { ...section, values };
}

/** Pohodlné: vrátí hodnoty první sekce daného jména (case-insensitive). */
export function firstSection(
  sections: OmsiSection[],
  name: string
): OmsiSection | undefined {
  const n = name.toLowerCase();
  return sections.find((s) => s.name.toLowerCase() === n);
}

/** Bezpečný převod na číslo (OMSI občas míchá tečku/čárku a bílé znaky). */
export function num(value: string | undefined, fallback = 0): number {
  if (value == null) return fallback;
  const parsed = parseFloat(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}
