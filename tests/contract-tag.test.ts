// The Survey Contract tag on the HUD (Steam edition): during a Contract the Contract's name, and only its
// name, sits in the Explorer tag's place under the cartouche. It is the run's identity, never its
// progress: it is built from the Contract's id alone, so it reads the same however the conditions stand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { judgeContract } from '../src/contract-conditions';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId } from '../src/contracts';
import { Game } from '../src/game';
import { RUN_TAG_MAX_W, contractLines, contractTagText, runTagBox } from '../src/hud';
import { setLang, t } from '../src/i18n';
import { generateMap, minCostTo } from '../src/map';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine } from '../src/types';

const silent: AudioEngine = {
  muted: false,
  unlock: () => undefined,
  toggleMute: () => false,
  footstep: () => undefined,
  bump: () => undefined,
  cacheCollected: () => undefined,
  discovery: () => undefined,
  lowStamina: () => undefined,
  victory: () => undefined,
  defeat: () => undefined,
  expeditionStart: () => undefined,
  stopAll: () => undefined,
};

/** The full-knowledge cheapest line: it breaks Gentle Ascent and Hold the High Ground on the way up. */
function walkCheapestLine(game: Game): void {
  const map = game.state.map;
  const to = minCostTo(map, map.summit.x, map.summit.y);
  let now = 0;
  for (let k = 0; k < 500 && game.state.phase === 'playing'; k++) {
    const { x, y } = game.state.player;
    const dir = DIR_LIST.find((d) => {
      const c = stepCost(map, x, y, d);
      return c !== null && to[tileIndex(x + DIRS[d].dx, y + DIRS[d].dy)] + c === to[tileIndex(x, y)];
    });
    if (!dir) break;
    game.handleAction(dir, (now += 200));
  }
  game.update(now + 5000);
}

/** The tag the HUD shows for this expedition in the Steam edition (hud.ts drawHud), or null. */
const tagOf = (game: Game): string | null => (game.state.contract !== null ? contractTagText(game.state.contract) : null);

const NAMES: Record<'en' | 'ko', Record<ContractId, string>> = {
  en: { 'gentle-ascent': 'GENTLE ASCENT', 'hold-the-high-ground': 'HOLD THE HIGH GROUND', 'master-surveyor': 'MASTER SURVEYOR' },
  ko: { 'gentle-ascent': '완만한 등정', 'hold-the-high-ground': '고지 사수', 'master-surveyor': '측량 명인' },
};

afterEach(() => setLang('en', false));

describe('the Survey Contract tag', () => {
  it.each(['en', 'ko'] as const)('%s: is exactly the Contract name, with no prefix, status or number', (lang) => {
    setLang(lang, false);
    for (const c of SURVEY_CONTRACTS) {
      const text = contractTagText(c.id);
      expect(text).toBe(NAMES[lang][c.id]);
      expect(text).toBe(contractLines(c.id)[0]);
    }
  });

  it.each(['en', 'ko'] as const)('%s: sits in the Explorer tag place, clear of the cartouche rivets', (lang) => {
    setLang(lang, false);
    const explorer = runTagBox(t('modeExplorer'));
    for (const c of SURVEY_CONTRACTS) {
      const box = runTagBox(contractTagText(c.id));
      expect(box.w, c.id).toBeLessThanOrEqual(RUN_TAG_MAX_W);
      // Same row and height as the Explorer tag, centred on the same axis.
      expect([box.y, box.h], c.id).toEqual([explorer.y, explorer.h]);
      expect(Math.abs(box.x + box.w / 2 - (explorer.x + explorer.w / 2)), c.id).toBeLessThanOrEqual(1);
    }
  });

  it('is built from the Contract id alone, never from how the expedition stands', () => {
    const src = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'src/hud.ts'), 'utf8');
    const body = (name: string): string => {
      const start = src.indexOf(`function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const end = src.slice(start).search(/\r?\n\}\r?\n/);
      expect(end, name).toBeGreaterThan(0);
      return src.slice(start, start + end);
    };
    for (const name of ['contractTagText', 'drawContractTag']) {
      expect(body(name), name).not.toMatch(/judgeContract|evaluateContract|trail|stepCosts|maxElevation|elevation|finalStats|completed|progress/);
    }
  });

  it('reads the same before and after a condition breaks, keeps through Retry, and goes on New Expedition', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0 });
    expect(tagOf(game)).toBeNull(); // the title card's sheet: no Contract
    game.startContract(0, 'gentle-ascent');
    const tag = tagOf(game);
    expect(tag).toBe('GENTLE ASCENT');
    walkCheapestLine(game); // takes steep steps: the Contract is broken, the summit reached
    expect(game.state.phase).toBe('victory');
    // Precondition: this expedition really did break its Contract.
    const evaluation = judgeContract(game.state);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.status).toBe('broken');
    expect(evaluation!.conditions.some((r) => r.status === 'broken')).toBe(true);
    expect(tagOf(game)).toBe(tag);
    game.retrySheet(60_000);
    expect(tagOf(game)).toBe(tag);
    game.handleAction('restart', 70_000); // R / New Expedition: a plain expedition
    expect(tagOf(game)).toBeNull();
  });

  it("a Contract's sheet started as a plain seed carries no tag", () => {
    const c = SURVEY_CONTRACTS.find((k) => k.id === 'hold-the-high-ground')!;
    const game = new Game(silent, generateMap, { seed: 205, now: 0 });
    game.startSeed(0, c.seed);
    // The Contract's own mountain, played as a plain seed, is no Contract: no identity, so no tag.
    expect(game.state.seed).toBe(c.seed);
    expect(game.state.contract).toBeNull();
    expect(tagOf(game)).toBeNull();
    const explorer = new Game(silent, generateMap, { seed: 205, now: 0, mode: 'explorer' });
    expect(explorer.startContract(0, c.id)).toBe(false);
    expect(tagOf(explorer)).toBeNull();
  });
});
