// The expedition mode chosen on the title card, remembered between sessions like the language.
import type { ExpeditionMode } from './types';

export const MODE_STORAGE_KEY = 'carto-rogue:mode';

export function isMode(value: unknown): value is ExpeditionMode {
  return value === 'standard' || value === 'explorer';
}

/** The saved mode, else Standard. */
export function loadMode(): ExpeditionMode {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    return isMode(saved) ? saved : 'standard';
  } catch {
    return 'standard';
  }
}

export function saveMode(mode: ExpeditionMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Blocked storage: the choice lasts for this session only.
  }
}
