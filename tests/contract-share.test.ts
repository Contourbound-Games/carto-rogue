// Sharing a Survey Contract result (Steam edition): the Contract's name and whether this expedition
// completed it, then the usual summit / turns / explored / grade fields, with no seed and no link. The
// result is the report's (judged from the finished expedition); a plain expedition on a Contract's sheet
// shares as before. The plain share and the seed link themselves are pinned in share-input.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId } from '../src/contracts';
import { Game } from '../src/game';
import { contractReport } from '../src/hud';
import { setLang } from '../src/i18n';
import { generateMap, minCostTo } from '../src/map';
import { GAME_TITLE, PUBLIC_GAME_URL, contractShareText, shareText } from '../src/share';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, ExpeditionStats, GameState } from '../src/types';
import { ui } from '../src/ui';

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

const stats = (over: Partial<ExpeditionStats> = {}): ExpeditionStats => ({
  outcome: 'victory',
  turns: 92,
  staminaSpent: 120,
  staminaLeft: 50,
  cachesCollected: 3,
  cachesTotal: 4,
  maxElevation: 0.91,
  percentMapped: 17.43,
  elapsedMs: 12000,
  grade: 'S',
  breakdown: null,
  ...over,
});

/** The witness route that meets Gentle Ascent (U R D L per step), as proved in contracts.test.ts. */
const GENTLE_WITNESS = 'LDDDDLLLDDDDDDDDLLDLLDDDDLLLLLLLLDLLLLDLLLDRRDDDDDDDRRRRRRRRRRRRDDDDDDDDDDDLLUULLLLLLLULULLL';
const STEP: Record<string, Dir> = { U: 'up', R: 'right', D: 'down', L: 'left' };

function replay(game: Game, route: string): void {
  let now = 0;
  for (const letter of route) game.handleAction(STEP[letter], (now += 200));
  game.update(now + 5000);
}

/** The full-knowledge cheapest line: it breaks Gentle Ascent on the way up and collapses on Master Surveyor's sheet. */
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

const contractGame = (id: ContractId): Game => {
  const game = new Game(silent, generateMap, { seed: 205, now: 0 });
  expect(game.startContract(0, id)).toBe(true);
  return game;
};

/** What the SHARE button copies at the end of a Steam expedition (main.ts runButton 'share'). */
function steamShare(state: GameState): string {
  const finished = state.finalStats!;
  const contract = contractReport(state);
  return contract ? contractShareText(contract.name, contract.completed, finished) : shareText(state.seed, finished, undefined, state.mode);
}

/** The fields both shares have in common: summit, turns, explored and grade. */
const resultFieldsOf = (text: string): string[] => text.split(' | ').filter((f) => /^(Summit|Turns|Explored|Grade): /.test(f));

afterEach(() => {
  setLang('en', false);
  ui.contracts.completed = [];
});

describe('the Contract share text', () => {
  it('names the Contract and its result, then the summit, turns, survey and grade; no seed, no link', () => {
    const text = contractShareText('GENTLE ASCENT', true, stats(), 'en');
    expect(text).toBe(
      `${GAME_TITLE} | Survey Contract: GENTLE ASCENT | Contract: Completed | Summit: Conquered | Turns: 92 | Explored: 17.4% | Grade: S`,
    );
    expect(text).not.toContain(PUBLIC_GAME_URL);
    expect(text).not.toMatch(/itch\.io|https?:|#\d/);
  });

  it('a summit with the Contract broken: Not completed, the summit and its grade as they were', () => {
    expect(contractShareText('GENTLE ASCENT', false, stats({ turns: 56, percentMapped: 14.1, grade: 'B' }), 'en')).toBe(
      `${GAME_TITLE} | Survey Contract: GENTLE ASCENT | Contract: Not completed | Summit: Conquered | Turns: 56 | Explored: 14.1% | Grade: B`,
    );
  });

  it('a collapse: Not completed, the summit failed, grade F', () => {
    expect(contractShareText('MASTER SURVEYOR', false, stats({ outcome: 'defeat', turns: 57, percentMapped: 16.7, grade: 'F' }), 'en')).toBe(
      `${GAME_TITLE} | Survey Contract: MASTER SURVEYOR | Contract: Not completed | Summit: Failed | Turns: 57 | Explored: 16.7% | Grade: F`,
    );
  });

  it('in Korean, like the plain share', () => {
    expect(contractShareText('완만한 등정', true, stats(), 'ko')).toBe(
      `${GAME_TITLE} | 측량 계약: 완만한 등정 | 계약: 완료 | 정상: 정복 | 턴: 92 | 탐사: 17.4% | 등급: S`,
    );
    expect(contractShareText('측량 명인', false, stats({ outcome: 'defeat', turns: 57, percentMapped: 16.7, grade: 'F' }), 'ko')).toBe(
      `${GAME_TITLE} | 측량 계약: 측량 명인 | 계약: 미완료 | 정상: 실패 | 턴: 57 | 탐사: 16.7% | 등급: F`,
    );
  });

  it('follows the interface language when none is given, as the plain share does', () => {
    setLang('ko', false);
    expect(contractShareText('완만한 등정', false, stats())).toBe(contractShareText('완만한 등정', false, stats(), 'ko'));
  });
});

describe('the SHARE text at the end of a Steam expedition', () => {
  it('a Contract completed by its witness: Completed, with this expedition’s own summit, turns, survey and grade', () => {
    const game = contractGame('gentle-ascent');
    replay(game, GENTLE_WITNESS);
    const s = game.state;
    expect(s.phase).toBe('victory');
    const text = steamShare(s);
    expect(text).toContain('Survey Contract: GENTLE ASCENT | Contract: Completed | Summit: Conquered');
    expect(resultFieldsOf(text)).toEqual(resultFieldsOf(shareText(s.seed, s.finalStats!, 'en')));
    expect(text).not.toContain(`#${s.seed}`);
    expect(text).not.toContain(String(s.seed));
  });

  it('a summit that broke the Contract: Not completed, Summit: Conquered, the grade unchanged', () => {
    const game = contractGame('gentle-ascent');
    walkCheapestLine(game);
    const s = game.state;
    expect(s.phase).toBe('victory');
    expect(s.finalStats!.grade).not.toBe('F');
    const text = steamShare(s);
    expect(text).toContain('Contract: Not completed | Summit: Conquered');
    expect(text).toContain(`Grade: ${s.finalStats!.grade}`);
  });

  it('a collapse: Not completed, Summit: Failed, grade F', () => {
    const game = contractGame('master-surveyor');
    walkCheapestLine(game);
    const s = game.state;
    expect(s.phase).toBe('gameover');
    const text = steamShare(s);
    expect(text).toContain('Survey Contract: MASTER SURVEYOR | Contract: Not completed | Summit: Failed');
    expect(text).toContain('Grade: F');
  });

  it("is this expedition's result, whatever was completed before: a completed Contract failed again shares Not completed", () => {
    const won = contractGame('gentle-ascent');
    replay(won, GENTLE_WITNESS);
    const broken = contractGame('gentle-ascent');
    walkCheapestLine(broken);
    for (const completed of [[], ['gentle-ascent'], SURVEY_CONTRACTS.map((c) => c.id)] as ContractId[][]) {
      ui.contracts.completed = completed;
      expect(steamShare(won.state)).toContain('Contract: Completed');
      expect(steamShare(broken.state)).toContain('Contract: Not completed');
    }
  });

  it("a plain Standard expedition on a Contract's sheet shares as before: seed, link, no Contract", () => {
    const c = SURVEY_CONTRACTS.find((k) => k.id === 'gentle-ascent')!;
    const game = new Game(silent, generateMap, { seed: 205, now: 0 });
    game.startSeed(0, c.seed);
    walkCheapestLine(game);
    const s = game.state;
    expect([s.phase, s.contract]).toEqual(['victory', null]);
    const text = steamShare(s);
    expect(text).toBe(shareText(s.seed, s.finalStats!, undefined, 'standard'));
    expect(text).toContain(`${GAME_TITLE} #${c.seed}`);
    expect(text).toContain(PUBLIC_GAME_URL);
    expect(text).not.toMatch(/Survey Contract|Contract: /);
  });
});
