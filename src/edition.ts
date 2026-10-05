// The edition this build is: the free itch.io release or the Steam release. It is fixed when the game is
// built (vite.config.ts: `--mode steam` is Steam, every other mode itch) and nothing at runtime changes it.
// Only the application wiring reads it; the game rules, the Contracts and the records never do.
export type Edition = 'itch' | 'steam';

declare const __EDITION__: Edition;

export const EDITION: Edition = __EDITION__;
