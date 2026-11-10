import { accessSync, constants, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pluginFailure } from './errors.js'
import { eventsFromAssistant, readToolUseId } from './sdk-events.js'
import { zodShapeForTool } from './sdk-schema.js'
import { DSH_MCP_SERVER, PINNED_SDK_VERSION } from './sdk-plan.js'
import type {
  NativeEvent,
  NativeSession,
  NativeSessionConfig,
  NativeUserInput,
} from './sdk-runtime.js'

interface SdkQuery {
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<OfficialMessage>
}

interface OfficialMessage {
  readonly type?: string
  readonly subtype?: string
  readonly session_id?: string
  readonly claude_code_version?: string
  readonly tools?: readonly string[]
  readonly stop_reason?: string | null
  readonly is_error?: boolean
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  readonly message?: {
    readonly id?: string
    readonly content?: readonly Record<string, unknown>[]
    readonly stop_reason?: string | null
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  }
}

/**
 * Start one official Agent SDK query. The offline suite does not call this.
 * A missing extra-usage lock does not stop the start.
 */
export async function startOfficialSession(config: NativeSessionConfig): Promise<NativeSession> {
  const launch = config.launch
  if (launch === undefined) {
    throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The native session has no launch plan.')
  }
  const executable = findClaudeExecutable(launch.env['PATH'])
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const tools = launch.mcpTools.map((tool) => sdk.tool(
    tool.name,
    tool.description,
    zodShapeForTool(tool.parameters),
    async (_args, extra) => {
      const callId = readToolUseId(extra)
      if (callId === undefined || config.callTool === undefined) {
        throw pluginFailure('TOOL_RESULT_MISMATCH', 'The native tool call has no call id.')
      }
      const result = await config.callTool(callId)
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      }
    },
  ))
  const server = sdk.createSdkMcpServer({
    name: DSH_MCP_SERVER,
    version: packageVersion(),
    tools,
    timeout: launch.mcpTimeoutMs,
  })
  const input = createInputQueue()
  const query = sdk.query({
    prompt: input.messages,
    options: {
      cwd: launch.cwd,
      model: launch.model,
      systemPrompt: launch.systemPrompt,
      tools: [],
      settingSources: [],
      includePartialMessages: true,
      strictMcpConfig: true,
      mcpServers: { [DSH_MCP_SERVER]: server },
      plugins: [],
      skills: [],
      verbatimPrompts: true,
      promptSuggestions: false,
      permissionMode: 'dontAsk',
      allowedTools: [...launch.allowedToolNames],
      enableFileCheckpointing: false,
      env: { ...launch.env },
      settings: launch.settings,
      pathToClaudeCodeExecutable: executable,
    },
  }) as SdkQuery
  const identity = {
    cliSessionId: 'pending',
    cliVersion: 'pending',
    sdkVersion: PINNED_SDK_VERSION,
  }
  const queue = new EventQueue()
  const consumer = consume(query, queue, identity)
  consumer.catch((error: unknown) => {
    queue.fail(error)
  })
  return {
    identity,
    events: queue,
    sendUser: (user) => input.push(user),
    continueAfterResults: () => Promise.resolve(),
    async close() {
      input.close()
      query.close()
      queue.close()
      await consumer.catch(() => undefined)
    },
  }
}

async function consume(
  query: SdkQuery,
  queue: EventQueue,
  identity: { cliSessionId: string; cliVersion: string },
): Promise<void> {
  let stopSent = false
  let messageId = 'assistant'
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') identity.cliSessionId = message.session_id
      if (typeof message.claude_code_version === 'string') identity.cliVersion = message.claude_code_version
      if (message.tools !== undefined) queue.push({ type: 'native-tool-list', names: message.tools })
      continue
    }
    if (message.type === 'assistant' && message.message !== undefined) {
      if (stopSent) stopSent = false
      let hasTool = false
      for (const event of eventsFromAssistant(message.message)) {
        if (event.type === 'message-stop') {
          stopSent = true
          messageId = event.messageId
        }
        if (event.type === 'block-snapshot') {
          messageId = event.messageId
          if (event.blockType === 'tool-call') hasTool = true
        }
        queue.push(event)
      }
      if (hasTool && !stopSent) {
        queue.push({ type: 'message-stop', messageId, stopReason: 'tool_use' })
        stopSent = true
      }
      continue
    }
    if (message.type === 'result') {
      if (message.subtype !== undefined && message.subtype !== 'success') {
        queue.fail(pluginFailure('MALFORMED_RESPONSE', 'The native session reported a turn error.'))
        return
      }
      if (stopSent) continue
      const inputTokens = message.usage?.input_tokens
      const outputTokens = message.usage?.output_tokens
      if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        queue.push({ type: 'usage', inputTokens, outputTokens })
      }
      const stopReason = message.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn'
      queue.push({ type: 'message-stop', messageId, stopReason })
      stopSent = true
    }
  }
  queue.close()
}

function createInputQueue(): {
  readonly messages: AsyncIterable<{ type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null }>
  push(input: NativeUserInput): Promise<void>
  close(): void
} {
  const pending: NativeUserInput[] = []
  let closed = false
  let wake: (() => void) | undefined
  return {
    messages: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const next = pending.shift()
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              if (pending.length > 0 || closed) resolve()
              else wake = resolve
            })
            continue
          }
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: next.text },
            parent_tool_use_id: null,
          }
        }
      },
    },
    push(input) {
      if (closed) return Promise.reject(pluginFailure('NATIVE_OUTCOME_UNKNOWN', 'The native session is closed.'))
      pending.push(input)
      wake?.()
      wake = undefined
      return Promise.resolve()
    },
    close() {
      closed = true
      wake?.()
    },
  }
}

class EventQueue implements AsyncIterable<NativeEvent> {
  private readonly events: NativeEvent[] = []
  private readonly waiters: Array<() => void> = []
  private closed = false
  private failure: unknown

  push(event: NativeEvent): void {
    if (this.closed) return
    this.events.push(event)
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.closed = true
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeEvent> {
    return {
      next: async () => {
        while (this.events.length === 0 && !this.closed) {
          await new Promise<void>((resolve) => {
            if (this.events.length > 0 || this.closed) resolve()
            else this.waiters.push(resolve)
          })
        }
        if (this.failure !== undefined) throw this.failure
        const value = this.events.shift()
        if (value === undefined) return { done: true, value: undefined }
        return { done: false, value }
      },
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }
}

function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (manifest.name === 'dsh-plugin-claude-code' && typeof manifest.version === 'string' && manifest.version.trim() !== '') {
        return manifest.version
      }
    } catch {
      // Look in the parent directory. The compiled file sits below the package root.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The package version is missing.')
}

export function findClaudeExecutable(pathValue: string | undefined): string {
  const directories = (pathValue ?? '').split(':').filter((entry) => entry.trim() !== '')
  for (const directory of directories) {
    const candidate = join(directory, 'claude')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The official Claude executable is not on PATH.')
}
