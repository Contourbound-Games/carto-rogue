// What a player can read off the screen, and nothing more: the information filter between the real
// game state and the validation bots (tests/support/bots.ts). This is the only bot-side code that
// reads the map, and it only copies what the sheet and the HUD show:
//   - surveyed tiles: their contour band (lines every CONTOUR_INTERVAL), and for the exact-reader
//     their exact height; passability only between two surveyed tiles (cliff hachures, water);
//   - the step card: the exact cost of each of the four neighbouring steps;
//   - the compass: the bearing to the Trig Pillar (always shown, as a hunch before it is sighted);
//   - the Trig Pillar and the Supply Camps drawn on the sheet (on surveyed ground only);
//   - stamina and turns.
// The same in every mode: what Explorer shows more comes only from the ground it has really surveyed.
import { CONTOUR_INTERVAL } from '../../src/config';
import { tileIndex } from '../../src/terrain';
import type { Dir, GameState, MapData, Point } from '../../src/types';
import { NEIGHBOUR, N_TILES } from './paths';

export interface CampMark {
  x: number;
  y: number;
  collected: boolean;
}

/** Deliberately without the mode: a bot plays both modes alike and learns only from the sheet. */
export interface Observation {
  x: number;
  y: number;
  stamina: number;
  turns: number;
  /** 1 = surveyed tile (shown on the sheet). */
  known: Uint8Array;
  /** Contour band floor(elevation / CONTOUR_INTERVAL) of surveyed tiles; -1 elsewhere. */
  band: Int16Array;
  /** Exact elevation of surveyed tiles (exact-reader only); NaN elsewhere. */
  exact: Float32Array;
  /** Pass bits (DIRS[d].bit) of surveyed tiles, only toward surveyed neighbours; 0 elsewhere. */
  pass: Uint8Array;
  /** The step card: exact cost of each neighbouring step, null = blocked. */
  neighborCosts: Readonly<Record<Dir, number | null>>;
  /** Compass bearing to the Trig Pillar, as atan2(dy, dx) in tile space (y down). */
  bearing: number;
  /** The Trig Pillar once its tile is surveyed. */
  summit: Point | null;
  camps: CampMark[];
}

const BITS = [1, 2, 4, 8];

/** Build the observation from the game state. `map` defaults to the state's own (tests swap it). */
export function observe(s: GameState, map: MapData = s.map): Observation {
  const known = s.revealed.slice();
  const band = new Int16Array(N_TILES).fill(-1);
  const exact = new Float32Array(N_TILES).fill(NaN);
  const pass = new Uint8Array(N_TILES);
  for (let i = 0; i < N_TILES; i++) {
    if (!known[i]) continue;
    band[i] = Math.floor(map.elevation[i] / CONTOUR_INTERVAL);
    exact[i] = map.elevation[i];
    let bits = 0;
    for (let k = 0; k < 4; k++) {
      const v = NEIGHBOUR[i * 4 + k];
      if (v >= 0 && known[v]) bits |= map.passMask[i] & BITS[k];
    }
    pass[i] = bits;
  }
  const { summit } = map;
  const camps: CampMark[] = [];
  map.caches.forEach((c, i) => {
    if (known[tileIndex(c.x, c.y)]) camps.push({ x: c.x, y: c.y, collected: s.cacheCollected[i] });
  });
  return {
    x: s.player.x,
    y: s.player.y,
    stamina: s.stamina,
    turns: s.turns,
    known,
    band,
    exact,
    pass,
    neighborCosts: { ...s.neighborCosts },
    bearing: Math.atan2(summit.y - s.player.y, summit.x - s.player.x),
    summit: known[tileIndex(summit.x, summit.y)] ? { x: summit.x, y: summit.y } : null,
    camps,
  };
}
