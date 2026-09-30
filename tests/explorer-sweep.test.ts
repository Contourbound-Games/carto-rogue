// Explorer experiment sweep (opt-in, not part of `npm test`):
//   CARTO_SWEEP=pilot npx vitest run tests/explorer-sweep.test.ts   ~100 seeds: checks the bots still behave
//   CARTO_SWEEP=final npx vitest run tests/explorer-sweep.test.ts   1000 fresh seeds: the judgement
// Every bot plays every seed in Standard and in Explorer through the real Game (paired by seed).
// Results go to .sweep/b-<phase>.json and .txt (git-ignored). No seed is ever filtered out.
//
// Written for experiment B (Explorer lowland sight 3 -> 4, since removed; results in .sweep/b-*).
// Experiment A (Supply Camps charted from the start) was rejected; its seed sets stay listed only so
// later sweeps never reuse them. The final Explorer shares every Standard rule and bots do not see
// its Step Echo, so a run now only confirms that both modes play out identically.
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { GOLDEN_SEEDS } from './support/fingerprint';
import { BOTS, MODES, pairs, runBot, summarise, sweepSeeds } from './support/sweep';
import type { CellSummary, RunResult } from './support/sweep';

const A_PILOT = sweepSeeds(0x5eed0001, 100, new Set(GOLDEN_SEEDS));
const A_FINAL = sweepSeeds(0xf1a10001, 1000, new Set([...GOLDEN_SEEDS, ...A_PILOT]));
const USED = new Set([...GOLDEN_SEEDS, ...A_PILOT, ...A_FINAL]);
const B_PILOT = sweepSeeds(0xb0b00001, 100, USED);
const B_FINAL = sweepSeeds(0xb0b0f1a1, 1000, new Set([...USED, ...B_PILOT]));

/**
 * Experiment B decision criteria, fixed before the B pilot: judged on what the mode strengthens
 * relative to Standard (paired by seed), not on absolute win rates.
 */
export const CRITERIA = {
  /** 1. contour improves by at least this much, and shows no significant paired worsening. */
  contourDeltaMin: 0.05,
  worseningP: 0.05,
  /** 3. contour - bearing may shrink by at most this much from Standard to Explorer. */
  gapShrinkMax: 0.02,
} as const;

interface Verdict {
  name: string;
  value: string;
  pass: boolean;
}

const pp = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`;
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '-');

function verdicts(cells: CellSummary[], runs: RunResult[]): Verdict[] {
  const cell = (bot: string, mode: string): CellSummary => cells.find((c) => c.bot === bot && c.mode === mode) as CellSummary;
  const contour = pairs(runs, 'contour');
  const bearing = pairs(runs, 'bearing');
  const bearingCost = pairs(runs, 'bearingCost');
  const gapS = cell('contour', 'standard').winRate - cell('bearing', 'standard').winRate;
  const gapE = cell('contour', 'explorer').winRate - cell('bearing', 'explorer').winRate;
  const oracleSame = runs
    .filter((r) => r.bot === 'oracle' && r.mode === 'standard')
    .every((s) => {
      const e = runs.find((r) => r.bot === 'oracle' && r.mode === 'explorer' && r.seed === s.seed);
      return e && e.outcome === 'victory' && s.outcome === 'victory' && e.turns === s.turns && e.staminaLeft === s.staminaLeft;
    });
  const worsening = contour.lost > contour.gained && contour.p < CRITERIA.worseningP;
  return [
    {
      name: '1. contour Explorer - Standard >= +5 pp, no significant paired worsening',
      value: `${pp(contour.delta)} (gained ${contour.gained} / lost ${contour.lost}, p=${contour.p.toFixed(3)})`,
      pass: contour.delta >= CRITERIA.contourDeltaMin && !worsening,
    },
    { name: '2. bearing gain < contour gain', value: `${pp(bearing.delta)} vs ${pp(contour.delta)}`, pass: bearing.delta < contour.delta },
    {
      name: '3. contour - bearing gap shrinks by <= 2 pp',
      value: `Standard ${pp(gapS)} -> Explorer ${pp(gapE)} (${pp(gapE - gapS)})`,
      pass: gapE - gapS >= -CRITERIA.gapShrinkMax,
    },
    {
      name: '4. bearingCost gain <= contour gain',
      value: `${pp(bearingCost.delta)} vs ${pp(contour.delta)}`,
      pass: bearingCost.delta <= contour.delta,
    },
    { name: '5. Standard equals the golden', value: 'tests/standard-golden.test.ts', pass: true },
    { name: '6. oracle 100% and identical in both modes', value: oracleSame ? 'identical' : 'differs', pass: oracleSame },
  ];
}

function report(phase: string, seeds: readonly number[], runs: RunResult[], ms: number): string {
  const cells = BOTS.flatMap((b) => MODES.map((m) => summarise(runs, b, m)));
  const lines = [`# experiment B ${phase}: ${seeds.length} seeds, ${runs.length} runs, ${(ms / 1000).toFixed(0)} s`];
  lines.push(
    'bot         mode      win     95% CI           arrive m/med turns survey start  camps all/win  flat/gentle/steep   1st sight/visit pillar  revisit  collapse elev L/M/H   noReturn L/M/H  grades',
  );
  for (const c of cells) {
    lines.push(
      [
        c.bot.padEnd(11),
        c.mode.padEnd(9),
        pct(c.winRate).padStart(6),
        `[${pct(c.ci[0])}, ${pct(c.ci[1])}]`.padEnd(16),
        `${c.arrivalMean.toFixed(1)}/${c.arrivalMedian.toFixed(0)}`.padStart(12),
        c.turnsMean.toFixed(1).padStart(5),
        `${c.surveyMean.toFixed(1)}%`.padStart(6),
        c.startRevealedMean.toFixed(0).padStart(5),
        `${c.campsMean.toFixed(2)}/${c.campsWinMean.toFixed(2)}`.padStart(14),
        `${pct(c.stepShare.flat)}/${pct(c.stepShare.gentle)}/${pct(c.stepShare.steep)}`.padStart(19),
        `${c.firstCampSightMedian}/${c.firstCampVisitMedian}`.padStart(17),
        String(c.summitSightMedian).padStart(6),
        c.revisitsMean.toFixed(1).padStart(8),
        `${Math.round(c.collapseElevMean * 1200)}m ${c.collapseBand.low}/${c.collapseBand.mid}/${c.collapseBand.high}`.padStart(20),
        `${c.noReturnBand.low}/${c.noReturnBand.mid}/${c.noReturnBand.high}`.padStart(15),
        ` ${Object.entries(c.grades).sort().map(([g, n]) => `${g}:${n}`).join(' ')}`,
        c.stuck || c.bumpsTotal ? ` stuck=${c.stuck} bumps=${c.bumpsTotal}` : '',
      ].join(' '),
    );
  }
  lines.push('paired (same seed)  S-fail->E-win  S-win->E-fail  delta      McNemar chi2   p');
  for (const b of BOTS) {
    const p = pairs(runs, b);
    lines.push(
      `${b.padEnd(19)} ${String(p.gained).padStart(13)} ${String(p.lost).padStart(14)}  ${pp(p.delta).padStart(9)}  ${p.chi2.toFixed(2).padStart(12)}  ${p.p.toFixed(4)}`,
    );
  }
  lines.push('criteria:');
  for (const v of verdicts(cells, runs)) lines.push(`  ${v.pass ? 'PASS' : 'FAIL'}  ${v.name}  (${v.value})`);
  return lines.join('\n');
}

const phase = process.env.CARTO_SWEEP;

describe.runIf(phase === 'pilot' || phase === 'final')('Explorer sweep (experiment B)', () => {
  it(`${phase} sweep`, () => {
    const seeds = phase === 'final' ? B_FINAL : B_PILOT;
    const t0 = performance.now();
    const runs: RunResult[] = [];
    for (const seed of seeds) for (const bot of BOTS) for (const mode of MODES) runs.push(runBot(seed, mode, bot));
    const ms = performance.now() - t0;
    const text = report(phase ?? '', seeds, runs, ms);
    const dir = fileURLToPath(new URL('../.sweep/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}b-${phase}.json`, JSON.stringify({ experiment: 'B', phase, criteria: CRITERIA, seeds, runs }) + '\n');
    fs.writeFileSync(`${dir}b-${phase}.txt`, text + '\n');
  }, 7_200_000);
});
