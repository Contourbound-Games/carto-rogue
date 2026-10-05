// Survey Contract progress: which approved Contracts have been completed, kept in localStorage apart
// from the Standard archives. Only completion is kept (no attempts, failures, times or scores). A Contract
// is completed by an expedition started as that Contract and judged met, which includes the summit;
// failing or abandoning it later never takes a completion back, and a completed Contract stays playable.
import { judgeContract } from './contract-conditions';
import type { ContractRun } from './contract-conditions';
import { SURVEY_CONTRACTS } from './contracts';
import type { ContractId } from './contracts';
import type { GameState } from './types';

export const CONTRACT_PROGRESS_STORAGE_KEY = 'carto_rogue_contracts_v1';

export interface ContractProgress {
  version: 1;
  /** Completed Contracts, each once, in the order they were first completed. */
  completed: ContractId[];
}

export function emptyContractProgress(): ContractProgress {
  return { version: 1, completed: [] };
}

function isContractId(value: unknown): value is ContractId {
  return SURVEY_CONTRACTS.some((c) => c.id === value);
}

/** Parse stored JSON defensively: only approved Contract ids are kept, each once; anything else is dropped. */
export function parseContractProgress(raw: string | null): ContractProgress {
  if (!raw) return emptyContractProgress();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyContractProgress();
  }
  if (typeof data !== 'object' || data === null) return emptyContractProgress();
  const completed = (data as Record<string, unknown>).completed;
  if (!Array.isArray(completed)) return emptyContractProgress();
  return { version: 1, completed: [...new Set(completed.filter(isContractId))] };
}

export function loadContractProgress(): ContractProgress {
  try {
    return parseContractProgress(localStorage.getItem(CONTRACT_PROGRESS_STORAGE_KEY));
  } catch {
    return emptyContractProgress();
  }
}

export function saveContractProgress(progress: ContractProgress): void {
  try {
    localStorage.setItem(CONTRACT_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Blocked storage: the progress simply lasts for this session.
  }
}

/** The Contract an expedition completed: the one it was started as, if judged met; else null. */
export function contractCompletedBy(expedition: ContractRun & Pick<GameState, 'contract'>): ContractId | null {
  return judgeContract(expedition)?.status === 'met' ? expedition.contract : null;
}

/** The progress with `id` completed: the same object when it already was, so there is nothing to save. */
export function completeContract(progress: ContractProgress, id: ContractId): ContractProgress {
  return progress.completed.includes(id) ? progress : { version: 1, completed: [...progress.completed, id] };
}

export function isContractCompleted(progress: ContractProgress, id: ContractId): boolean {
  return progress.completed.includes(id);
}
