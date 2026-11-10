import { pluginFailure } from './errors.js'
import type { NativeToolResult } from './sdk-runtime.js'

export interface ToolSchemaInput {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface MappedTool {
  readonly dshName: string
  readonly nativeName: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface ToolNameMap {
  readonly dshToNative: ReadonlyMap<string, string>
  readonly nativeToDsh: ReadonlyMap<string, string>
  readonly tools: readonly MappedTool[]
}

interface Waiter {
  readonly resolve: (result: NativeToolResult) => void
  readonly reject: (error: unknown) => void
}

/**
 * Waiting tool handlers. A result is delivered only after the full dsh batch
 * is valid, and only to the exact call id.
 */
export class McpBridge {
  private expected: readonly string[] = []
  private readonly staged = new Map<string, NativeToolResult>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly delivered = new Set<string>()
  private released = false

  wait(callId: string, timeoutMs: number): Promise<NativeToolResult> {
    if (this.delivered.has(callId) || this.waiters.has(callId)) {
      return Promise.reject(pluginFailure(
        'TOOL_RESULT_MISMATCH',
        'A tool result was delivered twice.',
      ))
    }
    const staged = this.staged.get(callId)
    if (this.released && staged !== undefined) {
      this.delivered.add(callId)
      return Promise.resolve(staged)
    }
    if (this.released) {
      return Promise.reject(pluginFailure(
        'TOOL_RESULT_MISMATCH',
        'The tool handler does not match a staged result.',
      ))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(callId)
        reject(pluginFailure(
          'NATIVE_OUTCOME_UNKNOWN',
          'The tool result wait exceeded its deadline. The generation was not retried.',
        ))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(callId, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  expect(callIds: readonly string[]): void {
    this.expected = [...callIds]
  }

  /**
   * Validate the whole suffix, then release staged results.
   * A bad suffix rejects no handler with a successful result.
   */
  stage(results: readonly NativeToolResult[]): void {
    if (this.released) {
      throw pluginFailure('TOOL_RESULT_MISMATCH', 'The tool result batch was released twice.')
    }
    if (!sameCallOrder(this.expected, results.map((result) => result.callId))) {
      throw pluginFailure(
        'TOOL_RESULT_MISMATCH',
        'The tool results do not match the pending call ids.',
      )
    }
    for (const result of results) this.staged.set(result.callId, result)
    this.released = true
    for (const [callId, waiter] of this.waiters) {
      const staged = this.staged.get(callId)
      if (staged === undefined) {
        waiter.reject(pluginFailure('TOOL_RESULT_MISMATCH', 'The tool handler has no staged result.'))
        continue
      }
      this.delivered.add(callId)
      waiter.resolve(staged)
    }
    this.waiters.clear()
  }

  get deliveryCount(): number {
    return this.delivered.size
  }
}

export function mapToolNames(tools: readonly ToolSchemaInput[]): ToolNameMap {
  const dshToNative = new Map<string, string>()
  const nativeToDsh = new Map<string, string>()
  const mapped: MappedTool[] = []
  for (const tool of tools) {
    if (tool.name.trim() === '' || tool.description.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A tool needs a name and a description.')
    }
    const parameters = losslessObjectSchema(tool.parameters)
    const nativeName = encodeToolName(tool.name)
    if (nativeName.length > 64 || dshToNative.has(tool.name) || nativeToDsh.has(nativeName)) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A tool name collides or exceeds the native name limit.')
    }
    dshToNative.set(tool.name, nativeName)
    nativeToDsh.set(nativeName, tool.name)
    mapped.push({
      dshName: tool.name,
      nativeName,
      description: tool.description,
      parameters,
    })
  }
  return { dshToNative, nativeToDsh, tools: mapped }
}

function encodeToolName(name: string): string {
  const encoded = [...name].map((character) => {
    if (/[A-Za-z0-9_-]/.test(character)) return character
    return `_${character.codePointAt(0)?.toString(16) ?? '0'}_`
  }).join('')
  return `dsh__${encoded}`
}

function losslessObjectSchema(value: Record<string, unknown>): Record<string, unknown> {
  if (value['type'] !== 'object') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema must be a JSON object schema.')
  }
  assertJsonValue(value)
  const encoded = JSON.stringify(value)
  const copy = JSON.parse(encoded) as Record<string, unknown>
  if (canonicalJson(value) !== canonicalJson(copy)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema cannot be preserved.')
  }
  return copy
}

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema contains a non-finite number.')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item)
    return
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value)) {
      if (child === undefined) throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema contains an empty value.')
      assertJsonValue(child)
    }
    return
  }
  throw pluginFailure('UNSUPPORTED_INPUT', 'A tool schema contains a value that is not JSON.')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
}

function sameCallOrder(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false
  if (new Set(actual).size !== actual.length) return false
  return expected.every((callId, index) => callId === actual[index])
}
