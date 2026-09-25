// Seed links and Wordle-style result summaries, plus a clipboard helper that also works in
// embedded iframes where the async Clipboard API is blocked.
import { t } from './i18n';
import type { Lang } from './i18n';
import type { ExpeditionStats } from './types';

export const GAME_TITLE = 'The Carto-Rogue: 등고선 탐사대';

/** `base` with its query string replaced by ?seed=<seed> (the hash is dropped). */
export function seedUrl(base: string, seed: number): string {
  try {
    const url = new URL(base);
    url.search = '';
    url.hash = '';
    url.searchParams.set('seed', String(seed));
    return url.toString();
  } catch {
    const bare = base.split(/[?#]/)[0];
    return `${bare}?seed=${seed}`;
  }
}

/** "The Carto-Rogue: 등고선 탐사대 #721405 | Summit: Conquered | Turns: 67 | Explored: 15.5% | Grade: S | <url>" */
export function shareText(seed: number, stats: ExpeditionStats, url: string, lang?: Lang): string {
  const summit = stats.outcome === 'victory' ? t('shareConquered', undefined, lang) : t('shareFailed', undefined, lang);
  const explored = `${(Math.round(Math.max(0, Math.min(100, stats.percentMapped)) * 10) / 10).toFixed(1)}%`;
  return [
    `${GAME_TITLE} #${seed}`,
    `${t('shareSummit', undefined, lang)}: ${summit}`,
    `${t('shareTurns', undefined, lang)}: ${stats.turns}`,
    `${t('shareExplored', undefined, lang)}: ${explored}`,
    `${t('shareGrade', undefined, lang)}: ${stats.grade}`,
    url,
  ].join(' | ');
}

/** The page URL to share: the current location (outside the browser, a placeholder origin). */
export function currentPageUrl(): string {
  return typeof location !== 'undefined' ? location.href : 'https://localhost/';
}

/** Hidden-textarea fallback; must run inside a user gesture. */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  const canvas = document.getElementById('game');
  if (canvas instanceof HTMLElement) canvas.focus({ preventScroll: true });
  return ok;
}

/** Copy `text` to the clipboard. Call from a pointer / key handler. Resolves to success. */
export async function copyText(text: string): Promise<boolean> {
  // The synchronous fallback goes first while the gesture is fresh; embedded players (itch.io)
  // often deny the async API through the iframe's permissions policy.
  if (execCommandCopy(text)) return true;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to failure.
  }
  return false;
}
