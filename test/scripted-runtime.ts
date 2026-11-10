import type {
  NativeEvent,
  NativeRuntime,
  NativeSession,
  NativeSessionConfig,
  NativeToolResult,
  NativeUserInput,
} from '../src/sdk-runtime.js'

export interface ScriptedTurn {
  readonly events: readonly NativeEvent[]
  invokeHandlers?: (call: (callId: string) => Promise<NativeToolResult>) => Promise<void>
}

/**
 * In-memory native session. It records calls and makes no network request.
 * Production registration does not use this class.
 */
export class ScriptedNativeSession implements NativeSession {
  readonly inputs: NativeUserInput[] = []
  private readonly queue: NativeEvent[] = []
  private readonly waiters: Array<() => void> = []
  private closed = false

  private callTool: ((callId: string) => Promise<NativeToolResult>) | undefined

  constructor(private readonly runtime: ScriptedNativeRuntime) {}

  bind(config: NativeSessionConfig): void {
    this.callTool = config.callTool
  }

  emit(event: NativeEvent): void {
    if (this.closed) {
      throw new Error('The scripted session is closed.')
    }
    this.queue.push(event)
    this.wake()
  }

  readonly events: AsyncIterable<NativeEvent> = {
    [Symbol.asyncIterator]: (): AsyncGenerator<NativeEvent> => this.iterate(),
  }

  async sendUser(input: NativeUserInput): Promise<void> {
    if (this.closed) {
      throw new Error('The scripted session is closed.')
    }
    const copy = { text: input.text }
    this.inputs.push(copy)
    this.runtime.inputs.push(copy)
    this.play(this.runtime.takeTurn())
  }

  async continueAfterResults(): Promise<void> {
    if (this.closed) {
      throw new Error('The scripted session is closed.')
    }
    this.play(this.runtime.takeTurn())
  }

  private play(turn: ScriptedTurn | undefined): void {
    if (turn === undefined) return
    for (const event of turn.events) this.emit(event)
    if (turn.invokeHandlers !== undefined && this.callTool !== undefined) {
      void turn.invokeHandlers(this.callTool)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.runtime.closeCount += 1
    this.wake()
  }

  private async *iterate(): AsyncGenerator<NativeEvent> {
    while (true) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }
}

export class ScriptedNativeRuntime implements NativeRuntime {
  readonly starts: NativeSessionConfig[] = []
  readonly inputs: NativeUserInput[] = []
  readonly sessions: ScriptedNativeSession[] = []
  private readonly turns: ScriptedTurn[] = []
  closeCount = 0

  enqueue(turn: ScriptedTurn): void {
    this.turns.push(turn)
  }

  takeTurn(): ScriptedTurn | undefined {
    return this.turns.shift()
  }

  start(config: NativeSessionConfig): Promise<ScriptedNativeSession> {
    this.starts.push({
      workspace: config.workspace,
      model: config.model,
      systemPrompt: config.systemPrompt,
    })
    const session = new ScriptedNativeSession(this)
    session.bind(config)
    this.sessions.push(session)
    return Promise.resolve(session)
  }
}
