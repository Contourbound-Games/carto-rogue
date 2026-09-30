// The full-knowledge reference player: the one bot given the map. It plans the order of camps that
// leaves the most stamina at the pillar (from any position, stamina and set of collected camps) and
// walks the cheapest line to its next stop, re-planning after every step. The same planner tells the
// sweep's failure analysis whether a position was still winnable.
import { CACHE_RESTORE, MAX_STAMINA } from '../../src/config';
import { minCostTo } from '../../src/map';
import { stepCost, tileIndex } from '../../src/terrain';
import { DIRS, DIR_LIST } from '../../src/types';
import type { Dir, MapData } from '../../src/types';
import type { Bot } from './bots';
import type { Observation } from './observation';

export interface OraclePlan {
  /** Best stamina left at the pillar (never negative), or -Infinity when no survivable play exists. */
  arrival: number;
  /** First stop: a camp index, or -1 for the pillar. */
  next: number;
}

export class Oracle {
  private readonly toSummit: Float64Array;
  private readonly toCache: Float64Array[];

  constructor(private readonly map: MapData) {
    this.toSummit = minCostTo(map, map.summit.x, map.summit.y);
    this.toCache = map.caches.map((c) => minCostTo(map, c.x, c.y));
  }

  /** Conservative: every leg must end with stamina >= 0 (the game also allows some last-step overdraws). */
  plan(x: number, y: number, stamina: number, collected: readonly boolean[]): OraclePlan {
    const caches = this.map.caches;
    const search = (pos: number, s: number, done: number): number => {
      const direct = s - this.toSummit[pos];
      let best = direct >= 0 ? direct : -Infinity;
      for (let j = 0; j < caches.length; j++) {
        if (done & (1 << j)) continue;
        const left = s - this.toCache[j][pos];
        if (!(left >= 0)) continue;
        const r = search(tileIndex(caches[j].x, caches[j].y), Math.min(MAX_STAMINA, left + CACHE_RESTORE), done | (1 << j));
        if (r > best) best = r;
      }
      return best;
    };
    const start = tileIndex(x, y);
    let done = 0;
    collected.forEach((c, j) => {
      if (c) done |= 1 << j;
    });
    const direct = stamina - this.toSummit[start];
    let arrival = direct >= 0 ? direct : -Infinity;
    let next = -1;
    for (let j = 0; j < caches.length; j++) {
      if (done & (1 << j)) continue;
      const left = stamina - this.toCache[j][start];
      if (!(left >= 0)) continue;
      const r = search(tileIndex(caches[j].x, caches[j].y), Math.min(MAX_STAMINA, left + CACHE_RESTORE), done | (1 << j));
      if (r > arrival) {
        arrival = r;
        next = j;
      }
    }
    return { arrival, next };
  }

  /** Cheapest step from (x, y) toward stop `next` (a camp index, or -1 for the pillar). */
  step(x: number, y: number, next: number): Dir | null {
    const to = next < 0 ? this.toSummit : this.toCache[next];
    const here = to[tileIndex(x, y)];
    if (here === 0 || !Number.isFinite(here)) return null;
    for (const d of DIR_LIST) {
      const c = stepCost(this.map, x, y, d);
      if (c !== null && to[tileIndex(x + DIRS[d].dx, y + DIRS[d].dy)] + c === here) return d;
    }
    return null;
  }
}

/** The oracle as a bot. It reads collected camps from its own bookkeeping of the camps it walked onto. */
export class OracleBot implements Bot {
  readonly name = 'oracle' as const;
  private readonly oracle: Oracle;
  private readonly collected: boolean[];

  constructor(private readonly map: MapData) {
    this.oracle = new Oracle(map);
    this.collected = map.caches.map(() => false);
  }

  decide(obs: Observation): Dir | null {
    this.map.caches.forEach((c, j) => {
      if (c.x === obs.x && c.y === obs.y) this.collected[j] = true;
    });
    const plan = this.oracle.plan(obs.x, obs.y, obs.stamina, this.collected);
    return this.oracle.step(obs.x, obs.y, plan.next);
  }
}
