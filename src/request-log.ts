import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson } from './canonical.js'
import { DSH_MCP_SERVER } from './sdk-plan.js'
import type { NativeContentBlock, NativeToolResult } from './sdk-runtime.js'

/** Largest request or evidence record this module keeps. Never truncate signed content. */
export const MAX_REQUEST_EVIDENCE_BYTES = 1_048_576

/** Prefix of the CLI billing and attribution header block. It is not model instructions. */
const CLI_BILLING_BLOCK = 'x-anthropic-billing-header:'
/** The CLI's own agent prompt block. The measurement records it as CLI-added context. */
const CLI_AGENT_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
/** A user text block that the CLI adds as context. It is not user content. */
const CLI_CONTEXT_PREFIX = '<system-reminder>'

const INDEX_FILE = 'index.jsonl'

/**
 * The CLI adds this reserved tool when deferred tool loading is active. It has
 * no operation. Design section 5 permits such a fixed inert placeholder only
 * when its complete definition is recorded and it cannot perform anything.
 * The recorded tool list is kept in the evidence record without changes.
 */
const CLI_INERT_PLACEHOLDER = 'DeferredToolPlaceholder'
const CLI_INERT_PLACEHOLDER_DESCRIPTION = 'Reserved placeholder that keeps deferred tool loading active; never call this tool.'

interface BaselineShape {
  readonly system: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly model: string
}

interface RequestRecord {
  readonly body: Record<string, unknown>
  readonly response: Record<string, unknown> | undefined
}
const DEFAULT_RETRY_MS = 3_000
const RETRY_STEP_MS = 100

/** One line of the CLI raw-body index. */
export interface RawBodyIndexEntry {
  readonly timestamp?: unknown
  readonly session_id?: unknown
  readonly query_source?: unknown
  readonly model?: unknown
  readonly request_id?: unknown
  readonly request_file?: unknown
  readonly response_file?: unknown
}

/** Expected native tool definition: the recorded form of one dsh MCP tool. */
export interface ExpectedNativeTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

/** One assistant response that the caller observed. The blocks are the original native data. */
export interface ExpectedAssistantResponse {
  readonly blocks: readonly unknown[]
}

/** The conversation prefix that a valid request record must contain. */
export interface ExpectedConversation {
  readonly userTexts: readonly string[]
  readonly assistantResponses: readonly ExpectedAssistantResponse[]
  readonly toolCallIds: readonly string[]
  readonly toolResultIds: readonly string[]
}

/** Input for one evidence capture. */
export interface RequestEvidenceInput {
  readonly diagnosticsDir: string
  readonly workspace: string
  readonly systemPrompt: string
  readonly tools: readonly ExpectedNativeTool[]
  readonly requestedModel: string
}

/** Expected recorded tool form for one dsh MCP tool list. */
export function expectedNativeTools(
  tools: readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }[],
): ExpectedNativeTool[] {
  return tools.map((tool) => ({
    name: `mcp__${DSH_MCP_SERVER}__${tool.name}`,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

/** Create a private directory for the raw request bodies of one native generation. */
export function createDiagnosticsDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-claude-evidence-'))
}

/** Remove a diagnostics directory. Best effort: a cleanup error does not fail the turn. */
export function removeDiagnosticsDir(directory: string | undefined): void {
  if (directory === undefined) return
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // The directory stays private. A later close attempt or the OS temporary sweep removes it.
  }
}

/**
 * Record the native requests of one generation from the CLI raw-body diagnostic.
 *
 * The CLI writes one request body for each `/v1/messages` call when
 * `OTEL_LOG_RAW_API_BODIES=file:<dir>`. The plugin sets that diagnostic itself
 * and reads the files from its private directory. This class keeps the
 * conversation prefix that every later request must contain and compares a new
 * request record against it.
 */
export class RequestEvidenceCapture {
  private readonly input: RequestEvidenceInput
  private readonly userTexts: string[] = []
  private readonly assistantResponses: ExpectedAssistantResponse[] = []
  private readonly toolCallIds: string[] = []
  private readonly toolResultIds: string[] = []
  private servedModel: string | undefined
  private consumedRequests = 0
  private unsupportedContent = false
  private failure: string | undefined
  private baseline: BaselineShape | undefined
  private previousFullMessages: readonly unknown[] | undefined
  private previousAssistant: unknown
  private previousResponseId: string | undefined

  constructor(input: RequestEvidenceInput) {
    this.input = input
  }

  noteServedModel(model: string | undefined): void {
    if (model !== undefined && model.trim() !== '') this.servedModel = model
  }

  recordUserInput(content: readonly NativeContentBlock[]): void {
    for (const block of content) {
      if (block.type === 'text') this.userTexts.push(block.text)
      else this.unsupportedContent = true
    }
  }

  recordToolResult(result: NativeToolResult): void {
    for (const block of result.content) {
      if (block.type !== 'text') this.unsupportedContent = true
    }
    this.toolCallIds.push(result.callId)
    this.toolResultIds.push(result.callId)
  }

  recordAssistantResponse(blocks: readonly unknown[]): void {
    this.assistantResponses.push({ blocks })
  }

  /**
   * Read the next SDK request record and return a complete evidence record when
   * every expected value agrees. Return undefined for a missing, incomplete,
   * redacted, truncated, oversize, or mismatched record. A missing audit is not
   * a turn failure.
   */
  /** The first failed check of the last capture attempt. It stays private data. */
  get lastFailure(): string | undefined {
    return this.failure
  }

  async capture(options: { retryMs?: number } = {}): Promise<unknown | undefined> {
    this.failure = 'no SDK request record'
    const deadline = Date.now() + (options.retryMs ?? DEFAULT_RETRY_MS)
    while (Date.now() <= deadline) {
      const index = this.readIndex()
      const sdkEntries = index.filter((entry) => entry.query_source === 'sdk')
      const entry = sdkEntries[this.consumedRequests]
      if (entry !== undefined && typeof entry.request_file === 'string') {
        const raw = this.readRecord(entry.request_file, entry.response_file)
        if (raw !== undefined) {
          this.consumedRequests += 1
          this.prune(index, entry)
          return this.verify(this.assemble(raw))
        }
      }
      await sleep(RETRY_STEP_MS)
    }
    return undefined
  }

  private readIndex(): RawBodyIndexEntry[] {
    const filename = join(this.input.diagnosticsDir, INDEX_FILE)
    if (!existsSync(filename)) return []
    let text: string
    try {
      text = readFileSync(filename, 'utf8')
    } catch {
      return []
    }
    const entries: RawBodyIndexEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const entry = JSON.parse(line) as unknown
        if (isRecord(entry)) entries.push(entry as RawBodyIndexEntry)
      } catch {
        // A write in progress leaves a partial last line. The retry reads it again.
      }
    }
    return entries
  }

  private readRecord(requestFile: string, responseFile: unknown): RequestRecord | undefined {
    const filename = join(this.input.diagnosticsDir, requestFile)
    if (!existsSync(filename)) return undefined
    try {
      if (statSync(filename).size > MAX_REQUEST_EVIDENCE_BYTES) return undefined
      const body = JSON.parse(readFileSync(filename, 'utf8')) as unknown
      if (!isRecord(body)) return undefined
      return { body, response: this.readResponse(responseFile) }
    } catch {
      return undefined
    }
  }

  private readResponse(responseFile: unknown): Record<string, unknown> | undefined {
    if (typeof responseFile !== 'string') return undefined
    const filename = join(this.input.diagnosticsDir, responseFile)
    if (!existsSync(filename)) return undefined
    try {
      if (statSync(filename).size > MAX_REQUEST_EVIDENCE_BYTES) return undefined
      const response = JSON.parse(readFileSync(filename, 'utf8')) as unknown
      return isRecord(response) ? response : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Assemble the complete request. The CLI beta `message-threads-2026-08-12`
   * sends the first request complete and each later request as a thread delta.
   * A delta request omits system, tools, and the earlier messages. The plugin
   * keeps the latest complete values and the last response message, so the exact
   * native request is reconstructable from the recorded files. An unknown shape
   * makes the audit unavailable.
   */
  private assemble(raw: RequestRecord): unknown {
    const body = raw.body
    const thread = isRecord(body['thread']) ? body['thread'] : undefined
    const threadType = typeof thread?.['type'] === 'string' ? thread['type'] : undefined
    const model = typeof body['model'] === 'string' ? body['model'] : undefined
    const system = Array.isArray(body['system']) ? body['system'] : undefined
    const tools = Array.isArray(body['tools']) ? body['tools'] : undefined
    const messages = Array.isArray(body['messages']) ? body['messages'] : undefined
    if (messages === undefined) return body
    let full: Record<string, unknown>
    if (threadType === 'create' || threadType === undefined || threadType === 'continue_no_save') {
      if (system === undefined || tools === undefined || model === undefined) return body
      full = { ...body }
      this.baseline = { system, tools, model }
      this.previousFullMessages = messages
    } else if (threadType === 'continue') {
      const baseline = this.baseline
      if (baseline === undefined || this.previousFullMessages === undefined
        || this.previousAssistant === undefined || this.previousResponseId === undefined) return body
      if (thread?.['previous_message_id'] !== this.previousResponseId) return body
      const assembledMessages = [...this.previousFullMessages, this.previousAssistant, ...messages]
      full = {
        ...body,
        model: model ?? baseline.model,
        system: baseline.system,
        tools: baseline.tools,
        messages: assembledMessages,
      }
      this.previousFullMessages = assembledMessages
    } else {
      return body
    }
    const response = raw.response
    // The response reports the served native model. The CLI init message does
    // not always carry it. The comparison needs this independent native value.
    if (this.servedModel === undefined && response !== undefined && typeof response['model'] === 'string') {
      this.noteServedModel(response['model'])
    }
    if (response !== undefined && typeof response['id'] === 'string') {
      this.previousResponseId = response['id']
      this.previousAssistant = {
        role: 'assistant',
        content: Array.isArray(response['content']) ? response['content'] : [],
      }
    }
    return full
  }

  /**
   * Remove raw files that no later capture needs. A file that belongs to this
   * request or to a later index entry stays: the next turn reads it. The evidence
   * record keeps the model-visible request only.
   */
  private prune(index: readonly RawBodyIndexEntry[], current: RawBodyIndexEntry): void {
    const cutoff = index.indexOf(current)
    if (cutoff <= 0) return
    for (let position = 0; position < cutoff; position += 1) {
      const entry = index[position]
      if (entry === undefined) continue
      for (const key of ['request_file', 'response_file'] as const) {
        const value = entry[key]
        if (typeof value !== 'string') continue
        try {
          rmSync(join(this.input.diagnosticsDir, value), { force: true })
        } catch {
          // Keep the private file. The generation close removes the directory.
        }
      }
    }
  }

  private fail(reason: string): undefined {
    this.failure = reason
    if (process.env['DSH_EVIDENCE_DEBUG'] === '1') console.error('[request-evidence]', reason)
    return undefined
  }

  private verify(record: unknown): unknown | undefined {
    if (this.unsupportedContent) return this.fail('unsupported image content')
    if (!isRecord(record)) return this.fail('record is not an object')
    if (record['redacted'] === true) return this.fail('record is redacted')
    if (record['truncated'] === true) return this.fail('record is truncated')
    if (record['stream'] !== true) return this.fail('record is not a stream request')
    const model = record['model']
    if (typeof model !== 'string' || model.trim() === '') return this.fail('record has no model')
    const system = record['system']
    const tools = record['tools']
    const messages = record['messages']
    if (!Array.isArray(system) || !Array.isArray(tools) || !Array.isArray(messages)) return this.fail('record has no system, tools, or messages')
    if (messages.length === 0) return this.fail('record has no messages')
    if (!this.systemAgrees(system)) return this.fail('system prompt differs')
    if (!this.toolsAgree(tools)) return this.fail('tool list differs')
    if (!this.modelAgrees(model)) return this.fail('model differs')
    if (!this.messagesAgree(messages)) return this.fail('earlier message prefix differs')
    const body = {
      model,
      system,
      tools,
      messages,
    }
    const evidence = {
      status: 'complete',
      redacted: false,
      truncated: false,
      source: 'claude-otel-raw-api-body',
      body,
    }
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_REQUEST_EVIDENCE_BYTES) return this.fail('evidence is oversize')
    this.failure = undefined
    return evidence
  }

  /**
   * The recorded system prompt must hold the replaced dsh prompt byte for byte.
   * The CLI adds its billing header and its own agent prompt. No other block is
   * accepted: an unknown added instruction makes the audit unavailable.
   */
  private systemAgrees(system: readonly unknown[]): boolean {
    let replacedPromptCount = 0
    for (const block of system) {
      if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return false
      const text = block['text']
      if (text === this.input.systemPrompt) {
        replacedPromptCount += 1
        continue
      }
      if (text.startsWith(CLI_BILLING_BLOCK)) continue
      if (text === CLI_AGENT_PROMPT) continue
      return false
    }
    return replacedPromptCount === 1
  }

  /**
   * The recorded tool list must contain the dsh MCP tools in launch order. The
   * CLI may add one documented inert placeholder. Its complete definition must
   * match, and the evidence record keeps it. Any other tool fails the audit.
   */
  private toolsAgree(tools: readonly unknown[]): boolean {
    let start = 0
    const first = tools[0]
    if (isRecord(first) && first['name'] === CLI_INERT_PLACEHOLDER) {
      if (first['description'] !== CLI_INERT_PLACEHOLDER_DESCRIPTION) return false
      start = 1
    }
    if (tools.length - start !== this.input.tools.length) return false
    for (let offset = 0; offset < this.input.tools.length; offset += 1) {
      const index = start + offset
      const recorded = tools[index]
      const expected = this.input.tools[offset] as ExpectedNativeTool
      if (!isRecord(recorded)) return false
      if (recorded['name'] !== expected.name) return false
      if (recorded['description'] !== expected.description) return false
      if (canonicalJson(normalizeToolSchema(recorded['input_schema'])) !== canonicalJson(normalizeToolSchema(expected.input_schema))) return false
    }
    return true
  }

  /**
   * The recorded model is the CLI-resolved native id. The launch plan holds the
   * catalog value. The CLI reports the resolved id at initialization, so the
   * record must equal that value. No other model was served for this session.
   */
  private modelAgrees(model: string): boolean {
    // The init message reports the native model id for this CLI process. A title
    // call in the same process reports the same id. The recorded model must never
    // be a different model.
    return this.servedModel !== undefined && model === this.servedModel
  }

  /**
   * Retained pinned content: every earlier assistant response must reappear
   * byte for byte, including thinking signatures and tool call ids. Every text
   * the user sent must reappear. Every earlier tool call must have its result.
   * CLI-added context blocks and CLI environment messages are not user content
   * and are ignored for this comparison.
   */
  private messagesAgree(messages: readonly unknown[]): boolean {
    const recordedAssistant: unknown[][] = []
    const recordedUserTexts: string[] = []
    const recordedToolResultIds = new Set<string>()
    for (const message of messages) {
      if (!isRecord(message)) return false
      const role = message['role']
      const content = message['content']
      if (!Array.isArray(content)) return false
      if (role === 'system') continue
      if (role === 'assistant') {
        recordedAssistant.push(content)
        continue
      }
      if (role !== 'user') return false
      for (const block of content) {
        if (!isRecord(block)) return false
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          if (!block['text'].startsWith(CLI_CONTEXT_PREFIX)) recordedUserTexts.push(block['text'])
          continue
        }
        if (block['type'] === 'tool_result') {
          if (typeof block['tool_use_id'] === 'string') recordedToolResultIds.add(block['tool_use_id'])
          continue
        }
        return false
      }
    }
    // Assistant retention needs independent expected data. The first turn has none.
    if (recordedAssistant.length !== this.assistantResponses.length) return false
    for (let index = 0; index < this.assistantResponses.length; index += 1) {
      const expected = this.assistantResponses[index] as ExpectedAssistantResponse
      const recorded = recordedAssistant[index]
      if (recorded === undefined || canonicalJson(recorded.map(normalizeAssistantBlock)) !== canonicalJson(expected.blocks.map(normalizeAssistantBlock))) {
        return false
      }
    }
    if (!containsInOrder(recordedUserTexts, this.userTexts)) return false
    for (const callId of this.toolCallIds) {
      if (!recordedToolResultIds.has(callId)) return false
    }
    return true
  }
}

/**
 * The MCP layer adds a `$schema` reference and an empty `properties` map to a
 * tool schema. These do not change the schema: an object with no declared
 * fields stays an open JSON object. Compare the declared content only.
 */
function normalizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolSchema)
  if (value === null || typeof value !== 'object') return value
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue
    copy[key] = normalizeToolSchema(child)
  }
  if (copy['type'] === 'object') {
    const properties = copy['properties']
    if (isRecord(properties) && Object.keys(properties).length === 0) delete copy['properties']
  }
  return copy
}

/** Remove response-only fields that the CLI adds to a tool call block. */
function normalizeAssistantBlock(block: unknown): unknown {
  if (!isRecord(block)) return block
  if (block['type'] !== 'tool_use') return block
  const { caller: _caller, ...rest } = block
  return rest
}

function containsInOrder(haystack: readonly string[], needles: readonly string[]): boolean {
  let position = 0
  for (const value of needles) {
    const found = haystack.indexOf(value, position)
    if (found === -1) return false
    position = found + 1
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** List the files in a diagnostics directory. Tests and live probes use this. */
export function diagnosticsFiles(directory: string): string[] {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}
