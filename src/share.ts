// Seed and result summaries for sharing, plus a clipboard helper that also works in embedded
// iframes where the async Clipboard API is blocked.
import { t } from './i18n';
import type { Lang } from './i18n';
import type { ExpeditionMode, ExpeditionStats } from './types';

export const GAME_TITLE = 'The Carto-Rogue: 등고선 탐사대';

/**
 * The public game page every share points to. The game itself runs inside itch.io's iframe on
 * an internal host (html-classic.itch.zone), whose address must never be handed out.
 */
export const PUBLIC_GAME_URL = 'https://carto-studio.itch.io/the-carto-rogue';

/** "The Carto-Rogue: 등고선 탐사대 #721405 | https://carto-studio.itch.io/the-carto-rogue" */
export function seedText(seed: number): string {
  return `${GAME_TITLE} #${seed} | ${PUBLIC_GAME_URL}`;
}

/**
 * "The Carto-Rogue: 등고선 탐사대 #721405 | Summit: Conquered | Turns: 67 | Explored: 15.5% | Grade: S | <public url>"
 * An Explorer result says so before the grade ("... | Mode: EXPLORER | Grade: S | ..."); a Standard one is unchanged.
 */
export function shareText(seed: number, stats: ExpeditionStats, lang?: Lang, mode: ExpeditionMode = 'standard'): string {
  const summit = stats.outcome === 'victory' ? t('shareConquered', undefined, lang) : t('shareFailed', undefined, lang);
  const explored = `${(Math.round(Math.max(0, Math.min(100, stats.percentMapped)) * 10) / 10).toFixed(1)}%`;
  return [
    `${GAME_TITLE} #${seed}`,
    `${t('shareSummit', undefined, lang)}: ${summit}`,
    `${t('shareTurns', undefined, lang)}: ${stats.turns}`,
    `${t('shareExplored', undefined, lang)}: ${explored}`,
    ...(mode === 'explorer' ? [`${t('shareMode', undefined, lang)}: ${t('modeExplorer', undefined, lang)}`] : []),
    `${t('shareGrade', undefined, lang)}: ${stats.grade}`,
    PUBLIC_GAME_URL,
  ].join(' | ');
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
