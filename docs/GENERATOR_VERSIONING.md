# Generator Versioning

A mountain's identity is `{ generator, seed }`. The same pair always produces the same map.
Players see and share the plain numeric seed; the generator version is internal.

## Current state

- `GENERATOR_VERSION = 1` (`src/map.ts`) is the only generator. Every new, random, typed and linked seed uses it.
- Generator 1 is the output recorded by the Standard golden fixture (`tests/fixtures/standard-golden.json`).
- Same-sheet Retry regenerates from the current map's exact `{ generator, seed }`.
- `generateMap(seed, generator)` throws for a version this build cannot produce. It never falls back to another.
- Aggregate Archives store no seed or generator and are unchanged.
- The reference runtime for determinism is V8 (Electron, Chrome, Node). The golden runs on V8; other engines are not verified.
- `simplex-noise` is pinned to exactly `4.0.3`, because its output is part of generator 1.

## Rule for changes

A change that alters the golden map output is a generator change. This includes terrain, objective
placement, validation, the attempt scheme, a dependency upgrade and floating-point maths. It requires an
explicit generator-version decision before merging:

1. Do not regenerate the golden fixture to absorb the change.
2. Decide whether the change becomes a new generator version, and how shipped content that pins
   generator 1 (future Survey Contracts) stays reproducible.
3. Record the decision here.

## Not decided

How plain player-entered seeds behave once a second generator exists: newest generator, old generator,
or an edition marker. Revisit this only if a v2 generator actually exists.
