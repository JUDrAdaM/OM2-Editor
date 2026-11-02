export interface GraphicsSettings {
  /** Render resolution as a multiplier of the display's device pixel ratio. */
  renderScale: number;
  /** Maximum concurrent asset reads/parses. */
  assetConcurrency: number;
  /** Distance at which detailed splines replace overview LOD. */
  splineDetailDistance: number;
}

export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = {
  renderScale: 1,
  assetConcurrency: 12,
  splineDetailDistance: 3000,
};

const STORAGE_KEY = "om2.graphics.v1";
export const GRAPHICS_SETTINGS_EVENT = "om2:graphics-settings-changed";

export function getGraphicsSettings(): GraphicsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<GraphicsSettings> : {};
    return {
      renderScale: clamp(value.renderScale, 0.5, 2, DEFAULT_GRAPHICS_SETTINGS.renderScale),
      assetConcurrency: Math.round(clamp(value.assetConcurrency, 4, 48, DEFAULT_GRAPHICS_SETTINGS.assetConcurrency)),
      splineDetailDistance: Math.round(clamp(value.splineDetailDistance, 1000, 8000, DEFAULT_GRAPHICS_SETTINGS.splineDetailDistance)),
    };
  } catch {
    return { ...DEFAULT_GRAPHICS_SETTINGS };
  }
}

export function setGraphicsSettings(settings: GraphicsSettings): void {
  const clean: GraphicsSettings = {
    renderScale: clamp(settings.renderScale, 0.5, 2, DEFAULT_GRAPHICS_SETTINGS.renderScale),
    assetConcurrency: Math.round(clamp(settings.assetConcurrency, 4, 48, DEFAULT_GRAPHICS_SETTINGS.assetConcurrency)),
    splineDetailDistance: Math.round(clamp(settings.splineDetailDistance, 1000, 8000, DEFAULT_GRAPHICS_SETTINGS.splineDetailDistance)),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* private browsing */ }
  window.dispatchEvent(new CustomEvent<GraphicsSettings>(GRAPHICS_SETTINGS_EVENT, { detail: clean }));
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
