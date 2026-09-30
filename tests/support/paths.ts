// Bucket-queue (Dial) shortest paths on the 80x60 grid with small integer step weights, for the
// validation bots. Weights are per directed edge: weights[u * 4 + k] is the cost of stepping from u
// in DIR_LIST[k] (up, right, down, left), or -1 when that step is impassable (or believed to be).
import { MAP_H, MAP_W } from '../../src/config';

export const N_TILES = MAP_W * MAP_H;
export const INF = 0x3fffffff;

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** NEIGHBOUR[u * 4 + k] = tile one step from u in DIR_LIST[k], or -1 off the sheet. */
export const NEIGHBOUR: Int32Array = (() => {
  const t = new Int32Array(N_TILES * 4);
  for (let u = 0; u < N_TILES; u++) {
    const x = u % MAP_W;
    const y = (u / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      t[u * 4 + k] = nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H ? -1 : ny * MAP_W + nx;
    }
  }
  return t;
})();

/**
 * Distances from `source` (forward) or to `source` (reverse: the cost of reaching it from every
 * tile). Every weight must lie in 1..maxW. Unreachable tiles stay at INF.
 */
export function dial(weights: Int16Array, source: number, reverse: boolean, maxW: number): Int32Array {
  const dist = new Int32Array(N_TILES).fill(INF);
  const size = maxW + 1;
  const buckets: number[][] = Array.from({ length: size }, () => []);
  dist[source] = 0;
  buckets[0].push(source);
  let pending = 1;
  for (let d = 0; pending > 0; d++) {
    const bucket = buckets[d % size];
    while (bucket.length > 0) {
      const u = bucket.pop() as number;
      pending--;
      if (dist[u] !== d) continue;
      for (let k = 0; k < 4; k++) {
        const v = NEIGHBOUR[u * 4 + k];
        if (v < 0) continue;
        // Reverse: relax the edge v -> u, which leaves v in the opposite direction.
        const w = reverse ? weights[v * 4 + ((k + 2) & 3)] : weights[u * 4 + k];
        if (w < 0) continue;
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          buckets[nd % size].push(v);
          pending++;
        }
      }
    }
  }
  return dist;
}
