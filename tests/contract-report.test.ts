// The Survey Contract band of the expedition report (Steam edition): which Contract, whether this
// expedition completed it, and each condition met or broken, judged afresh from the finished expedition
// by judgeContract (never from the saved progress). A collapse shows the summit not reached and only the
// conditions it had already broken. Report choice: a Contract left not completed starts on Retry.
// The judging itself is proved in contracts.test.ts; this checks what the report makes of it.
import { afterEach, describe, expect, it } from 'vitest';
import { VISION_HIGH_MIN } from '../src/config';
import { judgeContract } from '../src/contract-conditions';
import type { ConditionResult, ContractCondition, ContractEvaluation } from '../src/contract-conditions';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId } from '../src/contracts';
import { measureText } from '../src/font';
import { Game } from '../src/game';
import {
  CONTRACT_BAND,
  CONTRACT_BAND_H,
  conditionLabel,
  contractLines,
  contractReport,
  contractReportView,
  contractStamp,
  reportCardHeight,
} from '../src/hud';
import { contractText, setLang } from '../src/i18n';
import { GENERATOR_VERSION, generateMap, minCostTo } from '../src/map';
import { stepCost, tileIndex, toMeters } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, ExpeditionMode } from '../src/types';
import { reportFor, ui } from '../src/ui';
import { mapDigest } from './support/fingerprint';

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

const NO_STEEP: ContractCondition = { kind: 'maxSteepSteps', max: 0 };
const HOLD: ContractCondition = { kind: 'holdSightLine', line: 'high' };

/** One route that meets each Contract (U R D L per step), as proved in contracts.test.ts. */
const WITNESS: Record<ContractId, string> = {
  'gentle-ascent': 'LDDDDLLLDDDDDDDDLLDLLDDDDLLLLLLLLDLLLLDLLLDRRDDDDDDDRRRRRRRRRRRRDDDDDDDDDDDLLUULLLLLLLULULLL',
  'hold-the-high-ground': 'RRRRRRDDRRRUDDRRRURRRRRRURRRURRDRRRRRRDRRRU',
  'master-surveyor': 'URRRRRRRRRURRRRULUUUURRUUUUUURRRRRRRRRURRRDDDDDDRRDDRRRRRRRRRRRUUURRUUUUUUUL',
};
const STEP: Record<string, Dir> = { U: 'up', R: 'right', D: 'down', L: 'left' };

function replay(game: Game, route: string): void {
  let now = 0;
  for (const letter of route) game.handleAction(STEP[letter], (now += 200));
  game.update(now + 5000);
}

/** The full-knowledge cheapest line to the summit (it breaks Gentle Ascent and Hold the High Ground). */
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

/** Pace back and forth beside the spawn until the surveyor collapses. */
function paceToCollapse(game: Game): void {
  const s = game.state;
  const out = DIR_LIST.find((d) => stepCost(s.map, s.player.x, s.player.y, d) !== null) as Dir;
  const back = DIR_LIST.find((d) => DIRS[d].dx === -DIRS[out].dx && DIRS[d].dy === -DIRS[out].dy) as Dir;
  let now = 0;
  for (let k = 0; k < 400 && game.state.phase === 'playing'; k++) game.handleAction(k % 2 === 0 ? out : back, (now += 200));
  game.update(now + 5000);
}

const contractGame = (id: ContractId): Game => {
  const game = new Game(silent, generateMap, { seed: 205, now: 0 });
  expect(game.startContract(0, id)).toBe(true);
  return game;
};
const plainGame = (seed: number, mode: ExpeditionMode = 'standard'): Game => {
  const game = new Game(silent, generateMap, { seed: 205, now: 0, mode });
  game.startSeed(0, seed);
  return game;
};
const definition = (id: ContractId) => SURVEY_CONTRACTS.find((c) => c.id === id)!;

const result = (condition: ContractCondition, status: ConditionResult['status'], brokenOnTurn: number | null = null): ConditionResult => ({
  condition,
  status,
  value: status === 'broken' ? 3 : 0,
  brokenOnTurn,
});
const judged = (status: ContractEvaluation['status'], summit: boolean, conditions: ConditionResult[]): ContractEvaluation => ({
  status,
  summit,
  conditions,
});

const SUMMIT = 'REACH THE TRIG PILLAR';
const STEEP = 'NO STEEP UPHILL STEP';
const LINE = 'HOLD THE 840 M LINE';

afterEach(() => {
  setLang('en', false);
  ui.contracts.completed = [];
});

describe('the Contract band (report view)', () => {
  // Every shape a finished Contract expedition can take, as judgeContract reports it.
  const cases: [string, ContractId, ContractEvaluation, boolean, [string, string][]][] = [
    ['Gentle Ascent completed', 'gentle-ascent', judged('met', true, [result(NO_STEEP, 'met')]), true,
      [[SUMMIT, 'met'], [STEEP, 'met']]],
    ['Gentle Ascent broken on the way to the summit', 'gentle-ascent', judged('broken', true, [result(NO_STEEP, 'broken', 23)]), false,
      [[SUMMIT, 'met'], [STEEP, 'broken']]],
    ['Hold the High Ground completed', 'hold-the-high-ground', judged('met', true, [result(HOLD, 'met')]), true,
      [[SUMMIT, 'met'], [LINE, 'met']]],
    ['Hold the High Ground broken on the way to the summit', 'hold-the-high-ground', judged('broken', true, [result(HOLD, 'broken', 31)]), false,
      [[SUMMIT, 'met'], [LINE, 'broken']]],
    ['Master Surveyor completed', 'master-surveyor', judged('met', true, [result(NO_STEEP, 'met'), result(HOLD, 'met')]), true,
      [[SUMMIT, 'met'], [STEEP, 'met'], [LINE, 'met']]],
    ['Master Surveyor with one condition broken', 'master-surveyor', judged('broken', true, [result(NO_STEEP, 'met'), result(HOLD, 'broken', 57)]), false,
      [[SUMMIT, 'met'], [STEEP, 'met'], [LINE, 'broken']]],
    ['a collapse with a condition already broken: the open one is left out', 'master-surveyor',
      judged('broken', false, [result(NO_STEEP, 'broken', 12), result(HOLD, 'open')]), false,
      [[SUMMIT, 'notReached'], [STEEP, 'broken']]],
    ['a collapse with nothing broken: only the summit', 'master-surveyor', judged('broken', false, [result(NO_STEEP, 'open'), result(HOLD, 'open')]), false,
      [[SUMMIT, 'notReached']]],
  ];

  it.each(cases)('%s', (_name, id, evaluation, completed, rows) => {
    const view = contractReportView(id, evaluation);
    expect(view.name).toBe(contractLines(id)[0]);
    expect(view.completed).toBe(completed);
    expect(view.rows.map((r) => [r.label, r.status])).toEqual(rows);
    // A row is its label and status only: no turn, count or step number reaches the report.
    for (const row of view.rows) expect(Object.keys(row).sort()).toEqual(['label', 'status']);
    const turns = evaluation.conditions.map((r) => r.brokenOnTurn).filter((n) => n !== null);
    for (const n of turns) expect(JSON.stringify(view)).not.toContain(String(n));
  });

  it('labels each condition by its kind, the sight line from the sheet itself', () => {
    expect(conditionLabel(NO_STEEP)).toBe(STEEP);
    expect(conditionLabel(HOLD)).toBe(`HOLD THE ${toMeters(VISION_HIGH_MIN)} M LINE`);
    expect(conditionLabel(HOLD)).toBe(LINE);
    setLang('ko', false);
    expect(conditionLabel(NO_STEEP)).toBe('가파른 오르막 걸음 없이');
    expect(conditionLabel(HOLD)).toBe('840 M 선 지키기');
    // "No steep uphill step" is what every approved steep-step condition asks (none allowed).
    for (const c of SURVEY_CONTRACTS) {
      for (const k of c.conditions) if (k.kind === 'maxSteepSteps') expect(k.max, c.id).toBe(0);
    }
  });

  it('shows the result in words, never FAILED', () => {
    expect(contractStamp(true).text).toBe('CONTRACT COMPLETED');
    expect(contractStamp(false).text).toBe('NOT COMPLETED');
    setLang('ko', false);
    expect([contractStamp(true).text, contractStamp(false).text]).toEqual(['계약 완료', '계약 미완료']);
  });
});

describe('the Contract band of a finished expedition', () => {
  it.each(SURVEY_CONTRACTS)('$id completed by its witness: CONTRACT COMPLETED, every row met', (c) => {
    const game = contractGame(c.id);
    replay(game, WITNESS[c.id]);
    expect(game.state.phase).toBe('victory');
    const view = contractReport(game.state);
    expect(view?.completed).toBe(true);
    expect(view?.rows.every((r) => r.status === 'met')).toBe(true);
    expect(view?.rows).toHaveLength(1 + c.conditions.length);
  });

  it.each(['gentle-ascent', 'hold-the-high-ground'] as const)('%s reached the summit by breaking it: a victory, NOT COMPLETED', (id) => {
    const game = contractGame(id);
    walkCheapestLine(game);
    expect(game.state.phase).toBe('victory');
    expect(game.state.finalStats?.grade).not.toBe('F');
    const view = contractReport(game.state);
    expect(view?.completed).toBe(false);
    expect(view?.rows.map((r) => r.status)).toEqual(['met', 'broken']);
  });

  it('a collapse: NOT COMPLETED, the summit not reached, a line never reached is left out', () => {
    const game = contractGame('hold-the-high-ground');
    paceToCollapse(game);
    expect(game.state.phase).toBe('gameover');
    expect(judgeContract(game.state)?.conditions.map((r) => r.status)).toEqual(['open']);
    const view = contractReport(game.state);
    expect(view).toMatchObject({ completed: false, rows: [{ label: SUMMIT, status: 'notReached' }] });
  });

  it('a collapse after a broken condition shows that condition and leaves the open one out', () => {
    // On Master Surveyor's sheet the cheapest line climbs steeply early on and runs out of stamina
    // before the summit, never having crossed the 840 m line: steep broken, the line still open.
    const game = contractGame('master-surveyor');
    walkCheapestLine(game);
    expect(game.state.phase).toBe('gameover');
    const evaluation = judgeContract(game.state);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.status).toBe('broken');
    expect(evaluation!.summit).toBe(false);
    const broken = evaluation!.conditions.filter((r) => r.status === 'broken').map((r) => conditionLabel(r.condition));
    const open = evaluation!.conditions.filter((r) => r.status === 'open').map((r) => conditionLabel(r.condition));
    // Preconditions: this collapse really has a broken condition and an open one.
    expect(broken.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    expect([broken, open]).toEqual([[STEEP], [LINE]]);

    const view = contractReport(game.state)!;
    expect(view.completed).toBe(false);
    expect(view.rows[0]).toEqual({ label: SUMMIT, status: 'notReached' });
    expect(view.rows.slice(1)).toEqual(broken.map((label) => ({ label, status: 'broken' })));
    for (const label of open) expect(view.rows.map((r) => r.label)).not.toContain(label);
  });

  it("comes from this expedition alone, whatever the saved progress or the title card's completions say", () => {
    const met = contractGame('hold-the-high-ground');
    replay(met, WITNESS['hold-the-high-ground']);
    const broken = contractGame('gentle-ascent');
    walkCheapestLine(broken);
    const before = [contractReport(met.state), contractReport(broken.state)];
    for (const completed of [[], ['gentle-ascent'], ['hold-the-high-ground', 'gentle-ascent', 'master-surveyor']] as ContractId[][]) {
      ui.contracts.completed = completed;
      expect([contractReport(met.state), contractReport(broken.state)]).toEqual(before);
    }
    expect(before.map((v) => v?.completed)).toEqual([true, false]);
  });

  it('is never there for a plain expedition: Standard, Explorer, or a Contract sheet started as a plain seed', () => {
    const c = definition('gentle-ascent');
    const won = plainGame(c.seed);
    walkCheapestLine(won);
    const explorer = plainGame(c.seed, 'explorer');
    walkCheapestLine(explorer);
    const collapsed = plainGame(205);
    paceToCollapse(collapsed);
    expect([won.state.phase, explorer.state.phase, collapsed.state.phase]).toEqual(['victory', 'victory', 'gameover']);
    for (const g of [won, explorer, collapsed]) {
      expect(g.state.contract).toBeNull();
      expect(contractReport(g.state)).toBeNull();
      expect(reportCardHeight(440, contractReport(g.state))).toBe(440);
    }
    const contract = contractGame('gentle-ascent');
    replay(contract, WITNESS['gentle-ascent']);
    expect(reportCardHeight(440, contractReport(contract.state))).toBe(440 + CONTRACT_BAND_H);
  });
});

describe('the report choice and the ways on', () => {
  it('starts on New after a summit and on Retry after a collapse, unless a Contract was left not completed', () => {
    const plainWin = plainGame(definition('gentle-ascent').seed);
    walkCheapestLine(plainWin);
    const plainLoss = plainGame(205);
    paceToCollapse(plainLoss);
    const contractWin = contractGame('master-surveyor');
    replay(contractWin, WITNESS['master-surveyor']);
    const contractBroken = contractGame('gentle-ascent');
    walkCheapestLine(contractBroken);
    const contractLoss = contractGame('hold-the-high-ground');
    paceToCollapse(contractLoss);
    expect([plainWin, plainLoss, contractWin, contractBroken, contractLoss].map((g) => reportFor(g.state).choice)).toEqual([
      'new',
      'retry',
      'new',
      'retry',
      'retry',
    ]);
  });

  it('Retry from a Contract left not completed, or chosen after one completed, plays the same Contract on the same mountain', () => {
    const broken = contractGame('hold-the-high-ground');
    walkCheapestLine(broken);
    const collapsed = contractGame('master-surveyor');
    paceToCollapse(collapsed);
    const completed = contractGame('gentle-ascent');
    replay(completed, WITNESS['gentle-ascent']);
    for (const game of [broken, collapsed, completed]) {
      const { contract, seed } = game.state;
      game.retrySheet(60_000);
      const s = game.state;
      const c = definition(contract!);
      expect([s.phase, s.contract, s.seed, s.map.generator]).toEqual(['playing', contract, seed, c.generator]);
      expect(mapDigest(s.map)).toBe(c.mapDigest);
      expect(contractReport(s)?.completed).toBe(false); // judged afresh, nothing carried over
    }
  });

  it('New Expedition (and R) from a Contract report, completed or not, is a plain expedition on a fresh sheet', () => {
    const completed = contractGame('gentle-ascent');
    replay(completed, WITNESS['gentle-ascent']);
    const broken = contractGame('hold-the-high-ground');
    walkCheapestLine(broken);
    const collapsed = contractGame('master-surveyor');
    paceToCollapse(collapsed);
    // R never follows the report's selection: Retry is selected on the reports left not completed.
    expect([completed, broken, collapsed].map((g) => [g.state.phase, contractReport(g.state)?.completed, reportFor(g.state).choice])).toEqual([
      ['victory', true, 'new'],
      ['victory', false, 'retry'],
      ['gameover', false, 'retry'],
    ]);
    for (const game of [completed, broken, collapsed]) {
      const left = definition(game.state.contract!);
      game.handleAction('restart', 60_000);
      expect([game.state.phase, game.state.contract, game.state.map.generator]).toEqual(['playing', null, GENERATOR_VERSION]);
      expect(game.state.seed).not.toBe(left.seed);
      expect(contractReport(game.state)).toBeNull();
    }
  });
});

describe('Contract band layout', () => {
  const inner = 600 - 2 * CONTRACT_BAND.margin;
  const views = (): ReturnType<typeof contractReportView>[] =>
    SURVEY_CONTRACTS.flatMap((c) => [
      contractReportView(c.id, judged('met', true, c.conditions.map((k) => result(k, 'met')))),
      contractReportView(c.id, judged('broken', true, c.conditions.map((k) => result(k, 'broken', 9)))),
      contractReportView(c.id, judged('broken', false, c.conditions.map((k) => result(k, 'broken', 9)))),
    ]);

  it('fits the name beside the result stamp, and every row with its result, in both languages', () => {
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang, false);
      for (const view of views()) {
        const stamp = contractStamp(view.completed);
        expect(measureText(view.name, 2) + 12 + stamp.w, `${lang} ${view.name}`).toBeLessThanOrEqual(inner);
        expect(measureText(contractText('reportContract')) + 12 + stamp.w, lang).toBeLessThanOrEqual(inner);
        for (const row of view.rows) {
          const status = contractText(row.status === 'met' ? 'reportMet' : row.status === 'broken' ? 'reportBroken' : 'reportNotReached');
          expect(12 + measureText(row.label) + 12 + measureText(status), `${lang} ${row.label}`).toBeLessThanOrEqual(inner);
        }
      }
    }
  });

  it('stacks rule, label, name, stamp and rows inside the band, clear of the foot below it', () => {
    const B = CONTRACT_BAND;
    // Text tops; 7 px Latin glyphs (Hangul reaches 1 px further each way at scale 1, 2 px at scale 2).
    const maxRows = 1 + Math.max(...SURVEY_CONTRACTS.map((c) => c.conditions.length));
    expect(B.rule).toBeGreaterThan(1); // below the plain card's body, which ends where the band begins
    expect(B.label).toBeGreaterThan(B.rule + 2);
    expect(B.label + 7 + 1).toBeLessThan(B.name - 2);
    expect(B.name + 14 + 2).toBeLessThanOrEqual(B.label + B.stampH);
    expect(B.label + B.stampH).toBeLessThan(B.rows - 1);
    expect(B.rows + (maxRows - 1) * B.rowPitch + 7 + 1).toBeLessThan(CONTRACT_BAND_H - 2); // the foot follows
    expect(B.rowPitch).toBeGreaterThanOrEqual(7 + 2 + 3);
  });
});
