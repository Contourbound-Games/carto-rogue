// Survey Contracts (src/contracts.ts): the three approved definitions, each locked to the sheet it was
// chosen on ({generator, seed, mapDigest}), and each proved feasible by a fixed witness route that is
// replayed step by step through the real Game in Standard mode and judged by evaluateContract. At runtime
// judgeContract judges only expeditions started as a Contract, by the same evaluator; no Contract
// expedition ever reaches the Standard archives, and only a met one completes its Contract. R keeps its
// meaning in a Contract: it leaves the Contract for a plain random expedition, and the Contract can be
// started again from the title card.
import { describe, expect, it } from 'vitest';
import { evaluateContract, judgeContract } from '../src/contract-conditions';
import type { ContractCondition } from '../src/contract-conditions';
import { ContractMenu } from '../src/contract-menu';
import { completeContract, contractCompletedBy, emptyContractProgress } from '../src/contract-progress';
import type { ContractProgress } from '../src/contract-progress';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId, SurveyContract } from '../src/contracts';
import { Game } from '../src/game';
import { GENERATOR_VERSION, generateMap, minCostTo } from '../src/map';
import { applyExpedition, countsTowardRecords, emptyRecords, RecordKeeper } from '../src/records';
import type { ExpeditionResult } from '../src/records';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, GameState } from '../src/types';
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

const ZERO_STEEP: ContractCondition = { kind: 'maxSteepSteps', max: 0 };
const HOLD_840: ContractCondition = { kind: 'holdSightLine', line: 'high' };

/**
 * The approved Contracts. `witness` is one route that meets the Contract, one letter per step
 * (U R D L), and `staminaLeft` what it leaves at the pillar.
 */
const APPROVED: Record<ContractId, { generator: number; seed: number; conditions: ContractCondition[]; witness: string; staminaLeft: number }> = {
  'gentle-ascent': {
    generator: 1,
    seed: 836388,
    conditions: [ZERO_STEEP],
    witness: 'LDDDDLLLDDDDDDDDLLDLLDDDDLLLLLLLLDLLLLDLLLDRRDDDDDDDRRRRRRRRRRRRDDDDDDDDDDDLLUULLLLLLLULULLL',
    staminaLeft: 69,
  },
  'hold-the-high-ground': {
    generator: 1,
    seed: 23449,
    conditions: [HOLD_840],
    witness: 'RRRRRRDDRRRUDDRRRURRRRRRURRRURRDRRRRRRDRRRU',
    staminaLeft: 53,
  },
  'master-surveyor': {
    generator: 1,
    seed: 94402,
    conditions: [ZERO_STEEP, HOLD_840],
    witness: 'URRRRRRRRRURRRRULUUUURRUUUUUURRRRRRRRRURRRDDDDDDRRDDRRRRRRRRRRRUUURRUUUUUUUL',
    staminaLeft: 67,
  },
};

const STEP: Record<string, Dir> = { U: 'up', R: 'right', D: 'down', L: 'left' };

describe('Survey Contract definitions', () => {
  it('are exactly the three approved Contracts', () => {
    expect(SURVEY_CONTRACTS.map((c) => c.id)).toEqual(Object.keys(APPROVED));
    for (const c of SURVEY_CONTRACTS) {
      const a = APPROVED[c.id];
      expect({ generator: c.generator, seed: c.seed, conditions: c.conditions }).toEqual({ generator: a.generator, seed: a.seed, conditions: a.conditions });
    }
  });

  it('have unique ids and seeds', () => {
    expect(new Set(SURVEY_CONTRACTS.map((c) => c.id)).size).toBe(SURVEY_CONTRACTS.length);
    expect(new Set(SURVEY_CONTRACTS.map((c) => c.seed)).size).toBe(SURVEY_CONTRACTS.length);
  });

  it.each(SURVEY_CONTRACTS)('$id names the sheet it was chosen on (map digest)', (c) => {
    const map = generateMap(c.seed, c.generator);
    expect(map.generator).toBe(c.generator);
    expect(mapDigest(map)).toBe(c.mapDigest);
  });
});

describe.each(SURVEY_CONTRACTS)('Survey Contract $id witness', (c) => {
  it('replays through the real Game in Standard mode to the summit with every condition met', () => {
    const { witness, staminaLeft } = APPROVED[c.id];
    const game = new Game(silent, (seed) => generateMap(seed, c.generator), { seed: c.seed, now: 0, startPlaying: true });
    expect(game.state.mode).toBe('standard');
    let now = 0;
    for (const [k, letter] of [...witness].entries()) {
      expect(game.state.phase, `step ${k + 1} of ${witness.length}`).toBe('playing');
      game.handleAction(STEP[letter], (now += 200));
      expect(game.state.turns, `step ${k + 1} must move`).toBe(k + 1);
    }
    game.update(now + 5000);
    const s = game.state;
    expect(s.finalStats?.outcome).toBe('victory');
    expect(s.finalStats?.staminaLeft).toBe(staminaLeft);
    const ev = evaluateContract(s, c.conditions);
    expect(ev.status).toBe('met');
    for (const r of ev.conditions) expect(r).toMatchObject({ status: 'met', value: 0, brokenOnTurn: null });
  });
});

// ----- Runtime judging (judgeContract) -----

/**
 * Replay a witness string (one letter per step) from turn 0, calling `each` after every step. With
 * `settle` false no frame follows the last step, so a summit is left in its end animation.
 */
function replay(game: Game, witness: string, each: (k: number) => void = () => undefined, settle = true): void {
  let now = 0;
  for (const [k, letter] of [...witness].entries()) {
    game.handleAction(STEP[letter], (now += 200));
    each(k);
  }
  if (settle) game.update(now + 5000);
}

/** The full-knowledge cheapest line to the summit: how the sheet is climbed when nobody asks for the Contract. */
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

/** Pace back and forth beside the spawn until the surveyor collapses (`settle` false: left in the collapse animation). */
function paceToCollapse(game: Game, settle = true): void {
  const s = game.state;
  const out = DIR_LIST.find((d) => stepCost(s.map, s.player.x, s.player.y, d) !== null) as Dir;
  const back = DIR_LIST.find((d) => DIRS[d].dx === -DIRS[out].dx && DIRS[d].dy === -DIRS[out].dy) as Dir;
  let now = 0;
  for (let k = 0; k < 400 && game.state.phase === 'playing'; k++) game.handleAction(k % 2 === 0 ? out : back, (now += 200));
  if (settle) game.update(now + 5000);
}

const startedAs = (id: ContractId): Game => {
  const game = new Game(silent, generateMap, { seed: 205, now: 0 });
  expect(game.startContract(0, id)).toBe(true);
  return game;
};

/** A fresh attempt: under way, nothing measured, nothing broken. */
function expectFreshJudgement(s: GameState): void {
  expect([s.trail.length, s.stepCosts.length, s.finalStats]).toEqual([1, 0, null]);
  const judged = judgeContract(s);
  expect(judged).toMatchObject({ status: 'open', summit: false });
  for (const r of judged?.conditions ?? []) expect(r).toMatchObject({ status: 'open', value: 0, brokenOnTurn: null });
}

describe.each(SURVEY_CONTRACTS)('Survey Contract $id judged at runtime', (c) => {
  it('is open all the way up the witness and met on the summit; a Retry is judged afresh', () => {
    const game = startedAs(c.id);
    const { witness } = APPROVED[c.id];
    expect(judgeContract(game.state)?.status).toBe('open');
    replay(game, witness, (k) => {
      if (k < witness.length - 1) expect(judgeContract(game.state)?.status, `step ${k + 1}`).toBe('open');
    });
    const s = game.state;
    expect(s.phase).toBe('victory');
    // Judging reads only: the frozen run is left exactly as it was.
    const snapshot = JSON.stringify([s.contract, s.trail, s.stepCosts, s.finalStats]);
    Object.freeze(s.trail);
    Object.freeze(s.stepCosts);
    Object.freeze(s.finalStats);
    const judged = judgeContract(s);
    expect(JSON.stringify([s.contract, s.trail, s.stepCosts, s.finalStats])).toBe(snapshot);
    expect(judged).toMatchObject({ status: 'met', summit: true });
    expect(judged?.conditions.map((r) => r.status)).toEqual(c.conditions.map(() => 'met'));

    game.retrySheet(60_000);
    expect(game.state.contract).toBe(c.id);
    expectFreshJudgement(game.state);
  });

  it('meets its conditions on the same route from a plain seed, which is still no Contract run', () => {
    for (const mode of ['standard', 'explorer'] as const) {
      const game = new Game(silent, generateMap, { seed: c.seed, now: 0, startPlaying: true, mode });
      replay(game, APPROVED[c.id].witness);
      expect(evaluateContract(game.state, c.conditions).status, mode).toBe('met');
      expect(judgeContract(game.state), mode).toBeNull();
    }
  });
});

describe('a Contract run judged broken', () => {
  it.each(['gentle-ascent', 'hold-the-high-ground'] as const)(
    '%s: the cheapest line reaches the summit but breaks the Contract on the way; a Retry is judged afresh',
    (id) => {
      const game = startedAs(id);
      walkCheapestLine(game);
      expect(game.state.finalStats?.outcome).toBe('victory');
      const judged = judgeContract(game.state);
      expect(judged).toMatchObject({ status: 'broken', summit: true });
      expect(judged?.conditions.some((r) => r.status === 'broken' && r.brokenOnTurn !== null)).toBe(true);

      game.retrySheet(60_000);
      expect(game.state.contract).toBe(id);
      expectFreshJudgement(game.state);
    },
  );

  it('by a collapse, whatever its conditions read', () => {
    const game = startedAs('master-surveyor');
    paceToCollapse(game);
    expect(game.state.finalStats?.outcome).toBe('defeat');
    expect(judgeContract(game.state)).toMatchObject({ status: 'broken', summit: false });
  });
});

// ----- Standard archives (records.ts) -----

/** Every expedition the keeper resolves, and the Standard archives main.ts builds from them. */
function archive(game: Game) {
  const results: ExpeditionResult[] = [];
  const keeper = new RecordKeeper(game.state, (r) => results.push(r));
  const archives = () => results.filter(countsTowardRecords).reduce(applyExpedition, emptyRecords());
  return { results, keeper, archives };
}

/** One step, whichever way is open first. */
function stepOnce(game: Game, now: number): void {
  const { map, player, turns } = game.state;
  game.handleAction(DIR_LIST.find((d) => stepCost(map, player.x, player.y, d) !== null) as Dir, now);
  expect(game.state.turns).toBe(turns + 1);
}

describe('a Contract expedition is kept out of the Standard archives', () => {
  // Whether its conditions were met plays no part: met, broken and still open are all kept out.
  const endings: [string, ContractId, (game: Game) => void, ExpeditionResult['outcome'], string][] = [
    ['met on the summit', 'master-surveyor', (game) => replay(game, APPROVED['master-surveyor'].witness), 'victory', 'met'],
    ['broken on the way to the summit', 'gentle-ascent', walkCheapestLine, 'victory', 'broken'],
    ['ended by a collapse', 'hold-the-high-ground', paceToCollapse, 'defeat', 'broken'],
    ['abandoned under way', 'gentle-ascent', (game) => stepOnce(game, 200), 'abandoned', 'open'],
  ];

  it.each(endings)('%s', (_name, id, play, outcome, judged) => {
    const game = startedAs(id);
    const { results, keeper, archives } = archive(game);
    play(game);
    keeper.sync(game.state); // the next frame
    keeper.abandon(); // page teardown
    expect(judgeContract(game.state)?.status).toBe(judged);
    expect(results).toEqual([expect.objectContaining({ outcome, mode: 'standard', contract: id })]);
    expect(countsTowardRecords(results[0])).toBe(false);
    expect(archives()).toEqual(emptyRecords());
  });

  it('attempt after attempt: each Retry is resolved once and kept out', () => {
    const game = startedAs('gentle-ascent');
    const { results, keeper, archives } = archive(game);
    walkCheapestLine(game);
    keeper.sync(game.state);
    keeper.sync(game.state);
    game.retrySheet(60_000);
    keeper.sync(game.state);
    paceToCollapse(game);
    keeper.sync(game.state);
    game.retrySheet(120_000);
    keeper.sync(game.state);
    keeper.abandon(); // the third attempt took no step: never recorded
    expect(results.map((r) => [r.outcome, r.contract])).toEqual([
      ['victory', 'gentle-ascent'],
      ['defeat', 'gentle-ascent'],
    ]);
    expect(results.some(countsTowardRecords)).toBe(false);
    expect(archives()).toEqual(emptyRecords());
  });

  it('left for a plain expedition: the Contract is kept out, the plain expedition after it counts', () => {
    const game = startedAs('hold-the-high-ground');
    const { results, keeper, archives } = archive(game);
    stepOnce(game, 200);
    game.handleAction('restart', 400); // R / New Expedition
    keeper.sync(game.state);
    stepOnce(game, 600);
    keeper.abandon();
    expect(results.map((r) => [r.outcome, r.contract])).toEqual([
      ['abandoned', 'hold-the-high-ground'],
      ['abandoned', null],
    ]);
    expect(results.map((r) => countsTowardRecords(r))).toEqual([false, true]);
    expect(archives()).toEqual(applyExpedition(emptyRecords(), results[1]));
  });

  it('started from a plain expedition: the plain expedition counts, the Contract after it is kept out', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    const { results, keeper, archives } = archive(game);
    stepOnce(game, 200);
    expect(game.startContract(400, 'gentle-ascent')).toBe(true);
    keeper.sync(game.state);
    stepOnce(game, 600);
    keeper.abandon();
    expect(results.map((r) => [r.outcome, r.contract])).toEqual([
      ['abandoned', null],
      ['abandoned', 'gentle-ascent'],
    ]);
    expect(results.map((r) => countsTowardRecords(r))).toEqual([true, false]);
    expect(archives()).toEqual(applyExpedition(emptyRecords(), results[0]));
  });

  it.each(SURVEY_CONTRACTS)("$id's sheet climbed from a plain seed counts like any Standard expedition", (c) => {
    const game = new Game(silent, generateMap, { seed: c.seed, now: 0, startPlaying: true });
    const { results, keeper, archives } = archive(game);
    replay(game, APPROVED[c.id].witness);
    keeper.sync(game.state);
    expect(results).toEqual([expect.objectContaining({ outcome: 'victory', mode: 'standard', contract: null })]);
    expect(countsTowardRecords(results[0])).toBe(true);
    expect(archives()).toMatchObject({ expeditions: 1, summits: 1 });
  });
});

// ----- Survey Contract progress (contract-progress.ts) -----

/**
 * main.ts's expedition callback, progress side: a Contract the resolved expedition completed is added,
 * and saved only when new. `saves` holds every progress that would have been written.
 */
function trackProgress(game: Game) {
  let progress = emptyContractProgress();
  const saves: ContractProgress[] = [];
  const results: ExpeditionResult[] = [];
  const keeper = new RecordKeeper(game.state, (result, expedition) => {
    results.push(result);
    const completed = contractCompletedBy(expedition);
    if (completed === null) return;
    const next = completeContract(progress, completed);
    if (next === progress) return;
    progress = next;
    saves.push(next);
  });
  return { keeper, saves, results, completed: () => progress.completed };
}

const witnessOf = (id: ContractId) => (game: Game) => replay(game, APPROVED[id].witness);

describe('Survey Contract progress', () => {
  it.each(SURVEY_CONTRACTS)('$id is completed by its witness, though the expedition stays out of the archives', (c) => {
    const game = startedAs(c.id);
    const t = trackProgress(game);
    replay(game, APPROVED[c.id].witness);
    t.keeper.sync(game.state);
    expect(t.completed()).toEqual([c.id]);
    expect(t.saves).toHaveLength(1);
    expect(countsTowardRecords(t.results[0])).toBe(false);
  });

  const noCompletion: [string, () => Game, (game: Game) => void][] = [
    ['a summit with the Contract broken', () => startedAs('gentle-ascent'), walkCheapestLine],
    ['a collapse', () => startedAs('hold-the-high-ground'), paceToCollapse],
    ['an abandoned attempt', () => startedAs('master-surveyor'), (game) => stepOnce(game, 200)],
    ['a zero-turn attempt', () => startedAs('gentle-ascent'), (game) => game.handleAction('restart', 200)],
    ['the witness from a plain Standard seed', () => new Game(silent, generateMap, { seed: 23449, now: 0, startPlaying: true }), witnessOf('hold-the-high-ground')],
    ['the witness from a plain Explorer seed', () => new Game(silent, generateMap, { seed: 836388, now: 0, startPlaying: true, mode: 'explorer' }), witnessOf('gentle-ascent')],
  ];

  it.each(noCompletion)('nothing is completed by %s', (_name, begin, play) => {
    const game = begin();
    const t = trackProgress(game);
    play(game);
    t.keeper.sync(game.state);
    t.keeper.abandon(); // page teardown
    expect(t.completed()).toEqual([]);
    expect(t.saves).toEqual([]);
  });

  it('a failed attempt changes nothing; the Retry that meets the Contract completes it', () => {
    const game = startedAs('gentle-ascent');
    const t = trackProgress(game);
    walkCheapestLine(game);
    t.keeper.sync(game.state);
    expect(t.results.map((r) => r.outcome)).toEqual(['victory']);
    expect(t.completed()).toEqual([]);
    game.retrySheet(60_000);
    replay(game, APPROVED['gentle-ascent'].witness);
    t.keeper.sync(game.state);
    expect(t.completed()).toEqual(['gentle-ascent']);
    expect(t.saves).toHaveLength(1);
  });

  it('a completion survives later failures, is saved once however often it is met again, and others add to it', () => {
    const game = startedAs('gentle-ascent');
    const t = trackProgress(game);
    replay(game, APPROVED['gentle-ascent'].witness);
    t.keeper.sync(game.state);
    // Played again: broken, then abandoned, then met once more (a frame between each).
    game.retrySheet(60_000);
    t.keeper.sync(game.state);
    walkCheapestLine(game);
    t.keeper.sync(game.state);
    game.retrySheet(120_000);
    t.keeper.sync(game.state);
    stepOnce(game, 120_200);
    expect(game.startContract(120_400, 'gentle-ascent')).toBe(true);
    t.keeper.sync(game.state);
    replay(game, APPROVED['gentle-ascent'].witness);
    t.keeper.sync(game.state);
    expect(t.results.map((r) => r.outcome)).toEqual(['victory', 'victory', 'abandoned', 'victory']);
    expect(t.completed()).toEqual(['gentle-ascent']);
    expect(t.saves).toHaveLength(1);
    // Another Contract adds to it.
    expect(game.startContract(180_000, 'hold-the-high-ground')).toBe(true);
    replay(game, APPROVED['hold-the-high-ground'].witness);
    t.keeper.sync(game.state);
    expect(t.completed()).toEqual(['gentle-ascent', 'hold-the-high-ground']);
    expect(t.saves.map((p) => p.completed)).toEqual([['gentle-ascent'], ['gentle-ascent', 'hold-the-high-ground']]);
  });

  it.each([
    ['R before the next frame', (game: Game, t: ReturnType<typeof trackProgress>) => {
      game.handleAction('restart', 90_000);
      t.keeper.sync(game.state);
    }],
    ['the page closing before the next frame', (_game: Game, t: ReturnType<typeof trackProgress>) => t.keeper.abandon()],
  ] as const)('a met summit left by %s still completes the Contract', (_name, leave) => {
    const game = startedAs('master-surveyor');
    const t = trackProgress(game);
    replay(game, APPROVED['master-surveyor'].witness); // no frame between the summit and leaving
    leave(game, t);
    expect(t.results.map((r) => [r.outcome, r.contract])).toEqual([['victory', 'master-surveyor']]);
    expect(t.completed()).toEqual(['master-surveyor']);
  });
});

// ----- R during a Contract (Game.handleAction('restart'), the action R and New Expedition share) -----

const definition = (id: ContractId): SurveyContract => SURVEY_CONTRACTS.find((c) => c.id === id) as SurveyContract;

/** What R starts, from a Contract as from anywhere: a plain Standard expedition under way on a new random sheet. */
function expectPlainFreshExpedition(s: GameState, left: SurveyContract): void {
  expect(s.contract).toBeNull();
  expect([s.phase, s.turns, s.mode, s.pausedAt, s.finalStats]).toEqual(['playing', 0, 'standard', null, null]);
  expect(s.seed).not.toBe(left.seed);
  expect([s.map.seed, s.map.generator]).toEqual([s.seed, GENERATOR_VERSION]);
  expect(mapDigest(s.map)).toBe(mapDigest(generateMap(s.seed)));
  expect(judgeContract(s)).toBeNull();
}

describe('R leaves a Contract for a plain random expedition', () => {
  it.each(SURVEY_CONTRACTS)('$id under way: nothing completed, the attempt kept out of the archives; a held R does nothing', (c) => {
    const game = startedAs(c.id);
    const t = trackProgress(game);
    stepOnce(game, 200);
    stepOnce(game, 400);
    expect([game.state.contract, game.state.turns]).toEqual([c.id, 2]);
    // Auto-repeat of a held R key never leaves the Contract, nor regenerates the sheet after it.
    game.handleAction('restart', 500, true);
    expect([game.state.contract, game.state.turns]).toEqual([c.id, 2]);
    game.handleAction('restart', 600);
    const fresh = game.state;
    expectPlainFreshExpedition(fresh, c);
    game.handleAction('restart', 700, true);
    expect(game.state).toBe(fresh);
    t.keeper.sync(game.state); // the next frame
    t.keeper.abandon(); // page teardown: the fresh expedition took no step
    expect(t.results).toEqual([expect.objectContaining({ outcome: 'abandoned', turns: 2, mode: 'standard', contract: c.id })]);
    expect(countsTowardRecords(t.results[0])).toBe(false);
    expect(t.completed()).toEqual([]);
    expect(t.saves).toEqual([]);
  });

  it('paused: R unpauses into a plain random expedition (the game side of R on the pause card)', () => {
    const c = definition('hold-the-high-ground');
    const game = startedAs(c.id);
    stepOnce(game, 200);
    expect(game.pause(300)).toBe(true);
    game.handleAction('restart', 400, true);
    expect([game.isPaused, game.state.contract, game.state.turns]).toEqual([true, c.id, 1]);
    game.handleAction('restart', 500);
    expect(game.isPaused).toBe(false);
    expectPlainFreshExpedition(game.state, c);
  });

  it('in the summit animation of a met Contract: the completion is kept, the next expedition is plain', () => {
    const c = definition('master-surveyor');
    const game = startedAs(c.id);
    const t = trackProgress(game);
    replay(game, APPROVED[c.id].witness, undefined, false); // no frame after the summit
    expect(game.state.phase).toBe('summiting');
    expect(game.state.finalStats?.outcome).toBe('victory');
    game.handleAction('restart', 30_000);
    expectPlainFreshExpedition(game.state, c);
    t.keeper.sync(game.state);
    t.keeper.abandon();
    expect(t.results.map((r) => [r.outcome, r.contract])).toEqual([['victory', c.id]]);
    expect(t.completed()).toEqual([c.id]);
    expect(t.saves).toHaveLength(1);
  });

  it('in the collapse animation: nothing is completed, the next expedition is plain', () => {
    const c = definition('gentle-ascent');
    const game = startedAs(c.id);
    const t = trackProgress(game);
    paceToCollapse(game, false); // no frame after the collapse
    expect(game.state.phase).toBe('collapsing');
    expect(game.state.finalStats?.outcome).toBe('defeat');
    game.handleAction('restart', 100_000);
    expectPlainFreshExpedition(game.state, c);
    t.keeper.sync(game.state);
    t.keeper.abandon();
    expect(t.results.map((r) => [r.outcome, r.contract])).toEqual([['defeat', c.id]]);
    expect(t.completed()).toEqual([]);
    expect(t.saves).toEqual([]);
  });

  it('a Contract already completed stays completed when a later attempt is left by R', () => {
    const c = definition('gentle-ascent');
    const game = startedAs(c.id);
    const t = trackProgress(game);
    replay(game, APPROVED[c.id].witness);
    t.keeper.sync(game.state);
    expect(t.completed()).toEqual([c.id]);
    game.retrySheet(60_000);
    t.keeper.sync(game.state);
    stepOnce(game, 60_200);
    game.handleAction('restart', 60_400);
    t.keeper.sync(game.state);
    t.keeper.abandon();
    expect(t.results.map((r) => [r.outcome, r.contract])).toEqual([
      ['victory', c.id],
      ['abandoned', c.id],
    ]);
    expect(t.completed()).toEqual([c.id]);
    expect(t.saves).toHaveLength(1);
  });

  it.each(SURVEY_CONTRACTS)('$id left by R is started again from the title card on its exact sheet', (c) => {
    const game = startedAs(c.id);
    stepOnce(game, 200);
    game.handleAction('restart', 400);
    expect(game.state.contract).toBeNull();
    game.returnToTitle(600); // pause menu: RETURN TO TITLE
    expect([game.state.phase, game.state.contract]).toEqual(['title', null]);
    expect(new ContractMenu().begin(game, 800, c.id)).toBe(true);
    const s = game.state;
    expect([s.contract, s.phase, s.turns, s.mode]).toEqual([c.id, 'playing', 0, 'standard']);
    expect([s.seed, s.map.seed, s.map.generator]).toEqual([c.seed, c.seed, c.generator]);
    expect(mapDigest(s.map)).toBe(c.mapDigest);
    expectFreshJudgement(s);
  });
});
