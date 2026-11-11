import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'

import type { ClaudeCodeAdapter } from '../src/adapter.js'
import { interpretAuthStatus } from '../src/auth.js'
import { SessionHeaderWorkspace } from '../src/context.js'
import type { SessionManager } from '../src/session-manager.js'
import { EvidenceSpendGate, type SpendProof } from '../src/spend-gate.js'
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

function gate(): EvidenceSpendGate {
  const accepted = interpretAuthStatus({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
  return new EvidenceSpendGate(proof(accepted.identityBinding), NOW)
}

async function sessionContext(): Promise<{ ctx: Context; sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', () => undefined)
  return { ctx, sessions: ctx.sessions }
}

/**
 * Create one dsh session in its own fiber. Disposing the fiber disposes only
 * that session and emits `session/disposed` for it.
 */
async function createOwnedSession(ctx: Context, id: string, cwd: string): Promise<{ dispose(): Promise<void> }> {
  return await ctx.plugin({
    name: `owned-${id}`,
    inject: ['sessions'],
    apply(child: Context) {
      child.sessions.create(SessionId(id), { meta: { cwd } })
    },
  })
}

async function collect(
  model: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
  request: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream(request)) chunks.push(chunk)
  return chunks
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('The test condition did not become true.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Mount one adapter and register the production disposal listener. */
function mount(
  runtime: ScriptedNativeRuntime,
  ctx: Context,
): {
  readonly model: ClaudeCodeAdapter
  readonly manager: SessionManager
  readonly closing: () => Promise<void> | undefined
} {
  const { model, sessions } = makeAdapter({
    runtime,
    spendGate: gate(),
    workspace: new SessionHeaderWorkspace(ctx.sessions),
  })
  let closing: Promise<void> | undefined
  ctx.on('session/disposed', (session) => {
    closing = model.closeSession(String(session.id))
  })
  return { model, manager: sessions, closing: () => closing }
}

test('a disposed session closes only its own native process', async () => {
  const { ctx } = await sessionContext()
  const fiberA = await createOwnedSession(ctx, 'dispose-a', '/tmp/dsh-ws-dispose-a')
  const fiberB = await createOwnedSession(ctx, 'dispose-b', '/tmp/dsh-ws-dispose-b')
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('alpha'))
  runtime.enqueue(textTurn('beta', 'm2'))
  const { model, manager, closing } = mount(runtime, ctx)
  await collect(model, { ...textRequest('from-a', 'dispose-a'), system: 'Prompt A' })
  await collect(model, { ...textRequest('from-b', 'dispose-b'), system: 'Prompt B' })
  assert.equal(runtime.starts.length, 2)
  assert.equal(manager.size(), 2)

  await fiberA.dispose()
  const closePromise = closing()
  assert.ok(closePromise !== undefined)
  await closePromise

  assert.equal(manager.size(), 1)
  assert.equal(manager.conversation('dispose-a'), undefined)
  assert.equal(manager.conversation('dispose-b') !== undefined, true)
  assert.equal(runtime.sessions[0]?.isClosed(), true)
  assert.equal(runtime.sessions[1]?.isClosed(), false)

  // Plugin unload still closes every remaining owned process.
  await model.closeOwnedSessions()
  assert.equal(manager.size(), 0)
  assert.equal(runtime.sessions[1]?.isClosed(), true)
  await fiberB.dispose()
})

test('a session disposal does not close a pending auxiliary native session', async () => {
  const { ctx } = await sessionContext()
  const fiber = await createOwnedSession(ctx, 'aux-owner', '/tmp/dsh-ws-aux-owner')
  const runtime = new ScriptedNativeRuntime()
  runtime.enqueue(textTurn('answer'))
  // The auxiliary turn never stops until the test aborts it.
  runtime.enqueue({ events: [] })
  const { model, manager, closing } = mount(runtime, ctx)
  await collect(model, { ...textRequest('hello', 'aux-owner'), system: 'Prompt' })
  const controller = new AbortController()
  const auxiliary = collect(model, {
    ...textRequest('name this session', 'aux-owner'),
    purpose: 'session-title',
    signal: controller.signal,
  } as GenerateOptions)
  await waitFor(() => runtime.starts.length === 2)
  await waitFor(() => manager.size() === 2)
  assert.equal(runtime.sessions[1]?.isClosed(), false)

  await fiber.dispose()
  const closePromise = closing()
  assert.ok(closePromise !== undefined)
  await closePromise

  assert.equal(manager.size(), 1)
  assert.equal(manager.conversation('aux-owner'), undefined)
  assert.equal(runtime.sessions[0]?.isClosed(), true)
  assert.equal(runtime.sessions[1]?.isClosed(), false)

  controller.abort()
  const chunks = await auxiliary
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'aborted')
  await model.closeOwnedSessions()
  assert.equal(runtime.sessions[1]?.isClosed(), true)
})

test('a disposed session with no native process closes nothing', async () => {
  const { ctx } = await sessionContext()
  const fiber = await createOwnedSession(ctx, 'never-streamed', '/tmp/dsh-ws-never')
  const runtime = new ScriptedNativeRuntime()
  const { model, manager, closing } = mount(runtime, ctx)
  await fiber.dispose()
  const closePromise = closing()
  assert.ok(closePromise !== undefined)
  await closePromise
  assert.equal(runtime.starts.length, 0)
  assert.equal(runtime.closeCount, 0)
  assert.equal(manager.size(), 0)
  await model.closeOwnedSessions()
})
