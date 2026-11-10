import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import { LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'

import { runAuthProcess, type SpawnLike } from '../src/auth-process.js'
import {
  assertSettingsSafe,
  buildChildEnvironment,
  interpretAuthStatus,
} from '../src/auth.js'
import { UnresolvedWorkspace } from '../src/context.js'
import { Config } from '../src/index.js'
import { INFERENCE_SCOPE } from '../src/route.js'
import {
  evaluateSpendProof,
  EvidenceSpendGate,
  ProductionSpendGate,
  type SpendProof,
} from '../src/spend-gate.js'
import { textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { RecordingRunner, SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

const NOW = new Date('2026-11-10T00:00:00.000Z')

function proof(binding: string, overrides: Partial<SpendProof> = {}): SpendProof {
  return {
    policyId: 'proof-1',
    identityBinding: binding,
    scope: INFERENCE_SCOPE,
    expiresAt: '2026-11-10T01:00:00.000Z',
    validFor: 'pt1h',
    ...overrides,
  }
}

async function refuse(model: { stream(options: GenerateOptions): AsyncIterable<unknown> }, request = textRequest()): Promise<unknown> {
  try {
    await model.stream(request)[Symbol.asyncIterator]().next()
  } catch (error) {
    return error
  }
  throw new Error('The stream did not refuse.')
}

test('a credential helper or billing setting blocks the auth command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-claude-settings-'))
  const helper = join(directory, 'settings.json')
  writeFileSync(helper, JSON.stringify({ apiKeyHelper: 'print-key' }))
  const runtime = new ScriptedNativeRuntime()
  const runner = new RecordingRunner({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(undefined, NOW),
    runner,
    settingsFiles: [helper],
  })
  const error = await refuse(model)
  assert.ok(error instanceof LlmError)
  assert.equal(error.code, 'AUTH_ROUTE_REFUSED')
  assert.equal(runner.calls.length, 0)
  assert.equal(runtime.starts.length, 0)

  const override = join(directory, 'override.json')
  writeFileSync(override, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }))
  assert.throws(() => assertSettingsSafe([override]), (caught: unknown) => {
    assert.ok(caught instanceof LlmError)
    assert.equal(caught.code, 'AUTH_ROUTE_REFUSED')
    return true
  })
})

test('auth and spend refusals do not start the native runtime', async () => {
  const runtime = new ScriptedNativeRuntime()
  const badAuth = new RecordingRunner({
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      orgId: 'org-synthetic',
    }),
    exitCode: 0,
  })
  const denied = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof('ignored'), NOW),
    runner: badAuth,
  })
  const authError = await refuse(denied.model)
  assert.ok(authError instanceof LlmError)
  assert.equal(authError.code, 'AUTH_ROUTE_REFUSED')
  assert.equal(badAuth.calls.length, 1)
  assert.deepEqual(badAuth.calls[0]?.args, ['auth', 'status'])
  assert.equal(badAuth.calls[0]?.env['ANTHROPIC_API_KEY'], undefined)
  assert.equal(runtime.starts.length, 0)

  const missingWorkspace = new ScriptedNativeRuntime()
  const quiet = new RecordingRunner({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const unresolved = makeAdapter({
    runtime: missingWorkspace,
    spendGate: new EvidenceSpendGate(proof('binding'), NOW),
    runner: quiet,
    workspace: new UnresolvedWorkspace(),
  })
  const workspaceError = await refuse(unresolved.model)
  assert.ok(workspaceError instanceof LlmError)
  assert.equal(workspaceError.code, 'UNSUPPORTED_INPUT')
  assert.equal(quiet.calls.length, 0)
  assert.equal(missingWorkspace.starts.length, 0)

  const titled = new ScriptedNativeRuntime()
  const titleRunner = new RecordingRunner({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const titleAdapter = makeAdapter({
    runtime: titled,
    spendGate: new EvidenceSpendGate(proof('binding'), NOW),
    runner: titleRunner,
  })
  const titleError = await refuse(titleAdapter.model, { ...textRequest(), purpose: 'title' } as GenerateOptions)
  assert.ok(titleError instanceof LlmError)
  assert.equal(titleError.code, 'UNSUPPORTED_INPUT')
  assert.equal(titleRunner.calls.length, 0)
  assert.equal(titled.starts.length, 0)
})

test('spend proof must match the account, scope, and expiry', () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const valid = evaluateSpendProof({
    proof: proof(accepted.identityBinding),
    identityBinding: accepted.identityBinding,
    scope: INFERENCE_SCOPE,
    now: NOW,
  })
  assert.equal(valid.allowed, true)

  const stale = evaluateSpendProof({
    proof: proof(accepted.identityBinding, { expiresAt: '2026-11-09T00:00:00.000Z' }),
    identityBinding: accepted.identityBinding,
    scope: INFERENCE_SCOPE,
    now: NOW,
  })
  assert.deepEqual(stale, { allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' })

  const otherAccount = evaluateSpendProof({
    proof: proof('different-binding'),
    identityBinding: accepted.identityBinding,
    scope: INFERENCE_SCOPE,
    now: NOW,
  })
  assert.equal(otherAccount.allowed, false)

  const production = new ProductionSpendGate()
  return production.decide({
    provider: 'claude-code-session',
    model: 'claude-haiku-5-5',
    purpose: 'conversation',
    identityBinding: accepted.identityBinding,
    scope: INFERENCE_SCOPE,
  }).then((decision) => {
    assert.deepEqual(decision, { allowed: false, code: 'BILLING_GUARD_UNAVAILABLE' })
  })
})

test('a valid test proof reaches only the scripted runtime', async () => {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('ok'))
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
  })
  const chunks = []
  for await (const chunk of model.stream(textRequest())) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  assert.equal(finish.reason.kind, 'stop')
  assert.deepEqual(runtime.inputs, [{ text: 'hello' }])
  assert.equal(runtime.closeCount, 0)
})

test('the auth process runner does not use a shell', async () => {
  let options: SpawnOptions | undefined
  const spawnImpl: SpawnLike = (command, args, spawnOptions) => {
    options = spawnOptions
    assert.equal(command, 'claude')
    assert.deepEqual([...args], ['auth', 'status'])
    const child = new EventEmitter() as ChildProcess
    const stdout = new Readable({ read() {} })
    child.stdout = stdout
    child.kill = () => true
    process.nextTick(() => {
      stdout.push(Buffer.from(SYNTHETIC_AUTH_STATUS))
      stdout.push(null)
      child.emit('close', 0)
    })
    return child
  }
  const result = await runAuthProcess({
    executable: 'claude',
    args: ['auth', 'status'],
    env: buildChildEnvironment({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret-token' }, '/tmp/isolated-home'),
    cwd: '/tmp/workspace',
  }, 1_000, spawnImpl)
  assert.equal(options?.shell, false)
  assert.equal(options?.env?.['ANTHROPIC_API_KEY'], undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.includes('secret-token'), false)
})

test('the settings schema has no paid-usage switch', () => {
  const output = Config({}) as Record<string, unknown>
  assert.equal(Object.hasOwn(output, 'allowPaidUsage'), false)
})
