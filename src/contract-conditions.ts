// Survey Contract conditions: a pure judgement of one expedition against a list of conditions.
// Nothing here changes a rule or the game state; it reads what the expedition already recorded (route,
// step costs, outcome) and the sheet itself. Every Contract also requires the summit: an expedition that
// collapses never meets one.
//
//   maxSteepSteps  at most `max` steep (cost 8) steps
//   holdSightLine  once above the 840 m ('high') sight line, never step below it again; the line is the
//                  one drawn on the sheet and the band the sight radius reads (visionRadiusFor), not a
//                  hidden height
//
// A condition breaks on the turn it is exceeded and stays broken; unbroken, it is met on the summit.
//
// judgeContract is the one place an expedition is judged as a Contract: only an expedition started as one
// (state.contract) is, by its definition's conditions, whatever route it took.
import { COST_STEEP, VISION_HIGH } from './config';
import { SURVEY_CONTRACTS } from './contracts';
import { visionRadiusFor } from './game';
import { tileIndex } from './terrain';
import type { GameState } from './types';

export type ContractCondition = { kind: 'maxSteepSteps'; max: number } | { kind: 'holdSightLine'; line: 'high' };

export type ConditionStatus = 'met' | 'open' | 'broken';

export interface ConditionResult {
  condition: ContractCondition;
  status: ConditionStatus;
  /** What the condition measured: steep steps taken, or steps ending below the line after first crossing it. */
  value: number;
  /** The turn on which the condition broke, else null. */
  brokenOnTurn: number | null;
}

export interface ContractEvaluation {
  /** 'met' only on a summit with every condition met; 'broken' after a collapse or any broken condition. */
  status: ConditionStatus;
  summit: boolean;
  conditions: ConditionResult[];
}

/** The parts of an expedition a Contract is judged on. */
export type ContractRun = Pick<GameState, 'map' | 'trail' | 'stepCosts' | 'finalStats'>;

/** Whether a tile-centre elevation lies above the 840 m sight line (the side the sheet draws it on). */
export function aboveHighSightLine(elevation: number): boolean {
  return visionRadiusFor(elevation) === VISION_HIGH;
}

/** Judge one expedition (in progress or finished) against `conditions`. Reads only; never mutates. */
export function evaluateContract(run: ContractRun, conditions: readonly ContractCondition[]): ContractEvaluation {
  const { map } = run;
  const finished = run.finalStats !== null;
  const summit = run.finalStats?.outcome === 'victory';

  const results = conditions.map((condition): ConditionResult => {
    let value = 0;
    let brokenOnTurn: number | null = null;
    if (condition.kind === 'maxSteepSteps') {
      // Step k is turn k + 1.
      for (let k = 0; k < run.stepCosts.length; k++) {
        if (run.stepCosts[k] < COST_STEEP) continue;
        value++;
        if (value > condition.max && brokenOnTurn === null) brokenOnTurn = k + 1;
      }
    } else {
      // trail[k] is where the player stands after turn k.
      let reached = false;
      for (let k = 0; k < run.trail.length; k++) {
        const p = run.trail[k];
        if (aboveHighSightLine(map.elevation[tileIndex(p.x, p.y)])) reached = true;
        else if (reached) {
          value++;
          if (brokenOnTurn === null) brokenOnTurn = k;
        }
      }
    }
    return { condition, status: brokenOnTurn !== null ? 'broken' : summit ? 'met' : 'open', value, brokenOnTurn };
  });

  const anyBroken = results.some((r) => r.status === 'broken');
  const status: ConditionStatus =
    anyBroken || (finished && !summit) ? 'broken' : summit && results.every((r) => r.status === 'met') ? 'met' : 'open';
  return { status, summit, conditions: results };
}

/**
 * Judge an expedition as the Survey Contract it was started as, in progress or finished: null when it is
 * no Contract (state.contract null), even on a Contract's sheet and route; otherwise evaluateContract
 * against that Contract's conditions. Reads only; never mutates.
 */
export function judgeContract(run: ContractRun & Pick<GameState, 'contract'>): ContractEvaluation | null {
  const contract = run.contract === null ? undefined : SURVEY_CONTRACTS.find((c) => c.id === run.contract);
  return contract ? evaluateContract(run, contract.conditions) : null;
}
