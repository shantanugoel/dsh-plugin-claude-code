import type {
  NativeEvent,
  NativeRuntime,
  NativeSession,
  NativeSessionConfig,
  NativeUserInput,
} from '../src/sdk-runtime.js'

/**
 * In-memory native session. It records calls and makes no network request.
 * Production registration does not use this class.
 */
export class ScriptedNativeSession implements NativeSession {
  readonly inputs: NativeUserInput[] = []
  private readonly queue: NativeEvent[] = []
  private readonly waiters: Array<() => void> = []
  private closed = false

  constructor(private readonly runtime: ScriptedNativeRuntime) {}

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
  closeCount = 0

  start(config: NativeSessionConfig): Promise<ScriptedNativeSession> {
    this.starts.push({
      workspace: config.workspace,
      model: config.model,
      systemPrompt: config.systemPrompt,
    })
    const session = new ScriptedNativeSession(this)
    this.sessions.push(session)
    return Promise.resolve(session)
  }
}
