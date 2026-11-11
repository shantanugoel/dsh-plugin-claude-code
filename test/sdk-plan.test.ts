import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mapToolNames } from '../src/mcp-bridge.js'
import { buildSdkLaunchPlan, SESSION_CONTROL_ENV } from '../src/sdk-plan.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
import { interpretAuthStatus } from '../src/auth.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')

function proof(binding: string): SpendProof {
  return {
    policyId: 'proof-1',
    identityBinding: binding,
    scope: 'claude-code-session',
    expiresAt: '2026-11-10T01:00:00.000Z',
    validFor: 'pt1h',
  }
}

test('the launch plan keeps one query and only the dsh MCP server', () => {
  const tools = mapToolNames([{
    name: 'echo',
    description: 'Echo text.',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
  }])
  const plan = buildSdkLaunchPlan({
    workspace: '/tmp/workspace-a',
    model: 'claude-haiku-5-5',
    systemPrompt: 'Use the host tools.',
    tools: tools.tools,
    parentEnv: {
      PATH: '/usr/bin',
      HOME: '/tmp/parent-home',
      ANTHROPIC_API_KEY: 'secret-token',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
    },
    home: '/tmp/isolated-home',
    resultWaitMs: 3_600_000,
  })
  assert.equal(plan.queryCount, 1)
  assert.equal(plan.eventConsumers, 1)
  assert.equal(plan.inputQueue, 'streaming')
  assert.equal(plan.closeOnToolFinish, false)
  assert.equal(plan.cwd, '/tmp/workspace-a')
  assert.equal(plan.model, 'claude-haiku-5-5')
  assert.deepEqual(plan.systemPrompt, { type: 'custom', prompt: 'Use the host tools.', snapshot: true })
  assert.deepEqual(plan.tools, [])
  assert.deepEqual(plan.settingSources, [])
  assert.equal(plan.includePartialMessages, true)
  assert.equal(plan.strictMcpConfig, true)
  assert.deepEqual(plan.mcpServerNames, ['dsh'])
  assert.equal(plan.fallbackModelOmitted, true)
  assert.deepEqual(plan.plugins, [])
  assert.deepEqual(plan.skills, [])
  assert.equal(plan.verbatimPrompts, true)
  assert.equal(plan.promptSuggestions, false)
  assert.equal(plan.resumeOmitted, true)
  assert.equal(plan.continueConversation, false)
  assert.equal(plan.settings.autoCompactEnabled, false)
  assert.equal(plan.settings.disableClaudeAiConnectors, true)
  assert.equal(plan.settings.switchModelsOnFlag, false)
  assert.equal(plan.effort, undefined)
  const withEffort = buildSdkLaunchPlan({
    workspace: '/tmp/workspace-a',
    model: 'haiku',
    systemPrompt: 'Use the host tools.',
    tools: tools.tools,
    parentEnv: { PATH: '/usr/bin' },
    home: '/tmp/isolated-home',
    resultWaitMs: 3_600_000,
    effort: 'high',
  })
  assert.equal(withEffort.effort, 'high')
  assert.equal(plan.env['HOME'], '/tmp/isolated-home')
  assert.equal(plan.env['PATH'], '/usr/bin')
  assert.equal(plan.env['ANTHROPIC_API_KEY'], undefined)
  assert.equal(plan.env['ANTHROPIC_BASE_URL'], undefined)
  for (const [name, value] of Object.entries(SESSION_CONTROL_ENV)) {
    assert.equal(plan.env[name], value)
  }
  assert.equal(plan.mcpTimeoutMs, 3_600_000)
  assert.deepEqual(plan.allowedToolNames, plan.mcpToolNames.map((name) => `mcp__dsh__${name}`))
  assert.equal(plan.maxOutputTokens, undefined)
  assert.equal(plan.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], undefined)
  const withCap = buildSdkLaunchPlan({
    workspace: '/tmp/workspace-a',
    model: 'haiku',
    systemPrompt: 'Use the host tools.',
    tools: tools.tools,
    parentEnv: { PATH: '/usr/bin' },
    home: '/tmp/isolated-home',
    resultWaitMs: 3_600_000,
    maxOutputTokens: 256,
  })
  assert.equal(withCap.maxOutputTokens, 256)
  assert.equal(withCap.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '256')
})

test('an admitted scripted session receives the launch plan and stays open', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model, workspace } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
  })
  const chunks = []
  for await (const chunk of model.stream({ ...textRequest(), system: 'Host prompt.' })) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(runtime.closeCount, 0)
  assert.equal(runtime.starts.length, 1)
  const launch = runtime.starts[0]?.launch
  assert.equal(launch?.cwd, workspace)
  assert.equal(launch?.systemPrompt.prompt, 'Host prompt.')
  assert.equal(launch?.closeOnToolFinish, false)
  assert.deepEqual(launch?.tools, [])
  assert.deepEqual(launch?.mcpServerNames, ['dsh'])
})
