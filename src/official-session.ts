import { accessSync, constants, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pluginFailure } from './errors.js'
import { RequestEvidenceCapture, expectedNativeTools, removeDiagnosticsDir } from './request-log.js'
import {
  advanceAssistantTurn,
  eventsFromResult,
  foldTurnEvents,
  newNativeTurn,
  readToolUseId,
  type NativeTurnState,
} from './sdk-events.js'
import { zodShapeForTool } from './sdk-schema.js'
import { DSH_MCP_SERVER, PINNED_SDK_VERSION } from './sdk-plan.js'
import type {
  NativeContentBlock,
  NativeEvent,
  NativeImageMediaType,
  NativeSession,
  NativeSessionConfig,
  NativeUserInput,
} from './sdk-runtime.js'

interface SdkQuery {
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<OfficialMessage>
}

interface SdkTextContent {
  readonly type: 'text'
  readonly text: string
}

interface SdkImageContent {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64'
    readonly media_type: NativeImageMediaType
    readonly data: string
  }
}

type SdkUserContent = string | (SdkTextContent | SdkImageContent)[]

interface SdkUserMessage {
  readonly type: 'user'
  readonly message: {
    readonly role: 'user'
    readonly content: SdkUserContent
  }
  readonly parent_tool_use_id: null
}

interface OfficialModelUsage {
  readonly contextWindow?: unknown
  readonly maxOutputTokens?: unknown
  readonly canonicalModel?: unknown
}

interface OfficialMessage {
  readonly type?: string
  readonly subtype?: string
  readonly session_id?: string
  readonly claude_code_version?: string
  readonly tools?: readonly string[]
  readonly stop_reason?: string | null
  readonly is_error?: boolean
  readonly api_error_status?: number | null
  /** Native model id that the CLI reports at initialization. */
  readonly model?: string
  /** Native error text of an is_error success result. */
  readonly result?: string
  /** Error list of an SDKResultError. */
  readonly errors?: readonly unknown[]
  /** Error value of an SDKAssistantMessage. */
  readonly error?: string
  /** Per-model capacity of the SDK result message. */
  readonly modelUsage?: Readonly<Record<string, OfficialModelUsage>>
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
  readonly message?: {
    readonly id?: string
    readonly content?: readonly Record<string, unknown>[]
    readonly stop_reason?: string | null
    readonly usage?: {
      readonly input_tokens?: number
      readonly output_tokens?: number
      readonly cache_read_input_tokens?: number
      readonly cache_creation_input_tokens?: number
    }
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
  const capture = launch.diagnosticsDir === undefined
    ? undefined
    : new RequestEvidenceCapture({
      diagnosticsDir: launch.diagnosticsDir,
      workspace: launch.cwd,
      systemPrompt: launch.systemPrompt.prompt,
      tools: expectedNativeTools(launch.mcpTools),
      requestedModel: launch.model,
    })
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
      capture?.recordToolResult(result)
      return {
        content: result.content.map((block) => block.type === 'text'
          ? { type: 'text' as const, text: block.text }
          : {
            type: 'image' as const,
            data: block.data,
            mimeType: block.mediaType,
          }),
        isError: result.isError,
      }
    },
  ))
  const server = sdk.createSdkMcpServer({
    name: DSH_MCP_SERVER,
    version: packageVersion(),
    // Never defer the dsh tools behind tool search. A deferred tool set adds the
    // CLI placeholder tool to the native request and hides the real tool list.
    alwaysLoad: true,
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
      ...(launch.effort === undefined ? {} : { effort: launch.effort }),
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
  const consumer = consume(query, queue, identity, launch.model, capture)
  consumer.catch((error: unknown) => {
    queue.fail(error)
  })
  return {
    identity,
    events: queue,
    sendUser: (user) => {
      capture?.recordUserInput(user.content)
      return input.push(user)
    },
    sendMidTurnUser: (user) => {
      capture?.recordUserInput(user.content)
      return input.push(user)
    },
    continueAfterResults: () => Promise.resolve(),
    isClosed: () => queue.closed,
    async close() {
      input.close()
      query.close()
      queue.close()
      await consumer.catch(() => undefined)
      removeDiagnosticsDir(launch.diagnosticsDir)
    },
  }
}

async function consume(
  query: SdkQuery,
  queue: EventQueue,
  identity: { cliSessionId: string; cliVersion: string },
  requestedModel: string,
  capture: RequestEvidenceCapture | undefined,
): Promise<void> {
  let turn: NativeTurnState = newNativeTurn()
  let latestAssistantError: unknown
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') identity.cliSessionId = message.session_id
      if (typeof message.claude_code_version === 'string') identity.cliVersion = message.claude_code_version
      if (typeof message.model === 'string') capture?.noteServedModel(message.model)
      if (message.tools !== undefined) queue.push({ type: 'native-tool-list', names: message.tools })
      continue
    }
    if (message.type === 'assistant' && message.message !== undefined) {
      // A completed assistant stop ends one native turn. The next assistant
      // message starts a new turn with its own usage.
      if (turn.stopSent) turn = { ...turn, stopSent: false, usageSent: false, blockCount: 0 }
      if (typeof message.error === 'string' && message.error.trim() !== '') latestAssistantError = message.error
      const advanced = advanceAssistantTurn(turn, message.message)
      if (advanced.events.some((event) => event.type === 'message-stop')) {
        // The request record for this response is complete before the response
        // stream ends. Publish the audit before the dsh stop event, so the dsh
        // finish stores the accepted or unavailable audit for this exact turn.
        await appendEvidence(queue, capture)
        capture?.recordAssistantResponse(assistantNativeBlocks(advanced.events), typeof message.message.id === 'string' ? message.message.id : undefined)
      }
      for (const event of advanced.events) queue.push(event)
      turn = advanced.state
      continue
    }
    if (message.type === 'result') {
      const resultEvents = eventsFromResult(message, {
        messageId: turn.messageId,
        stopSent: turn.stopSent,
        ...(latestAssistantError === undefined ? {} : { latestAssistantError }),
      })
      latestAssistantError = undefined
      const folded = foldTurnEvents(turn, resultEvents)
      if (folded.events.some((event) => event.type === 'message-stop')) await appendEvidence(queue, capture)
      const failed = folded.events.some((event) => event.type === 'turn-error')
      for (const event of folded.events) queue.push(event)
      turn = folded.state
      if (failed) {
        // The adapter fails the turn with the mapped code and closes this
        // generation. No later event belongs to it.
        queue.close()
        return
      }
      // The capacity event is informational. The native-error path above owns
      // the turn outcome, so a failed result reports no capacity for this turn.
      const usageEvent = modelUsageEvent(message, requestedModel)
      if (usageEvent !== undefined) queue.push(usageEvent)
      continue
    }
  }
  queue.close()
}


/** Publish one request-evidence event when the capture passes its checks. */
async function appendEvidence(queue: EventQueue, capture: RequestEvidenceCapture | undefined): Promise<void> {
  if (capture === undefined) return
  const record = await capture.capture()
  if (record !== undefined) queue.push({ type: 'request-evidence', record })
}

/**
 * Build the original native assistant blocks from one response's events. These
 * are the independent expected values for the next request's retained prefix.
 */
function assistantNativeBlocks(events: readonly NativeEvent[]): unknown[] {
  const blocks: unknown[] = []
  for (const event of events) {
    if (event.type === 'block-start' && event.blockType === 'reasoning') {
      continue
    }
    if (event.type !== 'block-snapshot') continue
    if (event.blockType === 'text') blocks.push({ type: 'text', text: event.text ?? '' })
    else if (event.blockType === 'reasoning') blocks.push(event.signature === undefined
      ? { type: 'thinking', thinking: event.text ?? '' }
      : { type: 'thinking', thinking: event.text ?? '', signature: event.signature })
    else if (event.blockType === 'redacted-thinking') blocks.push({ type: 'redacted_thinking', data: event.redactedData ?? '' })
    else if (event.blockType === 'tool-call') blocks.push({
      type: 'tool_use',
      id: event.id ?? '',
      name: event.name ?? '',
      input: parseArguments(event.argumentsText),
    })
  }
  return blocks
}

function parseArguments(value: string | undefined): unknown {
  if (value === undefined || value.trim() === '') return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/**
 * Read the capacity of the requested model from one SDK result message.
 * The SDK keys `modelUsage` by the served model string. A single entry is used
 * when no key or canonical id matches the requested model. Two or more
 * unmatched entries are not attributed, because the result cannot prove which
 * one answered the requested model.
 */
function modelUsageEvent(message: OfficialMessage, requestedModel: string): NativeEvent | undefined {
  const usage = message.modelUsage
  if (usage === undefined) return undefined
  const entries = Object.entries(usage)
  const exact = entries.filter(([key, entry]) => key === requestedModel || entry?.canonicalModel === requestedModel)
  const entry = exact.length === 1 ? exact[0] : entries.length === 1 ? entries[0] : undefined
  if (entry === undefined) return undefined
  const [nativeModel, values] = entry
  const contextWindow = positiveInteger(values?.contextWindow)
  const maxOutputTokens = positiveInteger(values?.maxOutputTokens)
  if (contextWindow === undefined || maxOutputTokens === undefined) return undefined
  return {
    type: 'model-usage',
    model: requestedModel,
    nativeModel,
    contextWindow,
    maxOutputTokens,
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function createInputQueue(): {
  readonly messages: AsyncIterable<SdkUserMessage>
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
            message: { role: 'user' as const, content: sdkUserContent(next.content) },
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

/**
 * Build the Messages API user content. A text-only input stays a string, which
 * is the same shape the persistent input queue sent before image support.
 */
function sdkUserContent(content: readonly NativeContentBlock[]): SdkUserContent {
  if (content.every((block) => block.type === 'text')) {
    return content.map((block) => block.type === 'text' ? block.text : '').join('')
  }
  return content.map((block) => block.type === 'text'
    ? { type: 'text' as const, text: block.text }
    : {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: block.mediaType, data: block.data },
    })
}

class EventQueue implements AsyncIterable<NativeEvent> {
  private readonly events: NativeEvent[] = []
  private readonly waiters: Array<() => void> = []
  private closedState = false
  private failure: unknown

  push(event: NativeEvent): void {
    if (this.closedState) return
    this.events.push(event)
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.closedState = true
    this.wake()
  }

  close(): void {
    this.closedState = true
    this.wake()
  }

  get closed(): boolean {
    return this.closedState
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeEvent> {
    return {
      next: async () => {
        while (this.events.length === 0 && !this.closedState) {
          await new Promise<void>((resolve) => {
            if (this.events.length > 0 || this.closedState) resolve()
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
