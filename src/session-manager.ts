import { withDeadline, type Deadlines } from './deadlines.js'
import { pluginFailure } from './errors.js'
import type { McpBridge } from './mcp-bridge.js'
import type { NativeEvent, NativeSession } from './sdk-runtime.js'
import type { PendingToolCall } from './stream.js'
import type { CanonicalMessage, PendingPublication } from './transcript.js'

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
  readonly sessionId: string
  readonly generationId: string
  readonly auxiliary: boolean
  phase: SessionPhase
  readonly native: NativeSession
  readonly bridge: McpBridge
  readonly iterator: AsyncIterator<NativeEvent>
  readonly model: string
  readonly workspace: string
  readonly systemPrompt: string
  readonly toolsCanonical: string
  readonly toolNameMap: Readonly<Record<string, string>>
  readonly nativeToDsh: ReadonlyMap<string, string>
  readonly dshNames: ReadonlySet<string>
  readonly allowedNativeTools: ReadonlySet<string>
  readonly deadlines: Deadlines
  pendingCalls: readonly PendingToolCall[]
  committed: readonly CanonicalMessage[]
  pending: PendingPublication | undefined
  dispatchedHash: string | undefined
}

/**
 * Owned native sessions. Close is safe to call more than once.
 */
export class SessionManager {
  private readonly live = new Map<string, LiveGeneration>()
  private readonly admitting = new Set<string>()
  private readonly generationCount = new Map<string, number>()

  size(): number {
    return this.live.size
  }

  get(key: string): LiveGeneration | undefined {
    return this.live.get(key)
  }

  conversation(sessionId: string): LiveGeneration | undefined {
    for (const session of this.live.values()) {
      if (!session.auxiliary && session.sessionId === sessionId && session.phase !== 'CLOSED') return session
    }
    return undefined
  }

  insert(session: LiveGeneration): void {
    this.live.set(session.key, session)
  }

  /** Allocate the next generation id for one dsh session. */
  nextGeneration(sessionId: string): string {
    const next = (this.generationCount.get(sessionId) ?? 0) + 1
    this.generationCount.set(sessionId, next)
    return String(next)
  }

  /** Reserve one key before the first await. A second admission fails closed. */
  tryAdmit(key: string): void {
    const live = this.live.get(key)
    if (this.admitting.has(key) || live?.phase === 'GENERATING' || live?.phase === 'STARTING') {
      throw pluginFailure('SESSION_BUSY', 'This native session already has an active stream.')
    }
    this.admitting.add(key)
  }

  endAdmit(key: string): void {
    this.admitting.delete(key)
  }

  async closeKey(key: string): Promise<void> {
    const session = this.live.get(key)
    if (session === undefined) return
    this.live.delete(key)
    session.phase = 'CLOSED'
    session.bridge.cancel('The native session closed before the tool result was delivered.')
    await withDeadline(
      session.native.close(),
      session.deadlines.closeMs,
      'NATIVE_OUTCOME_UNKNOWN',
      'The native session did not close before the deadline.',
    )
  }

  async closeOwned(): Promise<void> {
    const sessions = [...this.live.values()]
    this.live.clear()
    await Promise.all(sessions.map(async (session) => {
      session.phase = 'CLOSED'
      session.bridge.cancel('The native session closed before the tool result was delivered.')
      await withDeadline(
        session.native.close(),
        session.deadlines.closeMs,
        'NATIVE_OUTCOME_UNKNOWN',
        'The native session did not close before the deadline.',
      )
    }))
  }
}
