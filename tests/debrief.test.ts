// Readability of resolved steps and of the collapse report: a descent is never called flat (it still
// costs 1), the report tallies descents apart from flat ground, and a collapse on a generated sheet
// says a route to the Trig Pillar existed, without naming it. Text must fit its slot in both languages.
import { afterEach, describe, expect, it } from 'vitest';
import { COST_FLAT, MAX_STAMINA, SLOPE_FLAT_MAX } from '../src/config';
import { measureText } from '../src/font';
import { Game } from '../src/game';
import { defeatSubtitle, lastStepKind } from '../src/hud';
import { setLang, t } from '../src/i18n';
import type { Lang } from '../src/i18n';
import { generateMap, provenSolvable } from '../src/map';
import { classifySlope, describeStep, describeStepBetween, slopeCost, stepSlope, tallySteps, tileIndex } from '../src/terrain';
import type { StepKind } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, MapData } from '../src/types';

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

const LANGS: readonly Lang[] = ['en', 'ko'];

/** The first seed (from 1) whose spawn has a neighbouring step of the given kind, and that step. */
function spawnStepOf(kind: StepKind): { seed: number; dir: Dir } {
  for (let seed = 1; seed < 400; seed++) {
    const map = generateMap(seed);
    const { x, y } = map.spawn;
    for (const dir of DIR_LIST) {
      const to = { x: x + DIRS[dir].dx, y: y + DIRS[dir].dy };
      if (stepSlope(map, x, y, dir) !== null && describeStepBetween(map, map.spawn, to) === kind) return { seed, dir };
    }
  }
  throw new Error(`no spawn with a ${kind} step`);
}

describe('step wording', () => {
  it('calls a drop beyond the flat band downhill, and leaves the cost and every other class alone', () => {
    const cases: [number, StepKind][] = [
      [-0.09, 'downhill'],
      [-SLOPE_FLAT_MAX - 0.001, 'downhill'],
      [-SLOPE_FLAT_MAX, 'flat'],
      [0, 'flat'],
      [SLOPE_FLAT_MAX, 'flat'],
      [0.03, 'gentle'],
      [0.08, 'steep'],
      [0.2, 'cliff'],
      [-0.2, 'cliff'],
    ];
    for (const [delta, kind] of cases) {
      expect(describeStep(delta), `${delta}`).toBe(kind);
      // The rule is untouched: whatever the wording, a drop still costs 1.
      if (kind === 'downhill') expect(slopeCost(classifySlope(delta))).toBe(COST_FLAT);
      else if (kind !== 'cliff') expect(describeStep(delta)).toBe(classifySlope(delta));
    }
  });

  it('reads the last step of a real expedition as it was: downhill, flat, or the uphill class', () => {
    for (const kind of ['downhill', 'flat', 'gentle', 'steep'] as const) {
      const { seed, dir } = spawnStepOf(kind);
      const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
      game.handleAction(dir, 100);
      const move = game.state.lastMove;
      expect(move, `${kind} (seed ${seed})`).not.toBeNull();
      if (!move) continue;
      expect(lastStepKind(game.state, move.slope), `seed ${seed} ${dir}`).toBe(kind);
      if (kind === 'downhill') {
        // The game itself still resolves it as a cost-1 'flat' slope class.
        expect(move).toEqual({ cost: COST_FLAT, slope: 'flat' });
        expect(game.state.stamina).toBe(MAX_STAMINA - COST_FLAT);
      }
    }
  });
});

describe('collapse report', () => {
  it('tallies descents apart from flat ground, and the tally still adds up to the run', () => {
    let sawDownhill = false;
    for (const seed of [205, 555, 31337]) {
      const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
      // A wandering walk: open steps in a fixed cycle until the surveyor collapses or 120 tries pass.
      let k = 0;
      for (let a = 0; a < 400 && game.state.phase === 'playing' && game.state.turns < 120; a++) {
        game.handleAction(DIR_LIST[(k + (a % 3 === 0 ? 1 : 0)) % 4], 100 * (a + 1));
        if (a % 7 === 0) k++;
      }
      const s = game.state;
      const tally = tallySteps(s.map, s.trail, s.stepCosts);
      const steps = tally.steep.steps + tally.gentle.steps + tally.flat.steps + tally.downhill.steps;
      const cost = tally.steep.cost + tally.gentle.cost + tally.flat.cost + tally.downhill.cost;
      expect(steps).toBe(s.turns);
      expect(cost).toBe(s.staminaSpent);
      expect(tally.downhill.cost).toBe(tally.downhill.steps * COST_FLAT);
      // Each cost-1 step is in exactly one of the two rows, by its height change.
      let downhill = 0;
      s.stepCosts.forEach((c, i) => {
        const delta = s.map.elevation[tileIndex(s.trail[i + 1].x, s.trail[i + 1].y)] - s.map.elevation[tileIndex(s.trail[i].x, s.trail[i].y)];
        if (c === COST_FLAT && delta < -SLOPE_FLAT_MAX) downhill++;
      });
      expect(tally.downhill.steps).toBe(downhill);
      if (downhill > 0) sawDownhill = true;
    }
    expect(sawDownhill).toBe(true);
  });

  it('says a route existed on every generated sheet, and only from the stored stats', () => {
    for (const seed of [1, 205, 555, 31337, 4294967295]) {
      const map = generateMap(seed);
      expect(provenSolvable(map), `seed ${seed}`).toBe(true);
      expect(defeatSubtitle(map)).toBe(t('sheetHadRoute'));
    }
    // A sheet without the generator's proof keeps the old subtitle.
    const unproven: MapData = { ...generateMap(205), stats: { ...generateMap(205).stats, bestArrivalStamina: 0 } };
    expect(provenSolvable(unproven)).toBe(false);
    expect(defeatSubtitle(unproven)).toBe(t('inkBleeds'));
  });

  it('names no route, no tile and no number', () => {
    for (const lang of LANGS) {
      const text = t('sheetHadRoute', undefined, lang);
      expect(text, lang).not.toMatch(/\d/);
    }
  });
});

describe('layout', () => {
  afterEach(() => setLang('en', false));

  // Card and HUD geometry these strings are drawn into (src/hud.ts).
  const CARD_TEXT_W = 600 - 2 * 40; // inside the defeat card's neatline, with margin
  const ROW_W = 344;
  const STAMINA_W = 248 - 22; // HUD section width

  it('fits the new defeat card text in both languages', () => {
    for (const lang of LANGS) {
      setLang(lang, false);
      expect(measureText(t('sheetHadRoute'), 2), `${lang} subtitle`).toBeLessThanOrEqual(CARD_TEXT_W);
      for (const key of ['stepsSteep', 'stepsGentle', 'stepsFlat', 'stepsDownhill'] as const) {
        const label = measureText(t(key), 2);
        const value = measureText(t('stepsValue', { n: 999, cost: 999 }), 2);
        expect(label + value + 12, `${lang} ${key}`).toBeLessThanOrEqual(ROW_W);
      }
    }
  });

  it('fits LAST STEP -1 DOWNHILL beside the LOW! warning in both languages', () => {
    for (const lang of LANGS) {
      setLang(lang, false);
      const start = 9 + measureText(`${t('lastStep')} `) + 2;
      const end = start + measureText('-8') + 6 + Math.max(...(['slopeDownhill', 'slopeFlat', 'slopeGentle', 'slopeSteep'] as const).map((k) => measureText(t(k))));
      const lowLeft = STAMINA_W - 9 - measureText(t('low')) - 4;
      expect(end, lang).toBeLessThanOrEqual(lowLeft);
    }
  });
});
