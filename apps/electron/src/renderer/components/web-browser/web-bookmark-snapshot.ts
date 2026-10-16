export interface WebBookmarkRequestScope {
  accountId: string | null
  generation: number
}

/** Rejects snapshots and writes that started before an account switch or newer refresh. */
export function isCurrentWebBookmarkRequest(
  request: WebBookmarkRequestScope,
  currentAccountId: string | null,
  currentGeneration: number,
): boolean {
  return request.accountId === currentAccountId && request.generation === currentGeneration
}
