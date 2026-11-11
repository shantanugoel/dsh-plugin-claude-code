import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import { LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'

import { runAuthProcess, type SpawnLike } from '../src/auth-process.js'
import {
  assertSettingsSafe,
  AuthGuard,
  buildChildEnvironment,
  DEFAULT_AUTH_CACHE_MS,
  interpretAuthStatus,
  type AuthCheck,
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
import { inputText, textRequest, textTurn } from './request.js'
import { ScriptedNativeRuntime } from './scripted-runtime.js'
import { acceptedRunner, RecordingRunner, SYNTHETIC_AUTH_STATUS, makeAdapter } from './support.js'

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
  const titleError = await refuse(titleAdapter.model, { ...textRequest(), purpose: 'session-title' } as GenerateOptions)
  assert.ok(titleError instanceof LlmError)
  assert.equal(titleError.code, 'BILLING_GUARD_UNAVAILABLE')
  assert.equal(titleRunner.calls.length, 1)
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
    assert.deepEqual(decision, {
      allowed: true,
      policyId: 'subscription-login',
      validFor: 'no-spend-lock',
    })
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
  assert.deepEqual(runtime.inputs.map(inputText), ['hello'])
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


function cacheInput(overrides: Partial<AuthCheck> = {}): AuthCheck {
  const home = mkdtempSync(join(tmpdir(), 'dsh-auth-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-auth-ws-'))
  return {
    workspace,
    home,
    parentEnv: { PATH: '/usr/bin', LANG: 'C', HOME: home },
    settingsFiles: [],
    ...overrides,
  }
}

test('an accepted auth check is cached for the same scope', async () => {
  const runner = acceptedRunner()
  const guard = new AuthGuard(runner, 'claude', { now: () => 1_000, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput()
  const first = await guard.check(input)
  const second = await guard.check(input)
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(second, first)
  assert.equal(first.identityBinding.length > 0, true)
})

test('the auth cache expires after its interval', async () => {
  const runner = acceptedRunner()
  let now = 1_000
  const guard = new AuthGuard(runner, 'claude', { now: () => now, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput()
  await guard.check(input)
  now += DEFAULT_AUTH_CACHE_MS - 1
  await guard.check(input)
  assert.equal(runner.calls.length, 1)
  now += 1
  await guard.check(input)
  assert.equal(runner.calls.length, 2)
})

test('a changed home, workspace, or allowlisted environment runs the auth command again', async () => {
  const runner = acceptedRunner()
  const guard = new AuthGuard(runner, 'claude', { now: () => 1_000, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput()
  await guard.check(input)
  await guard.check({ ...input, home: mkdtempSync(join(tmpdir(), 'dsh-auth-home-')) })
  assert.equal(runner.calls.length, 2)
  await guard.check({ ...input, workspace: mkdtempSync(join(tmpdir(), 'dsh-auth-ws-')) })
  assert.equal(runner.calls.length, 3)
  await guard.check({ ...input, parentEnv: { PATH: '/usr/local/bin' } })
  assert.equal(runner.calls.length, 4)
})

test('a changed settings file mtime or size runs the auth command again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-auth-settings-'))
  const settings = join(directory, 'settings.json')
  writeFileSync(settings, '{}')
  const runner = acceptedRunner()
  const guard = new AuthGuard(runner, 'claude', { now: () => 1_000, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput({ settingsFiles: [settings] })
  await guard.check(input)
  writeFileSync(settings, '{"value":1}')
  await guard.check(input)
  assert.equal(runner.calls.length, 2)
  utimesSync(settings, new Date(5_000), new Date(5_000))
  await guard.check(input)
  assert.equal(runner.calls.length, 3)
})

test('a refused auth status is not cached', async () => {
  const runner = new RecordingRunner({
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      orgId: 'org-synthetic',
    }),
    exitCode: 0,
  })
  const guard = new AuthGuard(runner, 'claude', { now: () => 1_000, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput()
  for (const attempt of [1, 2]) {
    await assert.rejects(guard.check(input), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'AUTH_ROUTE_REFUSED')
      return true
    }, `refusal ${attempt}`)
  }
  assert.equal(runner.calls.length, 2)
})

test('an expected account binding is required for a cache hit and for the result', async () => {
  const runner = acceptedRunner()
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const guard = new AuthGuard(runner, 'claude', { now: () => 1_000, ttlMs: DEFAULT_AUTH_CACHE_MS })
  const input = cacheInput()
  const first = await guard.check({ ...input, expectedIdentityBinding: accepted.identityBinding })
  await guard.check({ ...input, expectedIdentityBinding: accepted.identityBinding })
  assert.equal(runner.calls.length, 1)
  assert.equal(first.identityBinding, accepted.identityBinding)
  await assert.rejects(
    guard.check({ ...input, expectedIdentityBinding: 'different-binding' }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'AUTH_ROUTE_REFUSED')
      return true
    },
  )
  assert.equal(runner.calls.length, 2)
})

test('two streams in one auth scope run one auth command', async () => {
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('one'))
  runtime.enqueue(textTurn('two', 'm2'))
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  const runner = acceptedRunner()
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof(accepted.identityBinding), NOW),
    runner,
  })
  const collect = async (request: GenerateOptions): Promise<unknown[]> => {
    const chunks: unknown[] = []
    for await (const chunk of model.stream(request)) chunks.push(chunk)
    return chunks
  }
  await collect(textRequest('first', 'auth-scope-1'))
  await collect(textRequest('second', 'auth-scope-2'))
  assert.equal(runner.calls.length, 1)
  assert.equal(runtime.starts.length, 2)
})

test('a refused auth status runs the command again on the next stream', async () => {
  const runtime = new ScriptedNativeRuntime()
  const runner = new RecordingRunner({
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      orgId: 'org-synthetic',
    }),
    exitCode: 0,
  })
  const { model } = makeAdapter({
    runtime,
    spendGate: new EvidenceSpendGate(proof('ignored'), NOW),
    runner,
  })
  for (const attempt of [1, 2]) {
    const error = await refuse(model, textRequest('hello', `auth-refuse-${attempt}`))
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'AUTH_ROUTE_REFUSED')
  }
  assert.equal(runner.calls.length, 2)
  assert.equal(runtime.starts.length, 0)
})
