// Turn-based game logic for The Carto-Rogue: movement, stamina, vision / line of sight,
// discoveries and the phase flow (title -> playing -> summiting/collapsing -> victory/gameover).
// Audio and map generation are injected so the whole state machine runs headless in tests.
import {
  CACHE_RESTORE,
  COLLAPSE_ANIM_MS,
  EYE_HEIGHT,
  LOW_STAMINA,
  MAP_H,
  MAP_W,
  MAX_STAMINA,
  MOVE_ANIM_MS,
  MOVE_REPEAT_MS,
  PALETTE,
  PANORAMA_COOLDOWN_TURNS,
  PANORAMA_TILE_THRESHOLD,
  VICTORY_ANIM_MS,
  VISION_HIGH,
  VISION_HIGH_MIN,
  VISION_LOW,
  VISION_MID,
  VISION_MID_MIN,
  WATER_LEVEL,
} from './config';
import { t } from './i18n';
import { randomSeed } from './rng';
import { inBounds, localSlopeAt, slopeCost, stepCost, stepSlope, tileIndex, toMeters } from './terrain';
import { DIRS, DIR_LIST } from './types';
import type {
  Action,
  AudioEngine,
  Dir,
  DiscoveryKind,
  EffectKind,
  ExpeditionStats,
  GameState,
  LogEntry,
  LogTone,
  MapData,
  Phase,
} from './types';

// ---------------------------------------------------------------------------
// Tuning local to the game logic
// ---------------------------------------------------------------------------

/** Maximum number of log lines kept (the HUD shows the newest ones). */
export const LOG_CAP = 6;
/** Distance in tiles between line-of-sight samples. */
const LOS_STEP = 0.35;
/** The sightline aims slightly above the target tile's ground so flat terrain is never self-occluding. */
const TARGET_LIFT = 0.004;
/**
 * Terrain must rise more than this above the sightline to block it, by the observer's vision band
 * (normalised units: 0.008 = 10 m, 0.035 = 42 m, about 1.4 contour intervals). Lowland views stay
 * strict so ridges keep hiding dead ground; from the high ground the rounded shoulder of the hill
 * underfoot and minor crests no longer swallow the panorama (on generated maps the median view from
 * a > 0.70 tile rises from about 110 to about 195 of the 349-tile radius-10 disc).
 */
const LOS_CLEARANCE_MID = 0.008;
const LOS_CLEARANCE_HIGH = 0.035;
/** The same bump message is not repeated in the log more often than this. */
const BUMP_LOG_COOLDOWN_MS = 2500;

const FLOAT_TEXT_MS = 1400;
const SIGHTING_TEXT_MS = 1800;
const SPARKLE_MS = 800;
const SURVEY_BURST_MS = 900;

export interface GameOptions {
  /** Seed of the first map (defaults to a random seed). */
  seed?: number;
  /** Timestamp used for the initial phaseStart / log times (defaults to 0). */
  now?: number;
  /** Skip the title card and begin the expedition at once (a shared ?seed= link). */
  startPlaying?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and tooling)
// ---------------------------------------------------------------------------

/** Vision radius in tiles for the elevation of the tile the player stands on (GAME RULE 5). */
export function visionRadiusFor(elevation: number): number {
  if (elevation < VISION_MID_MIN) return VISION_LOW;
  if (elevation > VISION_HIGH_MIN) return VISION_HIGH;
  return VISION_MID;
}

function clampIndex(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * Ground height at a continuous tile-space point (tile centres at x + 0.5), obtained by
 * bilinear interpolation of the tile-centre elevations. Cheap enough for per-move sightlines.
 */
export function groundHeight(map: MapData, fx: number, fy: number): number {
  const u = fx - 0.5;
  const v = fy - 0.5;
  const fu = Math.floor(u);
  const fv = Math.floor(v);
  const tx = u - fu;
  const ty = v - fv;
  const x0 = clampIndex(fu, MAP_W - 1);
  const x1 = clampIndex(fu + 1, MAP_W - 1);
  const y0 = clampIndex(fv, MAP_H - 1) * MAP_W;
  const y1 = clampIndex(fv + 1, MAP_H - 1) * MAP_W;
  const e = map.elevation;
  const top = e[y0 + x0] + (e[y0 + x1] - e[y0 + x0]) * tx;
  const bottom = e[y1 + x0] + (e[y1 + x1] - e[y1 + x0]) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Terrain line of sight from the eye above tile (px,py) to the centre of tile (tx,ty).
 * The segment is sampled every LOS_STEP tiles, skipping samples that fall inside either
 * endpoint's own tile. A sample blocks when the interpolated ground rises more than the observer
 * band's clearance (LOS_CLEARANCE_MID / LOS_CLEARANCE_HIGH, none in the lowlands) above the sightline.
 * Water never blocks (samples over water tiles are ignored; lakes are seen at their surface).
 */
export function hasLineOfSight(map: MapData, px: number, py: number, tx: number, ty: number): boolean {
  const standing = map.elevation[tileIndex(px, py)];
  const eye = standing + EYE_HEIGHT;
  // Same bands as visionRadiusFor.
  const clearance =
    standing > VISION_HIGH_MIN ? LOS_CLEARANCE_HIGH : standing >= VISION_MID_MIN ? LOS_CLEARANCE_MID : 0;
  const ti = tileIndex(tx, ty);
  const targetGround = map.water[ti] ? Math.max(map.elevation[ti], WATER_LEVEL) : map.elevation[ti];
  const target = targetGround + TARGET_LIFT;
  const ex = px + 0.5;
  const ey = py + 0.5;
  const dx = tx - px;
  const dy = ty - py;
  const steps = Math.ceil(Math.hypot(dx, dy) / LOS_STEP);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const sx = ex + dx * t;
    const sy = ey + dy * t;
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    if ((cx === px && cy === py) || (cx === tx && cy === ty)) continue;
    if (map.water[tileIndex(cx, cy)]) continue;
    if (groundHeight(map, sx, sy) > eye + (target - eye) * t + clearance) return false;
  }
  return true;
}

/**
 * The panorama log line, with new peaks folded in. It always fits the log's 30 characters: a sheet
 * has 4800 tiles and at most a dozen peaks, so the longest form is 'Panorama +4800 tiles, 12 peaks'.
 */
export function panoramaText(tiles: number, peaks: number): string {
  if (peaks === 0) return t('logPanorama', { tiles });
  return t('logPanoramaPeaks', { tiles, peaks: peaks === 1 ? t('onePeak') : t('manyPeaks', { n: peaks }) });
}

export interface GradeInput {
  percentMapped: number;
  staminaLeft: number;
  staminaSpent: number;
  directCost: number;
}

/**
 * Cartographer's grade for a SUCCESSFUL expedition (a collapse is always 'F').
 *
 *   route   = min(1, directCost / staminaSpent)      1.0 = walked the full-knowledge optimal line.
 *             The walked route is measured by stamina spent rather than raw turns: every turn costs
 *             1, 3 or 8, so staminaSpent is the quantity directly comparable with map.stats.directCost.
 *   reserve = min(1, staminaLeft / 50)               arriving with half a pack or more is full marks.
 *   survey  = min(1, percentMapped / 25)             charting a quarter of the sheet is full marks.
 *   score   = 0.40 * route + 0.35 * reserve + 0.25 * survey
 *
 *   S >= 0.80   A >= 0.62   B >= 0.45   otherwise C
 *
 * Detours to caches lower `route` but raise `reserve`, and wandering to survey raises `survey`
 * at the cost of the other two, so every play style can earn a good grade.
 */
export function gradeVictory(input: GradeInput): string {
  const route =
    input.directCost > 0 && input.staminaSpent > 0 ? Math.min(1, input.directCost / input.staminaSpent) : 1;
  const reserve = Math.min(1, Math.max(0, input.staminaLeft) / 50);
  const survey = Math.min(1, Math.max(0, input.percentMapped) / 25);
  const score = 0.4 * route + 0.35 * reserve + 0.25 * survey;
  if (score >= 0.8) return 'S';
  if (score >= 0.62) return 'A';
  if (score >= 0.45) return 'B';
  return 'C';
}

/** A complete, fresh GameState for `map` with the player standing on the spawn tile. */
function createState(map: MapData, phase: Phase, now: number, muted: boolean): GameState {
  const tiles = MAP_W * MAP_H;
  const { x, y } = map.spawn;
  return {
    phase,
    phaseStart: now,
    map,
    seed: map.seed,
    player: {
      x,
      y,
      fromX: x,
      fromY: y,
      // A finished tween: the sprite rests on the spawn tile.
      moveStart: now - MOVE_ANIM_MS,
      facing: 'down',
      bumpStart: -Infinity,
      bumpDir: 'down',
    },
    stamina: MAX_STAMINA,
    turns: 0,
    staminaSpent: 0,
    revealed: new Uint8Array(tiles),
    visible: new Uint8Array(tiles),
    revealedCount: 0,
    visionRadius: VISION_LOW,
    cacheCollected: map.caches.map(() => false),
    cacheSighted: map.caches.map(() => false),
    summitSighted: false,
    peakSighted: map.peaks.map(() => false),
    trail: [{ x, y }],
    maxElevation: map.elevation[tileIndex(x, y)],
    lastMove: null,
    neighborCosts: { up: null, right: null, down: null, left: null },
    localSlope: 'flat',
    startTime: phase === 'title' ? 0 : now,
    endTime: null,
    pausedAt: null,
    effects: [],
    log: [],
    muted,
    finalStats: null,
  };
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export class Game {
  /** The complete state read by the renderer. Replaced wholesale on every new expedition. */
  state: GameState;

  private readonly audio: AudioEngine;
  private readonly mapFactory: (seed: number) => MapData;

  // Per-expedition bookkeeping that the renderer does not need.
  private lastMoveTime = -Infinity;
  private lastBumpText = '';
  private lastBumpLogTime = -Infinity;
  private lowStaminaWarned = false;
  /**
   * Set when a step sighted the summit or a cache or fired a panorama: held-key auto-repeat stops
   * there, so the key never carries the surveyor past what was just revealed. Any fresh press clears it.
   */
  private repeatHalted = false;
  /** Turn of the last panorama burst (PANORAMA_COOLDOWN_TURNS runs from here). */
  private lastPanoramaTurn = -Infinity;
  /** That burst's log line and its running totals, which quiet reveals in the cooldown add to. */
  private panoramaLine: { entry: LogEntry; tiles: number; peaks: number } | null = null;
  /** Label floated over a newly sighted cache (in the language active when it was sighted). */
  private get cacheLabel(): string {
    return t('floatCache');
  }

  constructor(audio: AudioEngine, mapFactory: (seed: number) => MapData, options: GameOptions = {}) {
    this.audio = audio;
    this.mapFactory = mapFactory;
    const now = options.now ?? 0;
    const map = mapFactory(options.seed ?? randomSeed());
    this.state = createState(map, 'title', now, audio.muted);
    this.primeSurroundings();
    if (options.startPlaying) this.beginFromTitle(now);
  }

  /** Route one player action. `repeat` marks a held-key auto-repeat event. */
  handleAction(action: Action, now: number, repeat = false): void {
    if (!repeat && !this.isPaused) this.repeatHalted = false;
    if (action === 'mute') {
      if (!repeat) this.toggleMute(now);
      return;
    }
    if (action === 'restart') {
      if (!repeat) this.restart(now);
      return;
    }
    // The pause menu traps every other action: nothing moves and no turn passes.
    if (this.isPaused) return;
    if (action === 'confirm' && repeat) return;

    switch (this.state.phase) {
      case 'title':
        // Any direction or confirm starts; the first key never moves the player.
        this.beginFromTitle(now);
        return;
      case 'playing':
        if (action !== 'confirm') this.tryMove(action, now, repeat);
        return;
      case 'gameover':
      case 'victory':
        if (action === 'confirm') this.restart(now);
        return;
      case 'collapsing':
      case 'summiting':
        // End animations run uninterrupted (R and M are handled above).
        return;
    }
  }

  /** Advance time-driven transitions and prune expired effects / old log lines. */
  update(now: number): void {
    const s = this.state;
    if (s.phase === 'collapsing' && now - s.phaseStart >= COLLAPSE_ANIM_MS) {
      s.phase = 'gameover';
      s.phaseStart = now;
    } else if (s.phase === 'summiting' && now - s.phaseStart >= VICTORY_ANIM_MS) {
      s.phase = 'victory';
      s.phaseStart = now;
    }
    if (s.effects.some((e) => now - e.start >= e.duration)) {
      s.effects = s.effects.filter((e) => now - e.start < e.duration);
    }
    if (s.log.length > LOG_CAP) s.log.splice(0, s.log.length - LOG_CAP);
  }

  /** Start a brand-new expedition on a fresh map and go straight to 'playing'. */
  newExpedition(now: number, seed?: number): void {
    this.replaceState(this.mapFactory(seed ?? this.freshSeed()), 'playing', now);
    this.logWelcome(now);
  }

  // -------------------------------------------------------------------------
  // Pause menu
  // -------------------------------------------------------------------------

  /** True while the pause menu has frozen the expedition. */
  get isPaused(): boolean {
    return this.state.pausedAt !== null;
  }

  /** Freeze an expedition in progress (only during 'playing'). Returns whether it paused. */
  pause(now: number): boolean {
    const s = this.state;
    if (s.phase !== 'playing' || s.pausedAt !== null) return false;
    s.pausedAt = now;
    return true;
  }

  /**
   * Unfreeze: the expedition clock skips the paused span, and a key still held from before the
   * pause cannot walk on through auto-repeat (a fresh press is needed).
   */
  resume(now: number): void {
    const s = this.state;
    if (s.pausedAt === null) return;
    s.startTime += Math.max(0, now - s.pausedAt);
    s.pausedAt = null;
    this.repeatHalted = true;
  }

  /**
   * Leave the expedition for the title card on a fresh sheet. The old state object is replaced
   * wholesale, which is how the record keeper learns that an expedition was abandoned.
   */
  returnToTitle(now: number): void {
    this.audio.stopAll();
    this.replaceState(this.mapFactory(this.freshSeed()), 'title', now);
  }

  /** Fresh state on `map` in `phase`, with every per-run bookkeeping field reset. */
  private replaceState(map: MapData, phase: Phase, now: number): void {
    this.lastMoveTime = -Infinity;
    this.lastBumpText = '';
    this.lastBumpLogTime = -Infinity;
    this.lowStaminaWarned = false;
    this.repeatHalted = false;
    this.lastPanoramaTurn = -Infinity;
    this.panoramaLine = null;
    this.state = createState(map, phase, now, this.audio.muted);
    this.primeSurroundings();
  }

  // -------------------------------------------------------------------------
  // Phase flow
  // -------------------------------------------------------------------------

  private beginFromTitle(now: number): void {
    const s = this.state;
    s.phase = 'playing';
    s.phaseStart = now;
    s.startTime = now;
    this.audio.expeditionStart();
    this.logWelcome(now);
  }

  /** R (any phase) or confirm on an end card: silence lingering sounds and start over. */
  private restart(now: number): void {
    this.startSeed(now, this.freshSeed());
  }

  /** Begin a fresh expedition on the given seed (R, or a typed seed): lingering sounds stop, the start jingle plays. */
  startSeed(now: number, seed: number): void {
    this.audio.stopAll();
    this.newExpedition(now, seed);
    this.audio.expeditionStart();
  }

  private toggleMute(now: number): void {
    this.state.muted = this.audio.toggleMute();
    if (this.state.phase === 'playing') this.log(this.state.muted ? t('logSoundOff') : t('logSoundOn'), 'info', now);
  }

  /** A random seed guaranteed to differ from the current map's. */
  private freshSeed(): number {
    let seed = randomSeed();
    while (seed === this.state.map.seed) seed = randomSeed();
    return seed;
  }

  private logWelcome(now: number): void {
    this.log(t('logBegin', { seed: this.state.seed }), 'info', now);
    this.log(t('logSeek'), 'info', now);
  }

  private finishVictory(now: number): void {
    const s = this.state;
    // The summit wins even if the final step overdrew stamina; never report a negative reserve.
    s.stamina = Math.max(0, s.stamina);
    s.phase = 'summiting';
    s.phaseStart = now;
    s.endTime = now;
    s.finalStats = this.buildStats('victory');
    this.audio.victory();
    this.addEffect('summit-flare', s.map.summit.x, s.map.summit.y, now, VICTORY_ANIM_MS);
    this.log(t('logReached'), 'good', now);
  }

  private finishCollapse(now: number): void {
    const s = this.state;
    s.stamina = 0;
    s.phase = 'collapsing';
    s.phaseStart = now;
    s.endTime = now;
    s.finalStats = this.buildStats('defeat');
    this.audio.defeat();
    this.log(t('logCollapse'), 'bad', now);
  }

  private buildStats(outcome: 'victory' | 'defeat'): ExpeditionStats {
    const s = this.state;
    const rawPercent = (s.revealedCount / (MAP_W * MAP_H)) * 100;
    const staminaLeft = Math.max(0, s.stamina);
    const grade =
      outcome === 'victory'
        ? gradeVictory({
            percentMapped: rawPercent,
            staminaLeft,
            staminaSpent: s.staminaSpent,
            directCost: s.map.stats.directCost,
          })
        : 'F';
    return {
      outcome,
      turns: s.turns,
      staminaSpent: s.staminaSpent,
      staminaLeft,
      cachesCollected: s.cacheCollected.filter(Boolean).length,
      cachesTotal: s.map.caches.length,
      maxElevation: s.maxElevation,
      percentMapped: Math.round(rawPercent * 10) / 10,
      elapsedMs: s.endTime !== null ? Math.max(0, s.endTime - s.startTime) : 0,
      grade,
    };
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private tryMove(dir: Dir, now: number, repeat: boolean): void {
    if (repeat && (this.repeatHalted || now - this.lastMoveTime < MOVE_REPEAT_MS)) return;
    this.lastMoveTime = now;

    const s = this.state;
    const { map, player } = s;
    const slope = stepSlope(map, player.x, player.y, dir);
    if (slope === null) {
      this.bump(dir, now);
      return;
    }

    const cost = slopeCost(slope);
    const nx = player.x + DIRS[dir].dx;
    const ny = player.y + DIRS[dir].dy;
    // A held key never walks the surveyor into collapse: the fatal step takes a fresh press, which
    // follows the normal rules (so do steps the summit or an uncollected cache would catch).
    if (repeat && s.stamina - cost <= 0 && !this.catchesLastStep(nx, ny)) {
      this.refuseStep(dir, t('logTooSpent'), 'warn', now);
      return;
    }
    const elevation = map.elevation[tileIndex(nx, ny)];

    s.stamina -= cost;
    s.staminaSpent += cost;
    s.turns += 1;
    player.fromX = player.x;
    player.fromY = player.y;
    player.x = nx;
    player.y = ny;
    player.facing = dir;
    player.moveStart = now;
    s.trail.push({ x: nx, y: ny });
    if (elevation > s.maxElevation) s.maxElevation = elevation;
    s.lastMove = { cost, slope };
    this.audio.footstep(elevation, slope);

    const freshTiles = this.updateVision();
    const chime = this.announceDiscoveries(freshTiles, now);
    this.resolveArrival(now);
    // On the step that ends the expedition the fanfare or the drone plays alone.
    if (chime !== null && s.phase === 'playing') this.audio.discovery(chime);
    this.refreshNeighbourhood();
  }

  /** Blocked step (map edge, water or cliff): no cost and no turn, just feedback. */
  private bump(dir: Dir, now: number): void {
    const { map, player } = this.state;
    const nx = player.x + DIRS[dir].dx;
    const ny = player.y + DIRS[dir].dy;
    if (!inBounds(nx, ny)) this.refuseStep(dir, t('logEdge'), 'info', now);
    else if (map.water[tileIndex(nx, ny)]) this.refuseStep(dir, t('logWater'), 'info', now);
    else this.refuseStep(dir, t('logCliff'), 'warn', now);
  }

  /** A step that does not happen: bump animation and thud, with repeats of the same log line throttled. */
  private refuseStep(dir: Dir, text: string, tone: LogTone, now: number): void {
    const player = this.state.player;
    player.bumpStart = now;
    player.bumpDir = dir;
    player.facing = dir;
    this.audio.bump();
    if (text !== this.lastBumpText || now - this.lastBumpLogTime >= BUMP_LOG_COOLDOWN_MS) {
      this.lastBumpText = text;
      this.lastBumpLogTime = now;
      this.log(text, tone, now);
    }
  }

  /** Whether arriving on (x,y) is resolved before the collapse check: the summit or an uncollected cache. */
  private catchesLastStep(x: number, y: number): boolean {
    const { map, cacheCollected } = this.state;
    if (x === map.summit.x && y === map.summit.y) return true;
    return map.caches.some((c, i) => !cacheCollected[i] && c.x === x && c.y === y);
  }

  /** GAME RULE 3, in order: summit victory, then cache collection, then collapse check. */
  private resolveArrival(now: number): void {
    const s = this.state;
    const { map, player } = s;

    if (player.x === map.summit.x && player.y === map.summit.y) {
      this.finishVictory(now);
      return;
    }

    for (let i = 0; i < map.caches.length; i++) {
      const cache = map.caches[i];
      if (s.cacheCollected[i] || cache.x !== player.x || cache.y !== player.y) continue;
      s.cacheCollected[i] = true;
      s.cacheSighted[i] = true;
      const before = s.stamina;
      s.stamina = Math.min(MAX_STAMINA, s.stamina + CACHE_RESTORE);
      const gained = s.stamina - before;
      this.audio.cacheCollected();
      // The pickup text takes over from a sighting label still hanging over this cache.
      s.effects = s.effects.filter(
        (e) => !(e.kind === 'float-text' && e.text === this.cacheLabel && e.x === cache.x && e.y === cache.y),
      );
      this.addEffect('float-text', cache.x, cache.y, now, FLOAT_TEXT_MS, {
        text: t('floatStamina', { n: gained }),
        color: PALETTE.green,
      });
      this.addEffect('cache-sparkle', cache.x, cache.y, now, SPARKLE_MS, { color: PALETTE.brassLight });
      this.log(t('logCacheGain', { n: gained }), 'good', now);
      break;
    }

    if (s.stamina <= 0) {
      this.finishCollapse(now);
      return;
    }
    if (s.stamina < LOW_STAMINA) {
      this.audio.lowStamina();
      if (!this.lowStaminaWarned) {
        this.lowStaminaWarned = true;
        this.log(t('logLowStamina'), 'warn', now);
      }
    } else {
      // Re-arm the warning once a cache lifts stamina back out of the danger zone.
      this.lowStaminaWarned = false;
    }
  }

  private refreshNeighbourhood(): void {
    const s = this.state;
    const { x, y } = s.player;
    for (const d of DIR_LIST) s.neighborCosts[d] = stepCost(s.map, x, y, d);
    s.localSlope = localSlopeAt(s.map, x, y);
  }

  // -------------------------------------------------------------------------
  // Vision & discoveries
  // -------------------------------------------------------------------------

  /** Vision, sightings and neighbour info for a freshly placed player (no sounds, no logs). */
  private primeSurroundings(): void {
    this.updateVision();
    const s = this.state;
    const { map } = s;
    if (s.visible[tileIndex(map.summit.x, map.summit.y)]) s.summitSighted = true;
    map.peaks.forEach((p, i) => {
      if (s.visible[tileIndex(p.x, p.y)]) s.peakSighted[i] = true;
    });
    map.caches.forEach((c, i) => {
      if (s.visible[tileIndex(c.x, c.y)]) s.cacheSighted[i] = true;
    });
    this.refreshNeighbourhood();
  }

  /**
   * Recompute the current line of sight (GAME RULE 5) and fold it into the permanent survey.
   * Returns the number of tiles revealed for the first time.
   */
  private updateVision(): number {
    const s = this.state;
    const { map } = s;
    const px = s.player.x;
    const py = s.player.y;
    const radius = visionRadiusFor(map.elevation[tileIndex(px, py)]);
    const reach = radius + 0.5;
    const reach2 = reach * reach;
    const span = Math.ceil(reach);
    s.visionRadius = radius;
    s.visible.fill(0);

    let fresh = 0;
    for (let dy = -span; dy <= span; dy++) {
      const ty = py + dy;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let dx = -span; dx <= span; dx++) {
        const tx = px + dx;
        if (tx < 0 || tx >= MAP_W) continue;
        if (dx * dx + dy * dy > reach2) continue;
        const adjacent = dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1;
        if (!adjacent && !hasLineOfSight(map, px, py, tx, ty)) continue;
        const i = tileIndex(tx, ty);
        s.visible[i] = 1;
        if (!s.revealed[i]) {
          s.revealed[i] = 1;
          s.revealedCount++;
          fresh++;
        }
      }
    }
    return fresh;
  }

  /**
   * Record and log every new sighting after a step, and return the one discovery chime it earns,
   * chosen by priority summit > panorama > peak > cache (the caller plays it only if the expedition
   * goes on). Sighting the summit or a cache, or a panorama, also halts held-key auto-repeat.
   * The log stays short: new peaks fold into the panorama line, and next to the summit sighting
   * they are only tracked. A big high-ground reveal within PANORAMA_COOLDOWN_TURNS of the last
   * burst is no new panorama (no burst, chime or halt): while that panorama's line is still the
   * newest, its tiles and peaks are added to it in place.
   */
  private announceDiscoveries(freshTiles: number, now: number): DiscoveryKind | null {
    const s = this.state;
    const { map, player } = s;
    let sound: DiscoveryKind | null = null;

    const summit = map.summit;
    if (!s.summitSighted && s.visible[tileIndex(summit.x, summit.y)]) {
      s.summitSighted = true;
      sound = 'summit';
      this.log(t('logSummitSighted'), 'good', now);
      this.addEffect('float-text', summit.x, summit.y, now, SIGHTING_TEXT_MS, {
        text: t('floatTrig'),
        color: PALETTE.redInk,
      });
    }

    let newPeaks = 0;
    let topPeak = 0;
    for (let i = 0; i < map.peaks.length; i++) {
      const p = map.peaks[i];
      if (s.peakSighted[i] || !s.visible[tileIndex(p.x, p.y)]) continue;
      s.peakSighted[i] = true;
      // The summit is also listed as a peak; it has its own announcement above.
      if (p.x === summit.x && p.y === summit.y) continue;
      newPeaks++;
      topPeak = Math.max(topPeak, p.elevation);
    }

    const wideReveal = freshTiles >= PANORAMA_TILE_THRESHOLD && s.visionRadius === VISION_HIGH;
    // Walking a ridge opens fresh ground step after step; only the first reveal is the event.
    const panorama = wideReveal && s.turns - this.lastPanoramaTurn > PANORAMA_COOLDOWN_TURNS;
    const line = this.panoramaLine;
    let folded = false;
    if (panorama) {
      this.lastPanoramaTurn = s.turns;
      if (sound === null) sound = 'panorama';
      // On the summit step itself the summit-flare takes over; the burst would only stack on it.
      if (player.x !== summit.x || player.y !== summit.y) {
        this.addEffect('survey-burst', player.x, player.y, now, SURVEY_BURST_MS, {
          radius: s.visionRadius,
          color: PALETTE.brass,
        });
      }
      const entry = this.log(panoramaText(freshTiles, newPeaks), 'good', now);
      this.panoramaLine = { entry, tiles: freshTiles, peaks: newPeaks };
    } else if (wideReveal && line !== null && s.log.at(-1) === line.entry) {
      // Inside the cooldown: the running total goes into that line, which the HUD lights up again.
      line.tiles += freshTiles;
      line.peaks += newPeaks;
      line.entry.text = panoramaText(line.tiles, line.peaks);
      line.entry.time = now;
      folded = true;
    }

    // Peaks get a line of their own only when neither the summit nor a panorama was announced (and
    // none when they were just folded into the panorama line, though they still chime then).
    if (newPeaks > 0 && sound === null) {
      sound = 'peak';
      const metres = toMeters(topPeak);
      if (!folded) {
        this.log(
          newPeaks === 1 ? t('logPeak', { m: metres }) : t('logPeaks', { n: newPeaks, m: metres }),
          'info',
          now,
        );
      }
    }

    let newCaches = 0;
    for (let i = 0; i < map.caches.length; i++) {
      const c = map.caches[i];
      if (s.cacheSighted[i] || !s.visible[tileIndex(c.x, c.y)]) continue;
      s.cacheSighted[i] = true;
      if (s.cacheCollected[i]) continue;
      newCaches++;
      // Like the summit, a new cache is labelled where it stands: its sprite is easy to miss at the rim.
      this.addEffect('float-text', c.x, c.y, now, SIGHTING_TEXT_MS, { text: this.cacheLabel, color: PALETTE.brassDark });
    }
    if (newCaches > 0) {
      if (sound === null) sound = 'cache';
      this.log(newCaches === 1 ? t('logCacheSpotted') : t('logCachesSpotted', { n: newCaches }), 'info', now);
    }

    // A held key stops here: the surveyor may want to head for what just came into view.
    if (sound === 'summit' || panorama || newCaches > 0) this.repeatHalted = true;
    return sound;
  }

  // -------------------------------------------------------------------------
  // Effects & log
  // -------------------------------------------------------------------------

  private addEffect(
    kind: EffectKind,
    x: number,
    y: number,
    now: number,
    duration: number,
    extra: { text?: string; color?: string; radius?: number } = {},
  ): void {
    this.state.effects.push({ kind, x, y, start: now, duration, ...extra });
  }

  private log(text: string, tone: LogTone, now: number): LogEntry {
    const log = this.state.log;
    const entry: LogEntry = { text, time: now, tone };
    log.push(entry);
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    return entry;
  }
}
