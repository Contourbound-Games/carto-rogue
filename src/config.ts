// Global tuning constants and layout for The Carto-Rogue.
// Every module reads its numbers from here so gameplay, validation and rendering agree.

// ---------------------------------------------------------------------------
// Canvas / layout (virtual pixels; the canvas is CSS-scaled to fit the window)
// ---------------------------------------------------------------------------
export const VIRTUAL_WIDTH = 1280;
export const VIRTUAL_HEIGHT = 800;

export const MAP_W = 80; // tiles
export const MAP_H = 60; // tiles
export const TILE = 12; // px per tile
export const MAP_PX_W = MAP_W * TILE; // 960
export const MAP_PX_H = MAP_H * TILE; // 720

/** Top-left corner (virtual px) where the 960x720 map sheet is drawn. */
export const MAP_ORIGIN_X = 24;
export const MAP_ORIGIN_Y = 56;

/** Right-hand HUD panel rectangle (virtual px). */
export const HUD_X = 1008;
export const HUD_Y = 24;
export const HUD_W = 248;
export const HUD_H = 752;

// ---------------------------------------------------------------------------
// Elevation model (normalised 0..1  <->  0..1200 m ASL)
// ---------------------------------------------------------------------------
export const MAX_ELEV_M = 1200;
/** Tiles whose centre elevation is below this are water (impassable). */
export const WATER_LEVEL = 0.22;
/** Minor contour interval: 0.025 = 30 m. */
export const CONTOUR_INTERVAL = 0.025;
/** Every Nth contour is an index contour (thicker): 5 * 30 m = 150 m. */
export const INDEX_CONTOUR_EVERY = 5;

// ---------------------------------------------------------------------------
// Objective placement
// ---------------------------------------------------------------------------
export const SPAWN_MIN_ELEV = 0.25;
export const SPAWN_MAX_ELEV = 0.35;
export const SUMMIT_MIN_ELEV = 0.8;
export const CACHE_MIN_COUNT = 4;
export const CACHE_MAX_COUNT = 6;
/** Minimum Chebyshev distance between any two caches, and between a cache and spawn/summit. */
export const CACHE_MIN_SPACING = 8;
/** Target band for the full-knowledge, no-cache minimum stamina cost spawn -> summit. */
export const DIRECT_COST_MIN = 85;
export const DIRECT_COST_MAX = 130;
/** With optimal play (full knowledge, caches allowed) the player must reach the summit with at least this stamina left. */
export const FEASIBILITY_MARGIN = 20;
/** Hard cap on regeneration attempts; generation must still always return a valid map. */
export const MAX_GEN_ATTEMPTS = 60;

// ---------------------------------------------------------------------------
// Movement & stamina.  delta = elev(to) - elev(from)  (tile-centre elevations)
// ---------------------------------------------------------------------------
export const MAX_STAMINA = 100;
export const CACHE_RESTORE = 40;
/** delta <= SLOPE_FLAT_MAX            -> flat / downhill / along contour  (cost 1) */
export const SLOPE_FLAT_MAX = 0.012;
/** SLOPE_FLAT_MAX < delta <= SLOPE_GENTLE_MAX -> gentle uphill            (cost 3) */
export const SLOPE_GENTLE_MAX = 0.04;
/** SLOPE_GENTLE_MAX < delta <= CLIFF_DELTA   -> steep incline             (cost 8) */
/** |delta| > CLIFF_DELTA -> sheer cliff: impassable in BOTH directions. */
export const CLIFF_DELTA = 0.1;
export const COST_FLAT = 1;
export const COST_GENTLE = 3;
export const COST_STEEP = 8;
/** Below this stamina the HUD warns and a low-stamina pulse plays on each move. */
export const LOW_STAMINA = 25;

// ---------------------------------------------------------------------------
// Vision (radius in tiles, chosen by the elevation of the player's tile)
// ---------------------------------------------------------------------------
export const VISION_LOW = 3; // elev < VISION_MID_MIN
export const VISION_MID = 5; // VISION_MID_MIN <= elev <= VISION_HIGH_MIN
export const VISION_HIGH = 10; // elev > VISION_HIGH_MIN
export const VISION_MID_MIN = 0.4;
export const VISION_HIGH_MIN = 0.7;
/** Observer eye height above the ground for line-of-sight (normalised units, 0.01 = 12 m). */
export const EYE_HEIGHT = 0.012;
/** Revealing at least this many new tiles in a single step triggers a "panoramic survey burst". */
export const PANORAMA_TILE_THRESHOLD = 40;
/**
 * After a panorama burst, qualifying reveals on the next this-many turns fire no burst, chime or
 * held-key halt; their tiles are added to the panorama log line instead.
 */
export const PANORAMA_COOLDOWN_TURNS = 4;

// ---------------------------------------------------------------------------
// Timing (ms)
// ---------------------------------------------------------------------------
/** Tween duration of one step for the player sprite. */
export const MOVE_ANIM_MS = 90;
/** Minimum interval between moves when a key is held (auto-repeat). */
export const MOVE_REPEAT_MS = 115;
/** Length of the "ink bleeds out" collapse animation before the Game Over card appears. */
export const COLLAPSE_ANIM_MS = 2200;
/** Length of the summit celebration before the Victory card appears. */
export const VICTORY_ANIM_MS = 1600;

// ---------------------------------------------------------------------------
// Palette (vintage survey sheet)
// ---------------------------------------------------------------------------
export const PALETTE = {
  parchment: '#f4ecd8',
  parchmentDark: '#e8dcbf',
  parchmentShade: '#d9c9a3',
  ink: '#3a2e2b',
  inkSoft: '#5c4a40',
  inkFaded: '#8a7662',
  inkPale: '#b7a585',
  water: '#c9d3c4',
  waterInk: '#4f6b73',
  redInk: '#9b2d20',
  redInkBright: '#c0412c',
  brass: '#b08d3c',
  brassLight: '#e0c275',
  brassDark: '#6e5420',
  brassShadow: '#46341a',
  desk: '#2a1f1a',
  deskLight: '#3b2c24',
  fog: '#ebe0c5',
  fogSpeck: '#dccfae',
  green: '#5d6b3a',
} as const;
