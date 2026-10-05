// Survey Contracts (src/contracts.ts): the three approved definitions, each locked to the sheet it was
// chosen on ({generator, seed, mapDigest}), and each proved feasible by a fixed witness route that is
// replayed step by step through the real Game in Standard mode and judged by evaluateContract.
import { describe, expect, it } from 'vitest';
import { evaluateContract } from '../src/contract-conditions';
import type { ContractCondition } from '../src/contract-conditions';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId } from '../src/contracts';
import { Game } from '../src/game';
import { generateMap } from '../src/map';
import type { AudioEngine, Dir } from '../src/types';
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
