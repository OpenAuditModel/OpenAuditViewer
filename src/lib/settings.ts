/**
 * User preferences, all local. This module owns every localStorage key the
 * app writes, so what persists is auditable in one place — and it is only
 * ever preferences (theme, hand-arranged map positions). Event data is
 * never written anywhere.
 */

export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "openaudit-viewer.theme";
const FLOW_LAYOUT_KEY = "openaudit-viewer.flowmap-layout.v1";

/** Fired on window when the saved flow-map layout is cleared, so a mounted
 * map can drop its in-memory overrides too. */
export const FLOW_LAYOUT_CLEARED_EVENT = "openaudit-viewer:flow-layout-cleared";

export function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Stamps the preference on <html>; CSS token overrides do the rest. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset["theme"];
  } else {
    root.dataset["theme"] = preference;
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, preference);
    }
  } catch {
    // Preference simply won't survive a restart.
  }
  applyThemePreference(preference);
}

export function loadFlowLayout(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(FLOW_LAYOUT_KEY);
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Built via entries + fromEntries, never `result[name] = …`: names come
    // from untrusted log files, and an application literally named
    // "__proto__" would otherwise hit the inherited setter and silently
    // reparent the object instead of storing the position.
    const entries: [string, { x: number; y: number }][] = [];
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { x?: unknown }).x === "number" &&
        typeof (value as { y?: unknown }).y === "number"
      ) {
        entries.push([name, { x: (value as { x: number }).x, y: (value as { y: number }).y }]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveFlowLayout(layout: Record<string, { x: number; y: number }>): void {
  try {
    localStorage.setItem(FLOW_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Storage being unavailable only loses the custom layout, nothing else.
  }
}

/** Number of hand-positioned nodes in the saved layout. */
export function flowLayoutSize(): number {
  return Object.keys(loadFlowLayout()).length;
}

export function clearFlowLayout(): void {
  try {
    localStorage.removeItem(FLOW_LAYOUT_KEY);
  } catch {
    // Nothing to clear.
  }
  window.dispatchEvent(new Event(FLOW_LAYOUT_CLEARED_EVENT));
}
