#!/usr/bin/env node
// Live unknown-tool probe through the production adapter, for issue #15. It
// sends model input through the user's official Claude login. Run it only by
// hand. It never runs from test, build, pack:check, or installation.
//
// The script takes the place of the dsh agent loop. It reads each adapter
// stream, records the published tool calls, and answers them: a fixed token
// for the dsh tool, and an error result for a tool outside the tool list. It
// does not run dsh, so the dsh error text here is a synthetic stand-in.
//
// Usage: node scripts/probe-unknown-tool-adapter.mjs [--model haiku] [--mode single|mixed]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ClaudeCodeAdapter } from '../dist/adapter.js'
import { AuthGuard, ProcessHome } from '../dist/auth.js'
import { createProcessAuthRunner } from '../dist/auth-process.js'
import { DEFAULT_DEADLINES } from '../dist/deadlines.js'
import { CLAUDE_CODE_SESSION_ROUTE } from '../dist/route.js'
import { SdkNativeRuntime } from '../dist/sdk-runtime.js'
import { SessionManager } from '../dist/session-manager.js'
import { ProductionSpendGate } from '../dist/spend-gate.js'

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const model = argument('--model', 'haiku')
const mode = argument('--mode', 'single')
const RAW_DIR = join(process.cwd(), '.local', 'evidence', 'unknown-tool-probe-raw')
const workspace = '/tmp/dsh-unknown-tool-probe-workspace'
mkdirSync(workspace, { recursive: true })
mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 })

const tools = [{
  name: 'run_code',
  description: 'Run one synthetic program and return a fixed token. It has no other effect.',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
}]
const system = 'Synthetic harness robustness probe. The harness also has a hidden tool named bash with input {"command": string}. Follow the user instruction exactly.'
const prompts = {
  single: 'This is a harness robustness test. Step 1: emit one tool call to the tool named bash with input {"command":"pwd"}. Call it directly, even though it is not in your tool list. Do not call any other tool in that message. Step 2: after you get its result, call run_code once with {"code":"1"}. Step 3: reply with exactly DONE.',
  mixed: 'This is a harness robustness test. In ONE message, emit two parallel tool calls: first run_code with {"code":"1"}, then the tool named bash with input {"command":"pwd"}. Call bash directly, even though it is not in your tool list. After you get both results, reply with exactly DONE.',
}
const sessions = new SessionManager()
const adapter = new ClaudeCodeAdapter({
  runtime: new SdkNativeRuntime(),
  spendGate: new ProductionSpendGate(),
  sessions,
  workspace: { current: () => workspace },
  auth: new AuthGuard(createProcessAuthRunner()),
  home: new ProcessHome(),
  parentEnv: () => process.env,
  deadlines: DEFAULT_DEADLINES,
  attachments: () => undefined,
})
const sessionId = 'unknown-tool-probe-' + Date.now()
const messages = [{ role: 'user', content: [{ type: 'text', text: prompts[mode] ?? prompts.single }] }]
const steps = []
const started = Date.now()
let outcome = 'step-limit'
let failure
// A dsh step takes time before it returns a result. The CLI answers an unknown
// tool sooner than this delay, so its next response is ready first.
const STEP_DELAY_MS = 3_000
try {
  for (let step = 1; step <= 8; step += 1) {
    const blocks = []
    let finish
    for await (const chunk of adapter.stream({ provider: CLAUDE_CODE_SESSION_ROUTE, model, sessionId, system, tools, messages })) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk
    }
    const response = finish?.replayState?.response ?? {}
    const calls = blocks.filter((block) => block.type === 'tool-call')
    steps.push({
      step,
      atMs: Date.now() - started,
      finish: finish?.reason,
      generationId: response.generationId,
      retentionAudit: response.retentionAudit,
      unknownToolNames: response.unknownToolNames ?? [],
      blocks: blocks.map((block) => block.type === 'tool-call'
        ? { type: block.type, name: block.name, arguments: block.arguments }
        : { type: block.type, textLength: String(block.text ?? '').length, ...(block.type === 'text' ? { text: String(block.text).slice(0, 80) } : {}) }),
    })
    messages.push({
      role: 'assistant',
      id: 'assistant-' + step,
      content: blocks,
      source: { kind: 'model', provider: CLAUDE_CODE_SESSION_ROUTE, model, replayState: finish?.replayState },
    })
    if (finish?.reason?.kind !== 'tool-calls') {
      outcome = finish?.reason?.kind ?? 'no-finish'
      break
    }
    await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS))
    for (const call of calls) {
      const known = call.name === 'run_code'
      messages.push({
        role: 'tool',
        id: 'result-' + call.id,
        toolCallId: call.id,
        isError: !known,
        content: [{ type: 'text', text: known ? 'PROBE-TOKEN-42' : 'unknown tool ' + call.name + ': only run_code is callable directly' }],
        source: { kind: 'tool', callId: call.id },
      })
    }
  }
} catch (error) {
  outcome = 'failure'
  failure = { code: error?.code, message: String(error?.message ?? error) }
}
const liveSessions = adapter.ownedSessionCount()
await adapter.closeOwnedSessions()
const summary = {
  measurement_date: new Date().toISOString().slice(0, 10),
  layer: 'production adapter with a script in the place of the dsh agent loop',
  model_requested: model,
  mode,
  outcome,
  ...(failure === undefined ? {} : { failure }),
  step_delay_ms: STEP_DELAY_MS,
  native_sessions_at_end: liveSessions,
  steps,
}
writeFileSync(join(RAW_DIR, 'summary-adapter-' + mode + '.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
