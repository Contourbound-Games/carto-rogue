// Survey Contracts: three fixed Standard sheets, each with conditions judged by contract-conditions.ts.
// A Contract adds no rule. It names one sheet by {generator, seed} and asks for a way of climbing it;
// the summit is always required. mapDigest is the test-side fingerprint of that sheet
// (tests/support/fingerprint.ts): tests lock it, the game never checks it at runtime.
import type { ContractCondition } from './contract-conditions';

export type ContractId = 'gentle-ascent' | 'hold-the-high-ground' | 'master-surveyor';

export interface SurveyContract {
  id: ContractId;
  /** Generator version and seed: together they name exactly one sheet. */
  generator: number;
  seed: number;
  mapDigest: string;
  conditions: readonly ContractCondition[];
}

const ZERO_STEEP: ContractCondition = { kind: 'maxSteepSteps', max: 0 };
const HOLD_840: ContractCondition = { kind: 'holdSightLine', line: 'high' };

export const SURVEY_CONTRACTS: readonly SurveyContract[] = [
  {
    id: 'gentle-ascent',
    generator: 1,
    seed: 836388,
    mapDigest: 'c26eb5bda131fd2050dfd77e622ee144004e25fe5c18108f736e2bf7a02f3e83',
    conditions: [ZERO_STEEP],
  },
  {
    id: 'hold-the-high-ground',
    generator: 1,
    seed: 23449,
    mapDigest: '6a386a799d9a9862d6187e7995aa3b88883582c83ed2064fbc4aa062d45764e8',
    conditions: [HOLD_840],
  },
  {
    id: 'master-surveyor',
    generator: 1,
    seed: 94402,
    mapDigest: '48a20b4780cd6046840db2b14a83b623a287ff1625184786859fe4a3d7c5758c',
    conditions: [ZERO_STEEP, HOLD_840],
  },
];
