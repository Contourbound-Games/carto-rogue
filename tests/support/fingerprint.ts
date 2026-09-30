// Gameplay fingerprints for the Standard regression (tests/standard-golden.test.ts).
//
// A fingerprint drives the real Game through a fixed, seeded input script with fixed timestamps and
// hashes every gameplay-relevant value after every input: position, stamina, turns, survey, vision,
// sightings, neighbour costs, phase, log text, effect kinds, audio calls, and at the end the final
// stats, the record result and the share text. Wall-clock and animation timing (elapsed time, log and
// effect timestamps, tween starts) and everything the renderer draws are left out.
//
// The field list is explicit, so a field added later (such as the expedition mode) never enters the
// hash: a Standard run must fingerprint exactly as on the commit the golden names.
// Do not edit the scripts or the field list without regenerating the golden on the commit it names.
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { Game } from '../../src/game';
import type { GameOptions } from '../../src/game';
import { setLang } from '../../src/i18n';
import { generateMap, minCostTo } from '../../src/map';
import { applyExpedition, emptyRecords, RecordKeeper } from '../../src/records';
import type { ExpeditionResult } from '../../src/records';
import { mulberry32 } from '../../src/rng';
import { shareText } from '../../src/share';
import { stepCost, tileIndex } from '../../src/terrain';
import { DIRS, DIR_LIST } from '../../src/types';
import type { AudioEngine, Dir, DiscoveryKind, GameState, MapData, SlopeClass } from '../../src/types';

export type ScriptName = 'walk' | 'route' | 'camps';
export const SCRIPTS: readonly ScriptName[] = ['walk', 'route', 'camps'];

/** 200 golden seeds: player-style six-digit seeds plus the 32-bit extremes. */
export const GOLDEN_SEEDS: readonly number[] = [
  1,
  4294967295,
  ...Array.from({ length: 198 }, (_, k) => (k * 104729 + 17) % 999983 || 2),
];

/** Audio that records every call (sounds are gameplay feedback: they must match too). */
class RecordingAudio implements AudioEngine {
  calls: string[] = [];
  private isMuted = false;
  get muted(): boolean {
    return this.isMuted;
  }
  unlock(): void {}
  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    this.calls.push(`mute:${this.isMuted}`);
    return this.isMuted;
  }
  footstep(elevation: number, slope: SlopeClass): void {
    this.calls.push(`step:${elevation.toFixed(6)}:${slope}`);
  }
  bump(): void {
    this.calls.push('bump');
  }
  cacheCollected(): void {
    this.calls.push('cache');
  }
  discovery(kind: DiscoveryKind): void {
    this.calls.push(`disc:${kind}`);
  }
  lowStamina(): void {
    this.calls.push('low');
  }
  victory(): void {
    this.calls.push('victory');
  }
  defeat(): void {
    this.calls.push('defeat');
  }
  expeditionStart(): void {
    this.calls.push('start');
  }
  stopAll(): void {
    this.calls.push('stop');
  }
}

const bits = (a: readonly boolean[]): string => a.map((b) => (b ? '1' : '0')).join('');

/** Every gameplay value of the state, in a fixed order (no timestamps, no mode). */
function snapshot(s: GameState): string {
  const p = s.player;
  return JSON.stringify([
    s.phase,
    s.seed,
    p.x,
    p.y,
    p.fromX,
    p.fromY,
    p.facing,
    p.bumpDir,
    s.stamina,
    s.turns,
    s.staminaSpent,
    s.revealedCount,
    s.visionRadius,
    bits(s.cacheCollected),
    bits(s.cacheSighted),
    s.summitSighted,
    bits(s.peakSighted),
    s.maxElevation,
    s.lastMove,
    s.neighborCosts,
    s.localSlope,
    s.pausedAt !== null,
    s.muted,
    s.log.map((e) => [e.text, e.tone]),
    s.effects.map((e) => [e.kind, e.x, e.y, e.text ?? '', e.color ?? '', e.radius ?? 0]),
    s.trail.length,
  ]);
}

/** Hash of everything a map is made of (generation time excluded). */
export function mapDigest(map: MapData): string {
  const h = createHash('sha256');
  h.update(new Uint8Array(map.elevation.buffer, map.elevation.byteOffset, map.elevation.byteLength));
  h.update(map.water);
  h.update(map.passMask);
  h.update(map.cliffMask);
  const { genMs: _genMs, ...stats } = map.stats;
  h.update(JSON.stringify([map.seed, map.width, map.height, map.spawn, map.summit, map.caches, map.peaks, stats]));
  const probes = [0.1, 12.34, 40.5, 79.9].flatMap((x) => [0.1, 30.25, 56.78, 59.9].map((y) => map.sampleElevation(x, y)));
  h.update(JSON.stringify(probes));
  return h.digest('hex');
}

export interface RunDigest {
  hash: string;
  outcome: string;
  turns: number;
  grade: string;
}

/** Deterministic input stream: each entry is one handleAction / pause / resume call. */
interface Driver {
  game: Game;
  now: number;
  hash: Hash;
  audio: RecordingAudio;
}

function observe(d: Driver): void {
  const s = d.game.state;
  d.hash.update(snapshot(s));
  d.hash.update(s.revealed);
  d.hash.update(s.visible);
  d.hash.update(d.audio.calls.join(','));
  d.audio.calls.length = 0;
}

function act(d: Driver, action: Parameters<Game['handleAction']>[0], dt: number, repeat = false): void {
  d.now += dt;
  d.game.handleAction(action, d.now, repeat);
  d.game.update(d.now);
  observe(d);
}

function pauseFor(d: Driver, ms: number): void {
  d.now += 30;
  d.game.pause(d.now);
  observe(d);
  // Inputs while paused must do nothing.
  act(d, 'right', 50);
  d.now += ms;
  d.game.resume(d.now);
  observe(d);
}

/** Cheapest step from (x,y) toward the target whose cost-to-go table is `to`, or null on it. */
function descend(map: MapData, to: Float64Array, x: number, y: number): Dir | null {
  const here = to[tileIndex(x, y)];
  if (here === 0 || !Number.isFinite(here)) return null;
  for (const dir of DIR_LIST) {
    const c = stepCost(map, x, y, dir);
    if (c === null) continue;
    if (to[tileIndex(x + DIRS[dir].dx, y + DIRS[dir].dy)] + c === here) return dir;
  }
  return null;
}

/** Random walk from the title card: moves, held repeats, blocked steps, mute, confirm and pauses. */
function scriptWalk(d: Driver, rng: () => number): void {
  act(d, 'confirm', 100);
  for (let k = 0; k < 700 && d.game.state.phase === 'playing'; k++) {
    const r = rng();
    if (r < 0.02) act(d, 'mute', 60);
    else if (r < 0.04) act(d, 'confirm', 60);
    else if (r < 0.055) pauseFor(d, 500 + Math.floor(rng() * 2000));
    else act(d, DIR_LIST[Math.floor(rng() * 4)], 40 + Math.floor(rng() * 180), rng() < 0.35);
  }
}

/** Full-knowledge cheapest line to the summit, ignoring camps; some steps sent as held repeats. */
function scriptRoute(d: Driver, rng: () => number): void {
  const map = d.game.state.map;
  const toSummit = minCostTo(map, map.summit.x, map.summit.y);
  for (let k = 0; k < 500 && d.game.state.phase === 'playing'; k++) {
    const s = d.game.state;
    const dir = descend(map, toSummit, s.player.x, s.player.y);
    if (!dir) break;
    const repeat = rng() < 0.4;
    act(d, dir, repeat ? 120 : 200, repeat);
  }
}

/** Full-knowledge walk that detours to the cheapest camp whenever the summit is out of reach. */
function scriptCamps(d: Driver, rng: () => number): void {
  const map = d.game.state.map;
  const toSummit = minCostTo(map, map.summit.x, map.summit.y);
  const toCache = map.caches.map((c) => minCostTo(map, c.x, c.y));
  for (let k = 0; k < 800 && d.game.state.phase === 'playing'; k++) {
    const s = d.game.state;
    const i = tileIndex(s.player.x, s.player.y);
    let to = toSummit;
    if (toSummit[i] >= s.stamina) {
      let best = Infinity;
      toCache.forEach((t, c) => {
        if (!s.cacheCollected[c] && t[i] < best) {
          best = t[i];
          to = t;
        }
      });
    }
    const dir = descend(map, to, s.player.x, s.player.y);
    if (!dir) break;
    if (rng() < 0.01) pauseFor(d, 800);
    act(d, dir, 200);
  }
}

/**
 * Fingerprint one seed under one script. `extra` is merged into the Game options (the Explorer run
 * passes its mode here; nothing else may differ).
 */
export function runDigest(seed: number, script: ScriptName, extra: Record<string, unknown> = {}): RunDigest {
  setLang('en', false);
  const audio = new RecordingAudio();
  const options = { seed, now: 0, startPlaying: script !== 'walk', ...extra } as GameOptions;
  const game = new Game(audio, generateMap, options);
  const results: ExpeditionResult[] = [];
  const keeper = new RecordKeeper(game.state, (r) => results.push(r));
  const d: Driver = { game, now: 0, hash: createHash('sha256'), audio };
  d.hash.update(mapDigest(game.state.map));
  observe(d);

  const rng = mulberry32((seed ^ (script === 'walk' ? 0x9e3779b9 : script === 'route' ? 0x85ebca6b : 0xc2b2ae35)) >>> 0);
  if (script === 'walk') scriptWalk(d, rng);
  else if (script === 'route') scriptRoute(d, rng);
  else scriptCamps(d, rng);

  // Let the end animation run out, then settle the record and the report texts.
  d.now += 3000;
  game.update(d.now);
  observe(d);
  keeper.sync(game.state);
  keeper.abandon();
  const s = game.state;
  const stats = s.finalStats;
  const { elapsedMs: _elapsed, ...graded } = stats ?? { elapsedMs: 0 };
  d.hash.update(JSON.stringify([graded, s.trail, s.stepCosts]));
  if (stats) d.hash.update(shareText(s.seed, stats, 'en') + '\n' + shareText(s.seed, stats, 'ko'));
  const recorded = results.map((r) => ({
    outcome: r.outcome,
    percentMapped: r.percentMapped,
    tilesMapped: r.tilesMapped,
    turns: r.turns,
    grade: r.grade,
  }));
  d.hash.update(JSON.stringify(recorded));
  if (recorded.length > 0) d.hash.update(JSON.stringify(applyExpedition(emptyRecords(), recorded[0])));

  // Retrying the sheet must give the identical fresh start.
  game.retrySheet(d.now + 100);
  observe(d);

  return {
    hash: d.hash.digest('hex'),
    outcome: stats?.outcome ?? 'unfinished',
    turns: stats?.turns ?? s.turns,
    grade: stats?.grade ?? '-',
  };
}
