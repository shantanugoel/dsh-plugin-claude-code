#!/usr/bin/env node
// Live two-turn request-evidence probe. It sends model input through the user's
// official Claude login. Run it only by hand. It never runs from test, build,
// pack:check, or installation.
//
// It uses the production launch plan and the production native session, so the
// request-evidence audit seen here is the audit the plugin stores.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { mapToolNames } from '../dist/mcp-bridge.js'
import { diagnosticsFiles } from '../dist/request-log.js'
import { buildSdkLaunchPlan } from '../dist/sdk-plan.js'
import { startOfficialSession } from '../dist/official-session.js'

const RAW_DIR = join(process.cwd(), '.local', 'evidence', 'request-evidence-probe-raw')
const workspace = '/tmp/dsh-request-evidence-probe-workspace'
mkdirSync(workspace, { recursive: true })
mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 })

const toolMap = mapToolNames([{
  name: 'probe_token',
  description: 'Return one fixed synthetic token. It has no other effect.',
  parameters: { type: 'object' },
}])
const systemPrompt = 'Synthetic request-evidence probe. Follow the user instruction exactly. Use the given tool when the user asks for a token.'
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'haiku'
const diagnosticsDir = join(RAW_DIR, `run-${Date.now()}`)
mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 })
const plan = buildSdkLaunchPlan({
  workspace,
  model,
  systemPrompt,
  tools: toolMap.tools,
  parentEnv: process.env,
  home: homedir(),
  resultWaitMs: 120_000,
  effort: 'high',
  diagnosticsDir,
})
const parkers = []
const session = await startOfficialSession({
  workspace,
  model,
  systemPrompt,
  launch: plan,
  callTool: (callId) => new Promise((resolve) => {
    parkers.push({ callId, resolve: () => resolve({ callId, content: [{ type: 'text', text: 'PROBE-TOKEN-42' }], isError: false }) })
  }),
})
await session.sendUser({
  content: [{ type: 'text', text: 'Call the probe_token tool exactly once. Then reply with exactly the token it returned.' }],
})
const events = []
const evidence = []
const iterator = session.events[Symbol.asyncIterator]()
const deadline = Date.now() + 180_000
let released = false
while (Date.now() < deadline) {
  const next = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now()))),
  ])
  if (next.timeout || next.done) break
  const event = next.value
  events.push(event)
  if (event.type === 'request-evidence') evidence.push(event.record)
  if (event.type === 'turn-error') break
  if (event.type === 'message-stop' && event.stopReason === 'tool_use' && !released) {
    released = true
    // Release the parked result only after the first dsh turn stopped, exactly
    // as the plugin does when dsh supplies the recorded result.
    for (const parker of parkers.splice(0)) parker.resolve()
    continue
  }
  if (released && event.type === 'message-stop' && event.stopReason === 'end_turn') break
}
const identity = { ...session.identity }
// Keep a private raw copy before close removes the generation directory.
if (existsSync(diagnosticsDir)) cpSync(diagnosticsDir, join(RAW_DIR, 'diagnostics'), { recursive: true })
await session.close()

const thinking = events
  .filter((event) => event.type === 'block-snapshot' && event.blockType === 'reasoning')
  .map((event) => ({ textLength: (event.text ?? '').length, signatureLength: (event.signature ?? '').length, signature: event.signature ?? '' }))
const audits = evidence.map((record) => {
  const typed = record
  const body = typed?.body ?? {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  const assistantBlocks = messages.flatMap((message) => message?.role === 'assistant' && Array.isArray(message.content) ? message.content : [])
  const signatures = assistantBlocks.filter((block) => block?.type === 'thinking').map((block) => String(block.signature ?? ''))
  return {
    status: typed?.status,
    redacted: typed?.redacted,
    truncated: typed?.truncated,
    source: typed?.source,
    model: body.model,
    systemBlockLengths: Array.isArray(body.system) ? body.system.map((block) => String(block?.text ?? '').length) : [],
    toolNames: Array.isArray(body.tools) ? body.tools.map((tool) => tool?.name) : [],
    messageCount: messages.length,
    thinkingSignatures: signatures.map((value) => ({ length: value.length, sha256Start: value.slice(0, 12) })),
  }
})
const second = audits[1]
const retained = thinking.length > 0 && second !== undefined
  && thinking.every((block) => second.thinkingSignatures.some((item) => item.length === block.signatureLength))
const summary = {
  measurement_date: new Date().toISOString().slice(0, 10),
  transport: 'official Agent SDK 0.3.322 streaming session; Claude Code CLI 2.1.319',
  model_requested: model,
  cli_version: identity.cliVersion,
  cli_session_id_present: identity.cliSessionId !== 'pending',
  inference_turns: audits.length,
  events: events.length,
  evidence_events: evidence.length,
  audits,
  assistant_thinking_blocks: thinking.map(({ textLength, signatureLength }) => ({ textLength, signatureLength })),
  second_request_contains_first_thinking_signature: retained,
  diagnostics_files: diagnosticsFiles(diagnosticsDir).length,
  raw_capture_dir: RAW_DIR,
}
writeFileSync(join(RAW_DIR, 'summary.json'), JSON.stringify({ ...summary, diagnostics_dir: diagnosticsDir }, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
