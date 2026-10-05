# Steam 1.0 Scope

This document is the source of truth for the Steam 1.0 scope. It replaces the earlier version, which
listed Advanced / Expert rules, Steam Achievements, Steam Cloud, expanded long-term Records and
Gamepad / Steam Deck support as Steam 1.0 features. Those are no longer Steam 1.0 requirements (see
"Not in Steam 1.0"); the earlier text is kept in git history only.

Changing the feature lists below means a new scope decision. Tuning within them does not.

## Principles

1. The free itch version stays a complete, good core game.
2. Steam differentiates through mastery content, not by withholding basic UX quality.
3. Debrief, Grade Breakdown, Same-seed Retry and readability fixes belong to the shared core.
4. The same seed keeps representing the same mountain wherever possible (see GENERATOR_VERSIONING.md).
5. New generic roguelite systems are not added without a new scope decision.

## Shared Core (itch + Steam)

The Standard game, unchanged on Steam:

- 80 × 60 procedural elevation map; the same seed is the same mountain
- Stamina 100; each step costs 1 / 3 / 8 (flat or along a contour / gentle uphill / steep uphill); any
  downhill step costs 1
- Sheer cliffs and water are impassable
- Sight radius by elevation: below 480 m 3 tiles, 480–840 m 5 tiles, above 840 m 10 tiles; line of sight
  with ridge occlusion; Panorama
- Supply Camps restore 40 stamina, capped at 100
- Objective: reach the Ancient Trig Pillar summit
- No combat, no loot or inventory build, no meta stat progression
- Grade: score = 0.40 route + 0.35 reserve + 0.25 survey; S ≥ 0.80, A ≥ 0.62, B ≥ 0.45, otherwise C;
  a collapse is F

Also kept from the current game: the Debrief / Expedition Report, Grade Breakdown, Same-seed Retry,
Records / Archives, Explorer's Step Echo, the mobile touch fixes, the downhill wording, the collapse
solvability message and generator versioning.

## Explorer (itch + Steam)

- The same gameplay rules as Standard.
- Only after a completed cost-3 or cost-8 step does the Step Echo briefly mark it on the map.
- No pre-move guidance and no hidden information; pre-move answer UI stays rejected.
- Explorer results are kept out of the Standard Archives; shared results say Explorer.

## Survey Contracts (Steam only)

The Steam mastery feature: a challenge identity on top of unchanged Standard gameplay. Exactly three
approved Contracts, each on one fixed sheet; every Contract also requires the summit.

| Contract | id | generator | seed | conditions |
|---|---|---|---|---|
| Gentle Ascent | `gentle-ascent` | 1 | 836388 | summit; no steep step (`maxSteepSteps = 0`) |
| Hold the High Ground | `hold-the-high-ground` | 1 | 23449 | summit; once above 840 m, never step down to 840 m or below before the summit |
| Master Surveyor | `master-surveyor` | 1 | 94402 | summit; no steep step; the hold-the-high-ground condition |

- Standard only: there is no Explorer Contract.
- A Contract starts on its exact approved generator and seed. Retry keeps the same Contract on the same
  generator, seed and mountain; New Expedition and R leave the Contract for a fresh normal expedition.
- The same seed played as a normal run is no Contract and never completes one.
- Progress stores only whether each Contract is completed: no attempts, failures, timestamps, medal tiers
  or first-try records. Completed Contracts stay replayable.
- The sheet's map digest is checked by tests only; the game does not enforce it at runtime.
- The live HUD shows the Contract's name only: no live condition status, violation warning or pre-move
  warning. The end report judges the finished run itself, never the saved progress.
- Contract runs are kept out of the Standard Archives.

## Steam Desktop Build

- Web builds: itch in `dist/` (`npm run build`), Steam in `dist-steam/` (`npm run build:steam`).
- itch desktop package: `npm run desktop:pack` / `npm run desktop:zip` (desktop/electron-builder.yml), unchanged.
- Steam desktop package: `npm run desktop:pack:steam` / `npm run desktop:zip:steam`
  (desktop/electron-builder.steam.yml). It packages `dist-steam/` only, as the app's runtime `dist/`, and
  refuses to package when the Steam web build is missing.
- The packaged executable is `CartoRogue.exe`; it takes no launch arguments.

## Not in Steam 1.0

None of these block Steam 1.0. Each needs its own scope decision before any work starts.

- Advanced rules: only an uncommitted validation experiment exists (tests/advanced-sweep.test.ts,
  tests/support/advanced.ts); no runtime mode is approved.
- Expert rules: the earlier design was rejected.
- Steam Achievements and Steam Cloud: later candidates; Steam 1.0 ships with local saves.
- Expanded long-term Records / statistics: the existing Records / Archives stay as they are.
- Gamepad / Steam Deck support: a later milestone once verified or approved.
- Contract candidates: Wide Survey deferred; Red Line and Selective Resupply cut.
- Systems outside the game's design: starting equipment / loadouts, inventory, random weather, altitude
  sickness, meta stat progression, combat, generic roguelite item systems.

## External Dependencies Before Release

The repository holds no Steam App ID, depot ID or store URL, and none is added as a placeholder.

- Steamworks setup, by the developer: create the App and obtain its App ID and depot ID; set the launch
  executable (`CartoRogue.exe`), install directory and branches; the store page and its review.
- Once the App ID and depot ID exist: write and verify the SteamPipe build / depot scripts and the upload
  workflow, with `release/steam/win-unpacked/` (from `npm run desktop:pack:steam`) as the content.
- Once a real Steam store page URL exists: decide the share and COPY SEED link policy. Until then the
  Contract share carries no link, while the Standard / Explorer share and COPY SEED (Contracts included)
  link the itch page.
- Public messaging: until the Steam store page is ready, no public text, build or page uses "Coming to
  Steam", "Wishlist on Steam", a Steam call to action, the Steam logo or a Steam link. Steam wording and
  links are reconsidered only once a real store page URL exists and the developer approves the change.
  No Steam URL is made up in the meantime.

## Known Non-blocking Items

These do not hold back Steam 1.0:

- A run continued after a page hide that did not unload (browser bfcache only) is not saved as completed.
- main.ts wiring has no direct unit tests.
- Korean wording of the Hold the High Ground goal could be clearer.
- Overflow guard for longer future Contract names.
- Overall mobile HUD legibility.
- `npm run lint` errors in the git-ignored promo/ folder.
- The itch and Steam desktop builder configs duplicate each other (a test keeps them in step).
- The Windows README does not describe the Survey Contract shortcut.
- Code signing: reviewed separately once a certificate or a distribution requirement exists.
- Steamworks SDK: not needed by any Steam 1.0 feature.
