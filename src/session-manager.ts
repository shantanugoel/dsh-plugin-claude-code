import { withDeadline, type Deadlines } from './deadlines.js'
import type { McpBridge } from './mcp-bridge.js'
import type { NativeEvent, NativeSession } from './sdk-runtime.js'
import type { PendingToolCall } from './stream.js'

/** Live session phases. A generation that enters INVALID does not return to READY. */
export type SessionPhase =
  | 'NEW'
  | 'STARTING'
  | 'READY'
  | 'GENERATING'
  | 'WAITING_FOR_RESULTS'
  | 'INVALID'
  | 'CLOSED'

export interface LiveGeneration {
  readonly key: string
  phase: SessionPhase
  readonly native: NativeSession
  readonly bridge: McpBridge
  readonly iterator: AsyncIterator<NativeEvent>
  readonly model: string
  readonly workspace: string
  readonly deadlines: Deadlines
  pendingCalls: readonly PendingToolCall[]
}

/**
 * Owned native sessions. Close is safe to call more than once.
 */
export class SessionManager {
  private readonly live = new Map<string, LiveGeneration>()

  size(): number {
    return this.live.size
  }

  get(key: string): LiveGeneration | undefined {
    return this.live.get(key)
  }

  insert(session: LiveGeneration): void {
    this.live.set(session.key, session)
  }

  async closeOwned(): Promise<void> {
    const sessions = [...this.live.values()]
    this.live.clear()
    await Promise.all(sessions.map(async (session) => {
      session.phase = 'CLOSED'
      await withDeadline(
        session.native.close(),
        session.deadlines.closeMs,
        'NATIVE_OUTCOME_UNKNOWN',
        'The native session did not close before the deadline.',
      )
    }))
  }
}
