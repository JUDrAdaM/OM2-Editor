/**
 * Asynchronní pomůcky pro řízené zpracování velkého množství práce.
 *
 * Hlavní motiv: velké mapy (Berlin-Spandau ~889 unikátních modelů, každý čte
 * desítky souborů) nesmí spustit desetitisíce souběžných čtení najednou -
 * to přetíží I/O (fetch/IPC) a vyčerpá paměť. Proto běží omezený „pool"
 * pracovníků (bounded worker pool), který načítá postupně s hlášením postupu.
 */

/**
 * Zpracuje `items` funkcí `worker` s nejvýše `limit` souběžnými operacemi.
 * Výsledky se vrací ve stejném pořadí jako vstup. `onProgress(done, total)`
 * se volá po každé dokončené položce. `shouldCancel()` umožní předčasné
 * ukončení (vrátí se dosud spočítané výsledky, zbytek zůstane `undefined`).
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<R[]> {
  const total = items.length;
  const results: R[] = new Array(total);
  if (total === 0) return results;
  const n = Math.max(1, Math.min(limit, total));
  let next = 0;
  let done = 0;

  async function runner(): Promise<void> {
    while (true) {
      if (shouldCancel?.()) return;
      const i = next++;
      if (i >= total) return;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        // chybu necháme na workerovi; zde jen neshodíme celý pool
      }
      done++;
      onProgress?.(done, total);
    }
  }

  const runners: Promise<void>[] = [];
  for (let k = 0; k < n; k++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

/** Spustí callback v dalším „idle" okně prohlížeče (fallback na setTimeout). */
export function onIdle(cb: () => void, timeout = 200): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (ric) ric(cb, { timeout });
  else setTimeout(cb, 0);
}
