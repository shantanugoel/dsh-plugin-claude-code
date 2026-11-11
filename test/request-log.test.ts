import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { retentionProofAccepted } from '../src/evidence.js'
import {
  MAX_REQUEST_EVIDENCE_BYTES,
  RequestEvidenceCapture,
  expectedNativeTools,
} from '../src/request-log.js'

const CLI_AGENT = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const SYSTEM_PROMPT = 'Use the host tools.'
const MODEL = 'claude-haiku-5-5'
const TOOLS = expectedNativeTools([{ name: 'dsh__echo', description: 'Echo text.', parameters: { type: 'object' } }])

const temporaryDirectories: string[] = []

function diagnosticsDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-request-log-test-'))
  temporaryDirectories.push(directory)
  return directory
}

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stream: true,
    model: MODEL,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.319.793; cc_entrypoint=sdk-ts; cch=00' },
      { type: 'text', text: CLI_AGENT },
      { type: 'text', text: SYSTEM_PROMPT },
    ],
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>Private CLI context.</system-reminder>' },
          { type: 'text', text: 'hello' },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: '# Environment\nSynthetic.' }] },
    ],
    ...overrides,
  }
}

/** Write one SDK request record and return the capture that reads it. */
function writeConverted(
  directory: string,
  body: Record<string, unknown>,
  servedModel = MODEL,
  retryMs = 100,
): { capture: RequestEvidenceCapture; filename: string } {
  const filename = `${temporaryDirectories.length}-${Date.now()}.request.json`
  writeFileSync(join(directory, filename), JSON.stringify(body))
  const response = 'probe.response.json'
  writeFileSync(join(directory, response), JSON.stringify({ type: 'message', content: [] }))
  const index = join(directory, 'index.jsonl')
  const entries = [
    { timestamp: '2026-11-11T00:00:00.000Z', session_id: 's1', query_source: 'generate_session_title', model: MODEL, request_file: 'title.request.json', response_file: response },
    { timestamp: '2026-11-11T00:00:01.000Z', session_id: 's1', query_source: 'sdk', model: MODEL, request_file: filename, response_file: response },
  ]
  writeFileSync(index, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  writeFileSync(join(directory, 'title.request.json'), JSON.stringify({ stream: true, model: MODEL, system: [], tools: [], messages: [] }))
  const capture = new RequestEvidenceCapture({
    diagnosticsDir: directory,
    workspace: '/tmp/workspace',
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    requestedModel: 'haiku',
  })
  capture.noteServedModel(servedModel)
  capture.recordUserInput([{ type: 'text', text: 'hello' }])
  void retryMs
  return { capture, filename }
}

test('expected tool names use the native MCP server prefix', () => {
  assert.deepEqual(TOOLS, [{ name: 'mcp__dsh__dsh__echo', description: 'Echo text.', input_schema: { type: 'object' } }])
})

test('a complete SDK request record becomes accepted evidence', async () => {
  const directory = diagnosticsDir()
  const { capture } = writeConverted(directory, baseBody())
  const evidence = await capture.capture()
  assert.ok(evidence !== undefined)
  assert.equal(retentionProofAccepted(evidence), true)
  const record = evidence as { body: { model: string; tools: unknown[]; messages: unknown[] } }
  assert.equal(record.body.model, MODEL)
  assert.equal(record.body.tools.length, 1)
  assert.ok(record.body.messages.length > 0)
})

test('an earlier signed assistant response must reappear byte for byte', async () => {
  const directory = diagnosticsDir()
  const responseBlocks = [
    { type: 'thinking', thinking: '', signature: 'synthetic-signature-one' },
    { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__dsh__echo', input: {} },
  ]
  const second = baseBody({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: responseBlocks },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'echo' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  })
  const { capture } = writeConverted(directory, second)
  capture.recordToolResult({ callId: 'toolu_1', content: [{ type: 'text', text: 'echo' }], isError: false })
  capture.recordAssistantResponse(responseBlocks)
  capture.recordUserInput([{ type: 'text', text: 'again' }])
  const evidence = await capture.capture()
  assert.equal(retentionProofAccepted(evidence), true)
})

test('a changed signature fails the retention comparison', async () => {
  const directory = diagnosticsDir()
  const changed = baseBody({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'synthetic-signature-two' }] },
    ],
  })
  const { capture } = writeConverted(directory, changed)
  capture.recordAssistantResponse([{ type: 'thinking', thinking: '', signature: 'synthetic-signature-one' }])
  assert.equal(await capture.capture(), undefined)
})

test('a missing request record reports unavailable without a throw', async () => {
  const directory = diagnosticsDir()
  const capture = new RequestEvidenceCapture({
    diagnosticsDir: directory,
    workspace: '/tmp/workspace',
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    requestedModel: 'haiku',
  })
  capture.noteServedModel(MODEL)
  capture.recordUserInput([{ type: 'text', text: 'hello' }])
  assert.equal(await capture.capture({ retryMs: 50 }), undefined)
})

test('an unknown extra tool fails the tool comparison', async () => {
  const directory = diagnosticsDir()
  const body = baseBody({
    tools: [
      ...TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
      { name: 'advisor', description: 'Unexpected tool.', input_schema: { type: 'object' } },
    ],
  })
  const { capture } = writeConverted(directory, body)
  assert.equal(await capture.capture(), undefined)
})

test('the documented inert placeholder is accepted and kept in the record', async () => {
  const directory = diagnosticsDir()
  const body = baseBody({
    tools: [
      { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', input_schema: { type: 'object' } },
      ...TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    ],
  })
  const { capture } = writeConverted(directory, body)
  const evidence = await capture.capture()
  assert.equal(retentionProofAccepted(evidence), true)
  const record = evidence as { body: { tools: { name: string }[] } }
  assert.equal(record.body.tools[0]?.name, 'DeferredToolPlaceholder')
})

test('a changed system prompt fails the system comparison', async () => {
  const directory = diagnosticsDir()
  const body = baseBody({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.319.793' },
      { type: 'text', text: 'An unknown added instruction.' },
      { type: 'text', text: SYSTEM_PROMPT },
    ],
  })
  const { capture } = writeConverted(directory, body)
  assert.equal(await capture.capture(), undefined)
})

test('a model that the CLI did not report fails the model comparison', async () => {
  const directory = diagnosticsDir()
  const { capture } = writeConverted(directory, baseBody(), 'claude-sonnet-5-0')
  assert.equal(await capture.capture(), undefined)
})

test('redacted, truncated, non-streaming, or oversize records are unavailable', async () => {
  for (const patch of [
    { redacted: true },
    { truncated: true },
    { stream: false },
    { model: '' },
  ]) {
    const directory = diagnosticsDir()
    const { capture } = writeConverted(directory, baseBody(patch))
    assert.equal(await capture.capture({ retryMs: 50 }), undefined, JSON.stringify(patch))
  }
  const directory = diagnosticsDir()
  const oversized = baseBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(MAX_REQUEST_EVIDENCE_BYTES) }] }] })
  const { capture } = writeConverted(directory, oversized)
  assert.equal(await capture.capture({ retryMs: 50 }), undefined)
})

test('an image content block makes the audit unavailable until it is measured', async () => {
  const directory = diagnosticsDir()
  const { capture } = writeConverted(directory, baseBody())
  capture.recordUserInput([{ type: 'text', text: 'hello' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }])
  assert.equal(await capture.capture(), undefined)
})

test('a thread delta request is reconstructed with the earlier messages', async () => {
  const directory = diagnosticsDir()
  // First request: complete shape and a signed assistant tool use.
  const firstResponse = { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'thinking', thinking: '', signature: 'sig-one' }, { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__dsh__echo', input: {} }] }
  writeFileSync(join(directory, 'first.request.json'), JSON.stringify(baseBody({ thread: { type: 'create' } })))
  writeFileSync(join(directory, 'first.response.json'), JSON.stringify(firstResponse))
  // Second request: only the delta, with the thread reference.
  const secondBody = {
    model: MODEL,
    stream: true,
    thread: { type: 'continue', previous_message_id: 'msg_1' },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.319.793' }],
    tools: [],
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'echo' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  }
  writeFileSync(join(directory, 'second.request.json'), JSON.stringify(secondBody))
  writeFileSync(join(directory, 'second.response.json'), JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'done' }] }))
  writeFileSync(join(directory, 'index.jsonl'), [
    { query_source: 'sdk', request_file: 'first.request.json', response_file: 'first.response.json' },
    { query_source: 'sdk', request_file: 'second.request.json', response_file: 'second.response.json' },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const capture = new RequestEvidenceCapture({
    diagnosticsDir: directory,
    workspace: '/tmp/workspace',
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    requestedModel: 'haiku',
  })
  capture.noteServedModel(MODEL)
  capture.recordUserInput([{ type: 'text', text: 'hello' }])
  assert.equal(retentionProofAccepted(await capture.capture()), true)
  capture.recordAssistantResponse(firstResponse.content)
  capture.recordToolResult({ callId: 'toolu_1', content: [{ type: 'text', text: 'echo' }], isError: false })
  capture.recordUserInput([{ type: 'text', text: 'again' }])
  const second = await capture.capture()
  assert.equal(retentionProofAccepted(second), true)
  const record = second as { body: { messages: unknown[]; thread?: unknown } }
  // Two first-request messages (user plus the CLI environment message), the pinned
  // assistant response, and the two delta messages.
  assert.equal(record.body.messages.length, 5)
})

test('capture removes raw files that later turns do not need', async () => {
  const directory = diagnosticsDir()
  const { capture, filename } = writeConverted(directory, baseBody())
  const evidence = await capture.capture()
  assert.ok(evidence !== undefined)
  // The title request file was before the consumed SDK request and is removed.
  assert.throws(() => statSync(join(directory, 'title.request.json')))
  // The consumed request file stays for this turn and the next capture.
  assert.ok(readFileSync(join(directory, filename), 'utf8').length > 0)
  assert.equal(statSync(join(directory, 'index.jsonl')).size > 0, true)
})
