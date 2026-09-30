// Explorer's Step Echo: right after a costly step (cost 3 or 8), that step is briefly re-inked on the
// sheet with the stamina it actually cost, so the eye goes back from the number to the ground just
// crossed. It is presentation only and strictly after the fact: its sources are the step the game
// has already resolved (player.fromX/fromY -> x/y, lastMove.cost, player.moveStart). It never reads
// the map, never says why a step cost what it did, and says nothing about the next step.
import { COST_FLAT, COST_STEEP, MOVE_ANIM_MS } from './config';
import type { GameState, Point } from './types';

/** Exactly the state an echo may depend on. */
export type StepEchoState = Pick<GameState, 'mode' | 'phase' | 'player' | 'lastMove'>;

export interface StepEcho {
  from: Point;
  to: Point;
  /** The stamina the step cost (3 or 8). */
  cost: number;
  /** How far the stroke has been drawn along the step, 0..1 (it follows the surveyor's tween). */
  progress: number;
  /** Opacity 0..1: full, then fading out. */
  alpha: number;
  /** The cost figure appears once the surveyor has arrived. */
  showCost: boolean;
}

/** How long an echo lasts from the start of its step (a steep one a little longer). */
export const ECHO_GENTLE_MS = 800;
export const ECHO_STEEP_MS = 1000;
/** Share of the echo's life at full strength before it fades out. */
const ECHO_HOLD = 0.55;

/**
 * The echo to draw at `now`, or null. Only in Explorer play, only for a step that cost more than
 * COST_FLAT, and only for the latest step: the next step (or its absence, after a blocked press)
 * is what the state holds, so echoes can never pile up.
 */
export function stepEcho(s: StepEchoState, now: number): StepEcho | null {
  if (s.mode !== 'explorer' || s.phase !== 'playing' || s.lastMove === null) return null;
  const { cost } = s.lastMove;
  if (cost <= COST_FLAT) return null;
  const p = s.player;
  if (p.fromX === p.x && p.fromY === p.y) return null;
  const age = now - p.moveStart;
  const life = cost >= COST_STEEP ? ECHO_STEEP_MS : ECHO_GENTLE_MS;
  if (age < 0 || age >= life) return null;
  const hold = life * ECHO_HOLD;
  return {
    from: { x: p.fromX, y: p.fromY },
    to: { x: p.x, y: p.y },
    cost,
    progress: Math.min(1, age / MOVE_ANIM_MS),
    alpha: age <= hold ? 1 : 1 - (age - hold) / (life - hold),
    showCost: age >= MOVE_ANIM_MS,
  };
}
