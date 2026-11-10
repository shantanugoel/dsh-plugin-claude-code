/** Live session phases. A generation that enters INVALID does not return to READY. */
export type SessionPhase =
  | 'NEW'
  | 'STARTING'
  | 'READY'
  | 'GENERATING'
  | 'WAITING_FOR_RESULTS'
  | 'INVALID'
  | 'CLOSED'

/**
 * Owned session records. This milestone stores no live process.
 * `closeOwned` is safe to call more than once.
 */
export class SessionManager {
  private readonly phases = new Map<string, SessionPhase>()

  size(): number {
    return this.phases.size
  }

  closeOwned(): void {
    this.phases.clear()
  }
}
