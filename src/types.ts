// Shared data contracts between map generation, game logic, rendering and audio.
// All tile coordinates are integers in [0, MAP_W) x [0, MAP_H); index = y * MAP_W + x.

export interface Point {
  x: number;
  y: number;
}

export type Dir = 'up' | 'right' | 'down' | 'left';

/** Per-step slope class. 'cliff' steps are impassable. */
export type SlopeClass = 'flat' | 'gentle' | 'steep' | 'cliff';

/** Slope danger reading shown on the HUD for the terrain around the player. */
export type LocalSlope = 'flat' | 'moderate' | 'steep';

export interface DirInfo {
  dx: number;
  dy: number;
  /** Bit used in MapData.passMask / MapData.cliffMask. */
  bit: number;
}

export const DIRS: Readonly<Record<Dir, DirInfo>> = {
  up: { dx: 0, dy: -1, bit: 1 },
  right: { dx: 1, dy: 0, bit: 2 },
  down: { dx: 0, dy: 1, bit: 4 },
  left: { dx: -1, dy: 0, bit: 8 },
};

export const DIR_LIST: readonly Dir[] = ['up', 'right', 'down', 'left'];

export const OPPOSITE: Readonly<Record<Dir, Dir>> = {
  up: 'down',
  right: 'left',
  down: 'up',
  left: 'right',
};

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export type CacheKind = 'plateau' | 'saddle';

export interface CacheSite {
  id: number;
  x: number;
  y: number;
  kind: CacheKind;
}

/** A notable local maximum (used for spot heights and "peak discovered" chimes). Includes the summit. */
export interface Peak {
  x: number;
  y: number;
  elevation: number;
}

export interface MapStats {
  /** Number of generation attempts (1 = first seed variant succeeded). */
  attempts: number;
  /** Fraction of all tiles that are water. */
  waterFraction: number;
  /** Fraction of land tiles reachable from spawn. */
  reachableFraction: number;
  /** Full-knowledge minimum stamina cost spawn -> summit ignoring caches. */
  directCost: number;
  /** Best stamina remaining on arrival at the summit with optimal cache use (full knowledge). */
  bestArrivalStamina: number;
  /** Number of impassable cliff edges between adjacent land tiles. */
  cliffEdges: number;
  /** Wall-clock generation time in ms. */
  genMs: number;
}

export interface MapData {
  /** The seed the player sees / can share. Same seed => identical map. */
  seed: number;
  width: number; // == MAP_W
  height: number; // == MAP_H
  /** Tile-centre elevation 0..1, length width*height. Equals sampleElevation(x + 0.5, y + 0.5). */
  elevation: Float32Array;
  /** 1 = water tile (elevation < WATER_LEVEL), impassable. */
  water: Uint8Array;
  /** Per tile: bitmask of DIRS[d].bit for every neighbour that can be stepped onto from this tile. */
  passMask: Uint8Array;
  /** Per tile: bitmask of DIRS[d].bit for every edge to a land neighbour that is a sheer cliff. Symmetric. */
  cliffMask: Uint8Array;
  spawn: Point;
  summit: Point;
  caches: CacheSite[];
  peaks: Peak[];
  stats: MapStats;
  /**
   * Continuous elevation in tile units. (0,0) is the top-left corner of tile (0,0);
   * tile centres are at (x + 0.5, y + 0.5). Returns 0..1. Deterministic for the map's seed.
   * Used by the renderer to draw per-pixel contour lines at sub-tile resolution.
   */
  sampleElevation(tx: number, ty: number): number;
}

// ---------------------------------------------------------------------------
// Game state (owned and mutated only by game.ts; read-only for renderer.ts)
// ---------------------------------------------------------------------------

/**
 * title      – title card over the fogged first map; any move/confirm key starts.
 * playing    – normal turn-based play.
 * collapsing – stamina hit 0: "ink bleeds out" animation (COLLAPSE_ANIM_MS), input ignored except R/M.
 * gameover   – Game Over card with stats; R / Enter / Space starts a new expedition.
 * summiting  – reached the Trig Pillar: celebration animation (VICTORY_ANIM_MS).
 * victory    – Victory card with expedition stats; R / Enter / Space starts a new expedition.
 */
export type Phase = 'title' | 'playing' | 'collapsing' | 'gameover' | 'summiting' | 'victory';

export type Action = Dir | 'restart' | 'mute' | 'confirm';

export interface PlayerState {
  x: number;
  y: number;
  /** Tile the player occupied before the most recent move (== x,y if none). */
  fromX: number;
  fromY: number;
  /** performance.now() when the most recent move began; sprite tweens from (fromX,fromY) over MOVE_ANIM_MS. */
  moveStart: number;
  facing: Dir;
  /** performance.now() of the last blocked move attempt (water, cliff, map edge); -Infinity if none. */
  bumpStart: number;
  bumpDir: Dir;
}

export type EffectKind = 'float-text' | 'survey-burst' | 'cache-sparkle' | 'summit-flare';

/** Transient visual effect. Created by game.ts, drawn by renderer.ts, pruned by game.update() once expired. */
export interface Effect {
  kind: EffectKind;
  /** Tile coordinates (fractional allowed; tile centre = x + 0.5). */
  x: number;
  y: number;
  start: number;
  duration: number;
  text?: string;
  color?: string;
  /** For 'survey-burst': the vision radius in tiles the ring expands to. */
  radius?: number;
}

export type LogTone = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  text: string;
  time: number;
  tone: LogTone;
}

export interface ExpeditionStats {
  outcome: 'victory' | 'defeat';
  turns: number;
  staminaSpent: number;
  staminaLeft: number;
  cachesCollected: number;
  cachesTotal: number;
  /** Highest tile elevation stood on, 0..1. */
  maxElevation: number;
  /** Surveyed tiles / all tiles * 100. */
  percentMapped: number;
  elapsedMs: number;
  /** Cartographer's grade: 'S', 'A', 'B' or 'C' for a victory; a defeat is always graded 'F'. */
  grade: string;
}

export interface GameState {
  phase: Phase;
  /** performance.now() when the current phase began (drives overlay/end animations). */
  phaseStart: number;
  map: MapData;
  seed: number;
  player: PlayerState;
  stamina: number;
  turns: number;
  staminaSpent: number;
  /** Permanent survey: 1 = tile has been seen at least once. Never cleared during an expedition. */
  revealed: Uint8Array;
  /** 1 = tile is in the current line of sight. */
  visible: Uint8Array;
  revealedCount: number;
  /** Current vision radius in tiles (VISION_LOW / VISION_MID / VISION_HIGH). */
  visionRadius: number;
  /** Parallel to map.caches. */
  cacheCollected: boolean[];
  /** Parallel to map.caches: has the cache ever been in line of sight. */
  cacheSighted: boolean[];
  summitSighted: boolean;
  /** Parallel to map.peaks. */
  peakSighted: boolean[];
  /** Every tile the player has stood on, in order, starting with the spawn. */
  trail: Point[];
  /** Highest tile elevation stood on so far (0..1). */
  maxElevation: number;
  lastMove: { cost: number; slope: SlopeClass } | null;
  /** Stamina cost preview for each neighbour; null = impassable (edge, water or cliff). */
  neighborCosts: Record<Dir, number | null>;
  /** HUD slope danger reading for the current tile. */
  localSlope: LocalSlope;
  /** performance.now() when the expedition started (first entering 'playing'); 0 while on title. */
  startTime: number;
  /** performance.now() when the expedition ended (victory/defeat); null while ongoing. */
  endTime: number | null;
  /**
   * performance.now() when the pause menu froze the expedition; null while not paused. Only ever set
   * during 'playing': turns, inputs and the expedition clock stop until Game.resume().
   */
  pausedAt: number | null;
  effects: Effect[];
  /** Newest last; capped to a handful of entries. */
  log: LogEntry[];
  muted: boolean;
  /** Filled when the expedition ends. */
  finalStats: ExpeditionStats | null;
}

// ---------------------------------------------------------------------------
// Audio contract (implemented by SynthAudio in audio.ts; tests may pass a silent mock)
// ---------------------------------------------------------------------------

export type DiscoveryKind = 'peak' | 'summit' | 'cache' | 'panorama';

export interface AudioEngine {
  /** Create / resume the AudioContext. Must be called from a user-gesture handler (keydown). Idempotent. */
  unlock(): void;
  readonly muted: boolean;
  /** Toggles mute and returns the new muted value. */
  toggleMute(): boolean;
  /** Footstep tick; pitch rises with elevation (0..1); steeper slopes sound heavier. */
  footstep(elevation: number, slope: SlopeClass): void;
  /** Dull thud when walking into water, a cliff or the map edge. */
  bump(): void;
  /** Bright chime when a supply cache is collected. */
  cacheCollected(): void;
  /** Discovery chime: first sighting of a peak / the summit / a cache, or a panoramic survey burst. */
  discovery(kind: DiscoveryKind): void;
  /** Soft warning pulse played on moves while stamina is low. */
  lowStamina(): void;
  /** Harmonious victory fanfare. */
  victory(): void;
  /** Low-frequency defeat drone. */
  defeat(): void;
  /** Short jingle when an expedition starts. */
  expeditionStart(): void;
  /** Stop any lingering long sounds (drone / fanfare) immediately, e.g. on restart. */
  stopAll(): void;
}
