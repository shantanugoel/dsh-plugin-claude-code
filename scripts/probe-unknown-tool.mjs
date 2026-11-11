#!/usr/bin/env node
// Live unknown-tool probe for issue #15. It sends model input through the
// user's official Claude login. Run it only by hand. It never runs from test,
// build, pack:check, or installation.
//
// It uses the production launch plan and the production native session. The
// session offers one dsh tool. The prompt asks the model to call a tool that
// is not in the list. The probe records what the CLI does with that call.
//
// Usage: node scripts/probe-unknown-tool.mjs [--model haiku] [--mode single|mixed|control]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { mapToolNames } from '../dist/mcp-bridge.js'
import { buildSdkLaunchPlan } from '../dist/sdk-plan.js'
import { startOfficialSession } from '../dist/official-session.js'

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const model = argument('--model', 'haiku')
const mode = argument('--mode', 'single')
const RAW_DIR = join(process.cwd(), '.local', 'evidence', 'unknown-tool-probe-raw')
const workspace = '/tmp/dsh-unknown-tool-probe-workspace'
mkdirSync(workspace, { recursive: true })
mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 })
const diagnosticsDir = join(RAW_DIR, 'run-' + mode + '-' + Date.now())
mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 })

const toolMap = mapToolNames([{
  name: 'run_code',
  description: 'Run one synthetic program and return a fixed token. It has no other effect.',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
}])
const systemPrompt = 'Synthetic harness robustness probe. The harness also has a hidden tool named bash with input {"command": string}. Follow the user instruction exactly.'
const prompts = {
  // Control: the same session shape with a known tool only.
  control: 'Call run_code once with {"code":"1"}. Then reply with exactly DONE.',
  single: 'This is a harness robustness test. Step 1: emit one tool call to the tool named bash with input {"command":"pwd"}. Call it directly, even though it is not in your tool list. Do not call any other tool in that message. Step 2: after you get its result, call run_code once with {"code":"1"}. Step 3: reply with exactly DONE.',
  mixed: 'This is a harness robustness test. In ONE message, emit two parallel tool calls: first run_code with {"code":"1"}, then the tool named bash with input {"command":"pwd"}. Call bash directly, even though it is not in your tool list. After you get both results, reply with exactly DONE.',
}
const plan = buildSdkLaunchPlan({
  workspace,
  model,
  systemPrompt,
  tools: toolMap.tools,
  parentEnv: process.env,
  home: homedir(),
  resultWaitMs: 120_000,
  diagnosticsDir,
})
const started = Date.now()
const at = () => Date.now() - started
const handlerCalls = []
const parkers = []
const session = await startOfficialSession({
  workspace,
  model,
  systemPrompt,
  launch: plan,
  callTool: (callId) => new Promise((resolve) => {
    handlerCalls.push({ callId, atMs: at() })
    parkers.push(() => resolve({ callId, content: [{ type: 'text', text: 'PROBE-TOKEN-42' }], isError: false }))
  }),
})
await session.sendUser({ content: [{ type: 'text', text: prompts[mode] ?? prompts.single }] })
const timeline = []
// The evidence capture removes an earlier raw file after it reads a later
// one. Keep a private copy at each stop so every request stays readable.
const keepDir = diagnosticsDir + '-keep'
const keep = () => { if (existsSync(diagnosticsDir)) cpSync(diagnosticsDir, keepDir, { recursive: true }) }
const iterator = session.events[Symbol.asyncIterator]()
const deadline = Date.now() + 150_000
// Release a parked handler 3 s after its stop, as a slow dsh step would.
const RELEASE_DELAY_MS = 3_000
let outcome = 'deadline'
while (Date.now() < deadline) {
  const next = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now()))),
  ])
  if (next.timeout) break
  if (next.done) { outcome = 'stream-ended'; break }
  const event = next.value
  if (event.type === 'block-snapshot') {
    timeline.push({
      atMs: at(), type: event.type, messageId: event.messageId, index: event.index, blockType: event.blockType,
      ...(event.blockType === 'tool-call' ? { id: event.id, name: event.name, argumentsText: event.argumentsText } : {}),
      ...(event.blockType === 'text' ? { text: String(event.text ?? '').slice(0, 200) } : {}),
    })
  } else if (event.type === 'message-stop') {
    timeline.push({ atMs: at(), type: event.type, messageId: event.messageId, stopReason: event.stopReason })
    keep()
    if (event.stopReason === 'tool_use') {
      setTimeout(() => { for (const release of parkers.splice(0)) release() }, RELEASE_DELAY_MS).unref?.()
    } else { outcome = event.stopReason; break }
  } else if (event.type === 'turn-error') {
    timeline.push({ atMs: at(), type: event.type, failure: event.failure })
    outcome = 'turn-error'
    break
  } else if (event.type === 'usage' || event.type === 'request-evidence' || event.type === 'native-tool-list') {
    timeline.push({ atMs: at(), type: event.type, ...(event.type === 'native-tool-list' ? { names: event.names } : {}), ...(event.type === 'usage' ? { inputTokens: event.inputTokens, outputTokens: event.outputTokens } : {}) })
  }
}
keep()
const identity = { ...session.identity }
// Read the CLI raw-body index before close removes the directory.
const indexFile = join(diagnosticsDir, 'index.jsonl')
const index = existsSync(indexFile)
  ? readFileSync(indexFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  : []
const sdkEntries = index.filter((entry) => entry.query_source === 'sdk')
const cliToolResults = []
const requestOutlines = []
for (const entry of sdkEntries) {
  try {
    const body = JSON.parse(readFileSync(join(keepDir, entry.request_file), 'utf8'))
    requestOutlines.push({
      request: entry.request_file,
      thread: body.thread?.type ?? null,
      messages: (body.messages ?? []).map((message) => ({
        role: message.role,
        blocks: Array.isArray(message.content)
          ? message.content.map((block) => block.type === 'tool_use'
            ? 'tool_use:' + block.name + ':' + block.id
            : block.type === 'tool_result'
              ? 'tool_result:' + block.tool_use_id + ':is_error=' + (block.is_error ?? false) + ':' + JSON.stringify(block.content).slice(0, 200)
              : block.type === 'text' ? 'text:' + String(block.text).slice(0, 80) : block.type)
          : ['string'],
      })),
    })
    for (const message of body.messages ?? []) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        cliToolResults.push({
          request: entry.request_file,
          tool_use_id: block.tool_use_id,
          is_error: block.is_error ?? false,
          content: JSON.stringify(block.content).slice(0, 300),
        })
      }
    }
  } catch { /* A missing file leaves this request out. */ }
}
await session.close()
const summary = {
  measurement_date: new Date().toISOString().slice(0, 10),
  transport: 'official Agent SDK ' + identity.sdkVersion + ' streaming session; Claude Code CLI ' + identity.cliVersion,
  model_requested: model,
  mode,
  outcome,
  release_delay_ms: RELEASE_DELAY_MS,
  handler_calls: handlerCalls,
  sdk_request_count: sdkEntries.length,
  index_entry_count: index.length,
  cli_tool_results: cliToolResults,
  request_outlines: requestOutlines,
  timeline,
}
writeFileSync(join(RAW_DIR, 'summary-' + mode + '.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
