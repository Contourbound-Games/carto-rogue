// Validation bots for the Explorer experiment. Each one sees only an Observation (what the screen
// shows, see observation.ts) and answers with one step; the real Game judges the outcome. None of
// them imports the map or the game. The tuning below is fixed before the final sweep.
//
//   contour      reads the contour lines: step costs of surveyed ground guessed from how many
//                contour bands a step climbs; plans a route over surveyed ground and the fog.
//   exact        the same planner reading surveyed ground exactly (the most vision can tell).
//   bearing      contour-blind: walks the compass bearing (or toward a camp it can see on the
//                sheet), taking whichever open step points most nearly that way.
//   bearingCost  as bearing, but also shies away from dear steps on the step card.
//
// Camp policy, the same for every bot and both modes (only what is on the sheet differs): a known
// camp is worth a visit only when its believed detour costs less than the stamina it restores. When
// stamina runs short the bot takes the best such camp; otherwise only one lying close to the way.
// Before the pillar is on the sheet, "the way" is a point where the compass bearing leaves the sheet,
// held until the bearing swings by more than ANCHOR_SWING.
//
// Pilot fixes (behaviour defects found in the 100-seed pilot, before any final run):
//   - held waypoint: a waypoint that jumped with every small swing of the needle (a bearing near
//     due west flips between -179 and 180 degrees) had the planner pacing between two tiles;
//   - planner revisit cost: re-treading its own trail costs a little extra, so it does not pace;
//   - net-gain camp rule: the first rule (nearest camp whenever stamina < 50) had the bearing bots
//     hopping from camp to camp, spending more stamina between camps than the camps restored;
//   - fog climb charge: with the fog priced as cheap level ground, the planners put every climb off
//     into the fog and circled the lowlands along the contours (twice the oracle's lowland stamina),
//     and in Explorer walked the lowland rim toward a charted camp that stood high up. Stepping from
//     surveyed ground into the fog now also charges the climb still owed to the goal's height, at the
//     cheapest climbing rate the rules allow (COST_GENTLE per SLOPE_GENTLE_MAX of height), so height
//     gained on surveyed ground counts. The pillar's height is taken as SUMMIT_MIN_ELEV until it is
//     sighted (it always stands on the high ground); a camp not yet surveyed is taken to stand as high
//     as the way up is at that point (between the bot's height and the pillar's, by progress).
//     (A variant believing the fog rises evenly from the bot's own height was tried and dropped: it
//     gave no credit for height gained on surveyed ground, and the planners circled the lowlands again.)
import {
  CACHE_RESTORE,
  CONTOUR_INTERVAL,
  COST_GENTLE,
  MAP_H,
  MAP_W,
  SLOPE_GENTLE_MAX,
  SUMMIT_MIN_ELEV,
} from '../../src/config';
import { classifySlope, slopeCost } from '../../src/terrain';
import { DIR_LIST } from '../../src/types';
import type { Dir, Point } from '../../src/types';
import type { CampMark, Observation } from './observation';
import { INF, NEIGHBOUR, N_TILES, dial } from './paths';

export type BotName = 'oracle' | 'contour' | 'exact' | 'bearing' | 'bearingCost';

export interface Bot {
  readonly name: BotName;
  /** The next step, or null to stop (nothing sensible left). */
  decide(obs: Observation): Dir | null;
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const BITS = [1, 2, 4, 8];

/** Stamina is short below the believed cost to a sighted pillar x NEED_FACTOR + NEED_SLACK... */
const NEED_FACTOR = 1.1;
const NEED_SLACK = 5;
/** ...or, before the pillar is on the sheet (its distance unknown), below this. */
const BLIND_LOW_STAMINA = 50;
/** A camp is "on the way" when its believed detour costs at most this much stamina. */
const ON_THE_WAY = 12;
/** The held waypoint is renewed once the bearing swings further than this from it. */
const ANCHOR_SWING = (20 * Math.PI) / 180;

const tile = (x: number, y: number): number => y * MAP_W + x;
const angleGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** The pillar once it is on the sheet, else a held point where the compass bearing leaves the sheet. */
class Waypoint {
  private anchor: Point | null = null;

  get(obs: Observation): Point {
    if (obs.summit) return obs.summit;
    const a = this.anchor;
    if (a) {
      const toAnchor = Math.atan2(a.y - obs.y, a.x - obs.x);
      if (angleGap(toAnchor, obs.bearing) <= ANCHOR_SWING && Math.hypot(a.x - obs.x, a.y - obs.y) > 3) return a;
    }
    const ux = Math.cos(obs.bearing);
    const uy = Math.sin(obs.bearing);
    let fx = obs.x + 0.5;
    let fy = obs.y + 0.5;
    for (let k = 0; k < 200; k++) {
      const nx = fx + ux;
      const ny = fy + uy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) break;
      fx = nx;
      fy = ny;
    }
    this.anchor = { x: Math.floor(fx), y: Math.floor(fy) };
    return this.anchor;
  }
}

/**
 * The camp to head for, given each open camp's believed cost to reach and believed detour (both in
 * stamina), or null. Keeps `current` while it stays reachable.
 */
function chooseCamp(
  open: readonly CampMark[],
  current: CampMark | null,
  stamina: number,
  short: boolean,
  reach: (c: CampMark) => number,
  detour: (c: CampMark) => number,
): CampMark | null {
  const worth = open.filter((c) => reach(c) < stamina && detour(c) < CACHE_RESTORE);
  if (current && worth.some((c) => c.x === current.x && c.y === current.y)) return current;
  if (worth.length === 0) return null;
  const best = worth.reduce((a, b) => (detour(b) < detour(a) ? b : a));
  return short || detour(best) <= ON_THE_WAY ? best : null;
}

// ----- Planner bots (contour / exact) -----

/** Weights are stamina x 2, so the contour reader's 1.5 stays an integer. */
const SCALE = 2;
/** Believed cost of a step touching unsurveyed ground, before its believed climb (level ground). */
const FOG_W = 1 * SCALE;
/** Stamina per unit of height climbed at the cheapest rate the rules allow (3 per 0.04 = 75). */
const CLIMB_RATE = COST_GENTLE / SLOPE_GENTLE_MAX;
/** Contour reader: believed cost by contour bands climbed (<= -1, 0, 1, 2, >= 3). */
const BAND_W = [1 * SCALE, 1.5 * SCALE, 3 * SCALE, 6 * SCALE, 8 * SCALE];
/** Extra believed cost per earlier visit of the tile stepped onto (1 stamina), counted up to 4 visits. */
const REVISIT_W = 1 * SCALE;
const REVISIT_CAP = 4;
const MAX_W = Math.ceil(8 * SCALE + REVISIT_W * REVISIT_CAP + CLIMB_RATE * SCALE);

class PlannerBot implements Bot {
  private camp: CampMark | null = null;
  private readonly waypoint = new Waypoint();
  private readonly visits = new Uint8Array(N_TILES);

  constructor(readonly name: 'contour' | 'exact') {}

  /** Height of a surveyed tile as this bot reads it (the contour reader: the middle of its band). */
  private height(obs: Observation, i: number): number {
    return this.name === 'exact' ? obs.exact[i] : (obs.band[i] + 0.5) * CONTOUR_INTERVAL;
  }

  /**
   * Believed step costs toward a goal of height `goal`: surveyed ground as read, fog as level ground,
   * and stepping from surveyed ground into the fog charges the climb still owed to `goal`.
   */
  private weights(obs: Observation, here: number, goal: number): Int16Array {
    const w = new Int16Array(N_TILES * 4);
    for (let u = 0; u < N_TILES; u++) {
      const owed = obs.known[u] ? Math.round(Math.max(0, goal - this.height(obs, u)) * CLIMB_RATE * SCALE) : 0;
      for (let k = 0; k < 4; k++) {
        const v = NEIGHBOUR[u * 4 + k];
        let c: number;
        if (v < 0) c = -1;
        else if (u === here) {
          const card = obs.neighborCosts[DIR_LIST[k]];
          c = card === null ? -1 : card * SCALE;
        } else if (obs.known[u] && obs.known[v]) {
          if (!(obs.pass[u] & BITS[k])) c = -1;
          else if (this.name === 'exact') c = slopeCost(classifySlope(obs.exact[v] - obs.exact[u])) * SCALE;
          else c = BAND_W[Math.max(0, Math.min(4, obs.band[v] - obs.band[u] + 1))];
        } else c = FOG_W + (obs.known[v] ? 0 : owed);
        if (c > 0) c += REVISIT_W * Math.min(REVISIT_CAP, this.visits[v]);
        w[u * 4 + k] = c;
      }
    }
    return w;
  }

  decide(obs: Observation): Dir | null {
    const here = tile(obs.x, obs.y);
    if (this.visits[here] < 255) this.visits[here]++;
    const top = obs.summit ? this.height(obs, tile(obs.summit.x, obs.summit.y)) : SUMMIT_MIN_ELEV;
    const wp = this.waypoint.get(obs);
    const way = tile(wp.x, wp.y);
    const toPillar = this.weights(obs, here, top);
    const toWay = dial(toPillar, way, true, MAX_W);
    const at = (c: CampMark): number => tile(c.x, c.y);
    const open = obs.camps.filter((c) => !c.collected);
    const short = obs.summit ? obs.stamina * SCALE < toWay[here] * NEED_FACTOR + NEED_SLACK * SCALE : obs.stamina < BLIND_LOW_STAMINA;
    // A camp's height: as read once surveyed, else as high as the way up is at that point.
    const base = this.height(obs, here);
    const span = Math.hypot(wp.x - obs.x, wp.y - obs.y);
    const campHeight = (c: CampMark): number => {
      if (obs.known[at(c)]) return this.height(obs, at(c));
      const p = span < 1 ? 1 : Math.max(0, Math.min(1, 1 - Math.hypot(wp.x - c.x, wp.y - c.y) / span));
      return base + (top - base) * p;
    };
    const campWeights = new Map<CampMark, Int16Array>();
    const weightsFor = (c: CampMark): Int16Array => {
      let cw = campWeights.get(c);
      if (!cw) campWeights.set(c, (cw = this.weights(obs, here, campHeight(c))));
      return cw;
    };
    if (open.length > 0) {
      const reach = new Map(open.map((c) => [c, dial(weightsFor(c), here, false, MAX_W)[at(c)] / SCALE] as const));
      // Onward from a camp in the fog: the fog route plus the climb from the camp's height to the pillar's.
      const onward = (c: CampMark): number =>
        toWay[at(c)] / SCALE + (obs.known[at(c)] ? 0 : Math.max(0, top - campHeight(c)) * CLIMB_RATE);
      this.camp = chooseCamp(
        open,
        this.camp,
        obs.stamina,
        short,
        (c) => reach.get(c) ?? Infinity,
        (c) => (reach.get(c) ?? Infinity) + onward(c) - toWay[here] / SCALE,
      );
    } else this.camp = null;

    const w = this.camp ? weightsFor(this.camp) : toPillar;
    const toGoal = this.camp ? dial(w, at(this.camp), true, MAX_W) : toWay;
    let best: Dir | null = null;
    let bestCost = INF;
    for (let k = 0; k < 4; k++) {
      const c = w[here * 4 + k];
      if (c < 0) continue;
      const total = c + toGoal[NEIGHBOUR[here * 4 + k]];
      if (total < bestCost) {
        bestCost = total;
        best = DIR_LIST[k];
      }
    }
    return best;
  }
}

// ----- Bearing bots (contour-blind) -----

/** Believed stamina per tile of straight-line distance (the planner's fog prior). */
const BEARING_TILE_COST = 2;
/** Score lost per earlier visit of a tile (keeps it from pacing in place at an obstacle). */
const VISIT_PENALTY = 0.35;
/** bearingCost: score lost for a dearer step, (cost - 1) / 7 x this (a steep step = -0.6). */
const COST_PENALTY = 0.6;

class BearingBot implements Bot {
  private camp: CampMark | null = null;
  private readonly waypoint = new Waypoint();
  private readonly visits = new Uint16Array(N_TILES);

  constructor(readonly name: 'bearing' | 'bearingCost') {}

  decide(obs: Observation): Dir | null {
    const here = tile(obs.x, obs.y);
    this.visits[here]++;
    const wp = this.waypoint.get(obs);
    const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
    const me = { x: obs.x, y: obs.y };
    const short = obs.summit
      ? obs.stamina < dist(me, obs.summit) * BEARING_TILE_COST * NEED_FACTOR + NEED_SLACK
      : obs.stamina < BLIND_LOW_STAMINA;
    this.camp = chooseCamp(
      obs.camps.filter((c) => !c.collected),
      this.camp,
      obs.stamina,
      short,
      (c) => dist(me, c) * BEARING_TILE_COST,
      (c) => (dist(me, c) + dist(c, wp) - dist(me, wp)) * BEARING_TILE_COST,
    );
    let ux: number;
    let uy: number;
    if (this.camp) {
      const len = dist(me, this.camp) || 1;
      ux = (this.camp.x - obs.x) / len;
      uy = (this.camp.y - obs.y) / len;
    } else {
      ux = Math.cos(obs.bearing);
      uy = Math.sin(obs.bearing);
    }
    let best: Dir | null = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 4; k++) {
      const cost = obs.neighborCosts[DIR_LIST[k]];
      if (cost === null) continue;
      let score = DX[k] * ux + DY[k] * uy - VISIT_PENALTY * this.visits[NEIGHBOUR[here * 4 + k]];
      if (this.name === 'bearingCost') score -= (COST_PENALTY * (cost - 1)) / 7;
      if (score > bestScore) {
        bestScore = score;
        best = DIR_LIST[k];
      }
    }
    return best;
  }
}

/** A fresh observation-only bot (the oracle lives in oracle.ts: it alone is given the map). */
export function makeBot(name: Exclude<BotName, 'oracle'>): Bot {
  return name === 'contour' || name === 'exact' ? new PlannerBot(name) : new BearingBot(name);
}
