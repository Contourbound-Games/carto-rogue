// Sweep runner: one bot, one seed, one mode, played through the real Game API (fresh key presses at
// fixed timestamps). The game is the judge; this side reads the map only to describe the result.
import { VISION_HIGH_MIN, VISION_MID_MIN } from '../../src/config';
import { Game } from '../../src/game';
import { generateMap, minCostTo } from '../../src/map';
import { tileIndex } from '../../src/terrain';
import type { AudioEngine, ExpeditionMode, MapData } from '../../src/types';
import { makeBot } from './bots';
import type { Bot, BotName } from './bots';
import { observe } from './observation';
import { Oracle, OracleBot } from './oracle';

export const BOTS: readonly BotName[] = ['oracle', 'contour', 'exact', 'bearing', 'bearingCost'];
export const MODES: readonly ExpeditionMode[] = ['standard', 'explorer'];

const silent: AudioEngine = {
  unlock: () => {},
  muted: false,
  toggleMute: () => false,
  footstep: () => {},
  bump: () => {},
  cacheCollected: () => {},
  discovery: () => {},
  lowStamina: () => {},
  victory: () => {},
  defeat: () => {},
  expeditionStart: () => {},
  stopAll: () => {},
};

export type Band = 'low' | 'mid' | 'high';
const bandOf = (e: number): Band => (e < VISION_MID_MIN ? 'low' : e > VISION_HIGH_MIN ? 'high' : 'mid');

export interface RunResult {
  seed: number;
  mode: ExpeditionMode;
  bot: BotName;
  outcome: 'victory' | 'defeat' | 'stuck';
  turns: number;
  staminaLeft: number;
  staminaSpent: number;
  camps: number;
  campsTotal: number;
  grade: string;
  score: number | null;
  percentMapped: number;
  /** Blocked presses (no turn passed). */
  bumps: number;
  /** Steps onto a tile already stood on. */
  revisits: number;
  steps: { flat: number; gentle: number; steep: number };
  /** Stamina spent while standing in each vision band. */
  spentIn: Record<Band, number>;
  summitSighted: boolean;
  /** Turn of the first camp visit, null if none. */
  firstCampTurn: number | null;
  /** Turn a camp first came into sight (0 = from the spawn), null if none ever did. */
  firstCampSightTurn: number | null;
  /** Turn the pillar first came into sight, null if never. */
  summitSightTurn: number | null;
  /** Tiles surveyed before the first step. */
  startRevealed: number;
  /** Oracle plan from the spawn: best arrival stamina. */
  oracleArrival: number;
  /** Where the surveyor fell (defeats only). */
  collapse: null | {
    x: number;
    y: number;
    elevation: number;
    band: Band;
    /** Full-knowledge cost from the collapse tile to the pillar, and share of the spawn's cost left. */
    costToSummit: number;
    progress: number;
  };
  /**
   * Point of no return: the first turn after which no survivable play remained (oracle re-plan from
   * the position, stamina and camps actually collected), with the band stood in. Defeats only.
   */
  noReturn: null | { turn: number; band: Band; elevation: number; staminaThen: number; summitSighted: boolean; campsKnown: number };
  /** Every tile stood on, for failure analysis (only kept when asked). */
  trail?: string;
}

function botFor(name: BotName, map: MapData): Bot {
  return name === 'oracle' ? new OracleBot(map) : makeBot(name);
}

export function runBot(seed: number, mode: ExpeditionMode, name: BotName, keepTrail = false): RunResult {
  const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true, mode });
  const map = game.state.map;
  const bot = botFor(name, map);
  const oracle = new Oracle(map);
  const seen = new Uint8Array(map.elevation.length);
  seen[tileIndex(map.spawn.x, map.spawn.y)] = 1;
  const spentIn: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  let bumps = 0;
  let revisits = 0;
  let firstCampTurn: number | null = null;
  let firstCampSightTurn: number | null = game.state.cacheSighted.some(Boolean) ? 0 : null;
  let summitSightTurn: number | null = game.state.summitSighted ? 0 : null;
  const startRevealed = game.state.revealedCount;
  let noReturn: RunResult['noReturn'] = null;
  let now = 0;
  let stuck = false;
  for (let a = 0; a < 4000 && game.state.phase === 'playing'; a++) {
    const s = game.state;
    const dir = bot.decide(observe(s));
    if (!dir) {
      stuck = true;
      break;
    }
    const band = bandOf(map.elevation[tileIndex(s.player.x, s.player.y)]);
    const turns = s.turns;
    const stamina = s.stamina;
    const campsBefore = s.cacheCollected.filter(Boolean).length;
    now += 200;
    game.handleAction(dir, now);
    const t = game.state;
    if (t.turns === turns) {
      bumps++;
      if (bumps > 200) {
        stuck = true;
        break;
      }
      continue;
    }
    spentIn[band] += t.stepCosts[t.stepCosts.length - 1];
    const i = tileIndex(t.player.x, t.player.y);
    if (seen[i]) revisits++;
    seen[i] = 1;
    if (firstCampTurn === null && t.cacheCollected.filter(Boolean).length > campsBefore) firstCampTurn = t.turns;
    if (firstCampSightTurn === null && t.cacheSighted.some(Boolean)) firstCampSightTurn = t.turns;
    if (summitSightTurn === null && t.summitSighted) summitSightTurn = t.turns;
    if (noReturn === null && t.phase === 'playing') {
      const plan = oracle.plan(t.player.x, t.player.y, t.stamina, t.cacheCollected);
      if (plan.arrival === -Infinity) {
        const e = map.elevation[i];
        noReturn = {
          turn: t.turns,
          band: bandOf(e),
          elevation: e,
          staminaThen: stamina,
          summitSighted: t.summitSighted,
          campsKnown: observe(t).camps.filter((c) => !c.collected).length,
        };
      }
    }
  }
  game.update(now + 5000);
  const s = game.state;
  const f = s.finalStats;
  const steps = { flat: 0, gentle: 0, steep: 0 };
  for (const c of s.stepCosts) steps[c >= 8 ? 'steep' : c >= 3 ? 'gentle' : 'flat']++;
  const toSummit = minCostTo(map, map.summit.x, map.summit.y);
  const outcome = f ? f.outcome : 'stuck';
  const pi = tileIndex(s.player.x, s.player.y);
  return {
    seed,
    mode,
    bot: name,
    outcome: stuck && !f ? 'stuck' : outcome,
    turns: s.turns,
    staminaLeft: f ? f.staminaLeft : s.stamina,
    staminaSpent: s.staminaSpent,
    camps: s.cacheCollected.filter(Boolean).length,
    campsTotal: map.caches.length,
    grade: f ? f.grade : '-',
    score: f?.breakdown?.score ?? null,
    percentMapped: f ? f.percentMapped : 0,
    bumps,
    revisits,
    steps,
    spentIn,
    summitSighted: s.summitSighted,
    firstCampTurn,
    firstCampSightTurn,
    summitSightTurn,
    startRevealed,
    oracleArrival: oracle.plan(map.spawn.x, map.spawn.y, 100, map.caches.map(() => false)).arrival,
    collapse:
      outcome === 'defeat'
        ? {
            x: s.player.x,
            y: s.player.y,
            elevation: map.elevation[pi],
            band: bandOf(map.elevation[pi]),
            costToSummit: toSummit[pi],
            progress: 1 - toSummit[pi] / toSummit[tileIndex(map.spawn.x, map.spawn.y)],
          }
        : null,
    noReturn: outcome === 'defeat' ? noReturn : null,
    trail: keepTrail ? s.trail.map((p) => `${p.x},${p.y}`).join(' ') : undefined,
  };
}

// ----- Statistics -----

/** Wilson score interval (95%) for k successes in n trials, as fractions. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: readonly number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface CellSummary {
  bot: BotName;
  mode: ExpeditionMode;
  n: number;
  wins: number;
  winRate: number;
  ci: [number, number];
  stuck: number;
  arrivalMean: number;
  arrivalMedian: number;
  campsMean: number;
  campsWinMean: number;
  grades: Record<string, number>;
  steepShare: number;
  revisitsMean: number;
  bumpsTotal: number;
  collapseBand: Record<Band, number>;
  collapseElevMean: number;
  collapseProgressMedian: number;
  noReturnBand: Record<Band, number>;
  noReturnTurnMedian: number;
  turnsMean: number;
  /** Mean share of the sheet surveyed at the end, in percent. */
  surveyMean: number;
  startRevealedMean: number;
  /** Share of all steps that were flat / gentle / steep. */
  stepShare: { flat: number; gentle: number; steep: number };
  /** Median turn of the first camp sighting and the first camp visit (runs where it happened). */
  firstCampSightMedian: number;
  firstCampVisitMedian: number;
  summitSightMedian: number;
}

export function summarise(runs: readonly RunResult[], bot: BotName, mode: ExpeditionMode): CellSummary {
  const rs = runs.filter((r) => r.bot === bot && r.mode === mode);
  const wins = rs.filter((r) => r.outcome === 'victory');
  const losses = rs.filter((r) => r.outcome === 'defeat');
  const grades: Record<string, number> = {};
  for (const r of rs) grades[r.grade] = (grades[r.grade] ?? 0) + 1;
  const bands = (pick: (r: RunResult) => Band | undefined): Record<Band, number> => {
    const b: Record<Band, number> = { low: 0, mid: 0, high: 0 };
    for (const r of losses) {
      const k = pick(r);
      if (k) b[k]++;
    }
    return b;
  };
  const allSteps = rs.reduce((a, r) => a + r.steps.flat + r.steps.gentle + r.steps.steep, 0);
  return {
    bot,
    mode,
    n: rs.length,
    wins: wins.length,
    winRate: rs.length ? wins.length / rs.length : NaN,
    ci: wilson(wins.length, rs.length),
    stuck: rs.filter((r) => r.outcome === 'stuck').length,
    arrivalMean: mean(wins.map((r) => r.staminaLeft)),
    arrivalMedian: median(wins.map((r) => r.staminaLeft)),
    campsMean: mean(rs.map((r) => r.camps)),
    campsWinMean: mean(wins.map((r) => r.camps)),
    grades,
    steepShare: allSteps ? rs.reduce((a, r) => a + r.steps.steep, 0) / allSteps : NaN,
    revisitsMean: mean(rs.map((r) => r.revisits)),
    bumpsTotal: rs.reduce((a, r) => a + r.bumps, 0),
    collapseBand: bands((r) => r.collapse?.band),
    collapseElevMean: mean(losses.map((r) => r.collapse?.elevation ?? NaN)),
    collapseProgressMedian: median(losses.map((r) => r.collapse?.progress ?? NaN)),
    noReturnBand: bands((r) => r.noReturn?.band),
    noReturnTurnMedian: median(losses.map((r) => r.noReturn?.turn ?? NaN).filter((v) => Number.isFinite(v))),
    turnsMean: mean(rs.map((r) => r.turns)),
    surveyMean: mean(rs.map((r) => r.percentMapped)),
    startRevealedMean: mean(rs.map((r) => r.startRevealed)),
    stepShare: {
      flat: allSteps ? rs.reduce((a, r) => a + r.steps.flat, 0) / allSteps : NaN,
      gentle: allSteps ? rs.reduce((a, r) => a + r.steps.gentle, 0) / allSteps : NaN,
      steep: allSteps ? rs.reduce((a, r) => a + r.steps.steep, 0) / allSteps : NaN,
    },
    firstCampSightMedian: median(rs.flatMap((r) => (r.firstCampSightTurn === null ? [] : [r.firstCampSightTurn]))),
    firstCampVisitMedian: median(rs.flatMap((r) => (r.firstCampTurn === null ? [] : [r.firstCampTurn]))),
    summitSightMedian: median(rs.flatMap((r) => (r.summitSightTurn === null ? [] : [r.summitSightTurn]))),
  };
}

export interface PairSummary {
  bot: BotName;
  /** Seeds lost in Standard but won in Explorer, and the reverse. */
  gained: number;
  lost: number;
  /** Explorer win rate minus Standard win rate (fraction). */
  delta: number;
  /** McNemar's test on the discordant pairs (continuity-corrected chi-square, 1 df) and its p-value. */
  chi2: number;
  p: number;
}

/** Complementary error function (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

export function pairs(runs: readonly RunResult[], bot: BotName): PairSummary {
  const s = new Map<number, RunResult>();
  const e = new Map<number, RunResult>();
  for (const r of runs) if (r.bot === bot) (r.mode === 'standard' ? s : e).set(r.seed, r);
  let gained = 0;
  let lost = 0;
  let ws = 0;
  let we = 0;
  for (const [seed, rs] of s) {
    const re = e.get(seed);
    if (!re) continue;
    const a = rs.outcome === 'victory';
    const b = re.outcome === 'victory';
    if (a) ws++;
    if (b) we++;
    if (!a && b) gained++;
    if (a && !b) lost++;
  }
  const chi2 = gained + lost > 0 ? (Math.abs(gained - lost) - 1) ** 2 / (gained + lost) : 0;
  return { bot, gained, lost, delta: s.size ? (we - ws) / s.size : NaN, chi2, p: gained + lost > 0 ? erfc(Math.sqrt(chi2 / 2)) : 1 };
}

/** A deterministic seed list from `stream`, skipping every seed in `exclude` (earlier sets). */
export function sweepSeeds(stream: number, count: number, exclude: ReadonlySet<number>): number[] {
  let a = stream >>> 0;
  const out: number[] = [];
  const taken = new Set<number>();
  while (out.length < count) {
    // mulberry32 step, mapped to the game's random-seed range 1..999999.
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const seed = (((t ^ (t >>> 14)) >>> 0) % 999999) + 1;
    if (exclude.has(seed) || taken.has(seed)) continue;
    taken.add(seed);
    out.push(seed);
  }
  return out;
}
