import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { AuthGuard, HomeSource } from './auth.js'
import { canonicalJson, contentHash } from './canonical.js'
import { requireAbsoluteWorkspace, type SessionOriginSource, type WorkspaceSource } from './context.js'
import { withDeadline, type Deadlines } from './deadlines.js'
import { claudeEffort, reasoningFor, type ClaudeEffort } from './effort.js'
import { pluginFailure } from './errors.js'
import {
  claudeImageRequestPricing,
  claudeImageTarget,
  prepareNativeContent,
  type ImageAttachmentReader,
  type OutgoingBlock,
} from './images.js'
import { McpBridge, mapToolNames } from './mcp-bridge.js'
import { projectCatalogModel } from './catalog.js'
import type { DiscoveredModel } from './model-discovery.js'
import { recordContextImport as appendContextImport } from './rebase.js'
import { parseReplay, type GenerationChangeReason, type ReplayV1 } from './replay.js'
import { CLAUDE_CODE_SESSION_ROUTE, INFERENCE_SCOPE } from './route.js'
import { buildSdkLaunchPlan } from './sdk-plan.js'
import type { NativeContentBlock, NativeRuntime, NativeToolResult } from './sdk-runtime.js'
import type { LiveGeneration, SessionManager } from './session-manager.js'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'

import type { SpendGate } from './spend-gate.js'
import { isAbortError, nativeFailureReasonOf, readUntilStop, translateTurn } from './stream.js'
import {
  admitTranscript,
  publicationFrom,
  requestNeedsRecovery,
  type Admission,
  type ToolResultInput,
} from './transcript.js'
import { planRollover } from './rollover.js'

export interface AdapterDependencies {
  readonly runtime: NativeRuntime
  readonly spendGate: SpendGate
  readonly sessions: SessionManager
  readonly workspace: WorkspaceSource
  readonly sessionOrigin?: SessionOriginSource
  readonly auth: AuthGuard
  readonly home: HomeSource
  readonly parentEnv: () => NodeJS.ProcessEnv
  readonly deadlines: Deadlines
  readonly attachments: () => ImageAttachmentReader | undefined
  readonly settingsFiles?: () => readonly string[]
  readonly configuration?: { current(): number }
  readonly catalog?: readonly DiscoveredModel[]
  readonly discoverModels?: () => Promise<readonly DiscoveredModel[]>
}

const SUPPORTED_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const BLOCK_TYPES_BY_ROLE: Readonly<Record<string, ReadonlySet<string>>> = {
  system: new Set(['text']),
  user: new Set(['text', 'image']),
  assistant: new Set(['text', 'reasoning', 'tool-call']),
  tool: new Set(['text', 'image']),
}

/**
 * dsh adapter for route `claude-code-session`.
 * A model prompt cannot leave this object while the spend gate refuses.
 */
export class ClaudeCodeAdapter extends LlmAdapter {
  private readonly retryPolicy: ResolvedRetryPolicy

  constructor(private readonly dependencies: AdapterDependencies) {
    super()
    this.retryPolicy = resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      },
      `${CLAUDE_CODE_SESSION_ROUTE}.retryPolicy`,
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    this.assertRoute(provider)
    return { id: provider, name: 'Claude Code session' }
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertRoute(provider)
    return this.retryPolicy
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertRoute(provider)
    const decision = await this.dependencies.spendGate.decide({
      provider,
      model: 'catalog',
      purpose: 'catalog',
      identityBinding: '',
      scope: INFERENCE_SCOPE,
    })
    if (!decision.allowed) return []
    const rows = this.dependencies.catalog
      ?? (this.dependencies.discoverModels === undefined ? [] : await this.dependencies.discoverModels())
    const seen = new Set<string>()
    const models = []
    for (const row of rows) {
      if (seen.has(row.value)) continue
      seen.add(row.value)
      models.push(projectCatalogModel(provider, row))
    }
    return models
  }

  resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertRoute(provider)
    if (signal?.aborted === true) return Promise.reject(new DOMException('The model request was aborted.', 'AbortError'))
    if (model.trim() === '') {
      return Promise.reject(pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.'))
    }
    return this.modelRow(model).then((row) => {
      if (signal?.aborted === true) {
        throw new DOMException('The model request was aborted.', 'AbortError')
      }
      const reasoning = reasoningFor(row)
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    })
  }

  /**
   * Report the exact image projection this adapter serializes. The Claude API
   * scales a longer edge above 1568 px down, so a larger request image adds no
   * model detail and costs more bytes.
   */
  imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): {
    readonly width: number
    readonly height: number
    readonly maxBytes: number
  } {
    this.assertRoute(provider)
    void model
    return claudeImageTarget(image)
  }

  /** Price retained images as the descriptor text and visual tokens they send. */
  imageRequestPricing(provider: string, model: string) {
    this.assertRoute(provider)
    void model
    return claudeImageRequestPricing()
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    const generation = this.dependencies.configuration?.current() ?? 1
    return {
      model: resolved,
      stream: (options: GenerateOptions) => {
        const current = this.dependencies.configuration?.current() ?? 1
        if (current !== generation) {
          throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The adapter configuration changed before dispatch.')
        }
        if (options.provider !== provider || options.model !== model) {
          throw pluginFailure('UNSUPPORTED_INPUT', 'The prepared model does not match the request.')
        }
        return this.stream(options)
      },
    }
  }

  closeOwnedSessions(): Promise<void> {
    return this.dependencies.sessions.closeOwned()
  }

  /**
   * Record one full context import, then close the live native generation.
   * An open tool call refuses the import before the session log changes.
   */
  async recordContextImport(session: Session, sessions: Pick<SessionStore, 'flush'>): Promise<string> {
    const sessionId = String(session.id)
    const live = this.dependencies.sessions.conversation(sessionId)
    if (live?.phase === 'WAITING_FOR_RESULTS' || live?.phase === 'GENERATING' || live?.phase === 'STARTING') {
      throw pluginFailure('REBASE_REQUIRED', 'The context import needs a balanced tool boundary.')
    }
    const imported = await appendContextImport({ session, sessions })
    if (live !== undefined) await this.dependencies.sessions.closeKey(live.key)
    return imported.text
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertRoute(options.provider)
    if (options.signal?.aborted === true) {
      if (options.sessionId !== undefined && options.purpose === undefined) {
        const existing = this.dependencies.sessions.conversation(String(options.sessionId))
        if (existing !== undefined && existing.phase !== 'INVALID' && existing.phase !== 'CLOSED') {
          await this.invalidate(existing, 'abort')
        }
      }
      yield abortedFinish()
      return
    }
    assertSupportedRequest(options)
    if (options.model.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
    }
    if (options.sessionId === undefined) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no session id.')
    }
    const sessionId = String(options.sessionId)
    const workspace = requireAbsoluteWorkspace(this.dependencies.workspace.current(sessionId))
    const auxiliary = options.purpose !== undefined
    const admitKey = auxiliary
      ? `aux:${sessionId}:${options.purpose ?? ''}:${options.maxTokens ?? ''}:${contentHash(options.messages)}`
      : `conversation:${sessionId}`
    const existing = auxiliary ? undefined : this.dependencies.sessions.conversation(sessionId)
    if (existing?.phase === 'GENERATING' || existing?.phase === 'STARTING') {
      throw pluginFailure('SESSION_BUSY', 'This native session already has an active stream.')
    }
    this.dependencies.sessions.tryAdmit(admitKey)
    try {
      const settingsFiles = this.dependencies.settingsFiles?.()
      const acceptance = await this.dependencies.auth.check({
        workspace,
        home: this.dependencies.home.current(),
        parentEnv: this.dependencies.parentEnv(),
        ...(settingsFiles === undefined ? {} : { settingsFiles }),
      })
      const decision = await this.dependencies.spendGate.decide({
        provider: options.provider,
        model: options.model,
        purpose: options.purpose ?? 'conversation',
        identityBinding: acceptance.identityBinding,
        scope: INFERENCE_SCOPE,
      })
      if (!decision.allowed) {
        throw pluginFailure(
          decision.code,
          'No accepted spend guard can prevent a paid request. No model prompt was sent.',
        )
      }
      if (auxiliary) {
        yield* this.runAuxiliary(options, workspace, admitKey)
        return
      }
      yield* this.runAdmitted(options, workspace, sessionId)
    } finally {
      this.dependencies.sessions.endAdmit(admitKey)
    }
  }

  private async *runAuxiliary(
    options: GenerateOptions,
    workspace: string,
    key: string,
  ): AsyncIterable<StreamChunk> {
    if (options.messages.some((message) => message.role === 'assistant' || message.role === 'tool')) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'This auxiliary request replays conversation history, which needs a recorded import.',
      )
    }
    const admission = admitTranscript({
      messages: options.messages,
      waitingForResults: false,
      state: { committed: [], pending: undefined, dispatchedHash: undefined },
    })
    if (admission.kind !== 'first-user') {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'This auxiliary request replays conversation history, which needs a recorded import.',
      )
    }
    const content = await this.prepareContent(admission.userContent, options.signal)
    const effort = await this.effortFor(options.model, options.reasoningEffort)
    const live = await this.ensureSession(undefined, key, options, workspace, true, 'aux', effort)
    try {
      live.phase = 'GENERATING'
      live.dispatchedHash = admission.requestHash
      live.dispatchedMessages = admission.committed
      await live.native.sendUser({ content })
      const chunks = await this.collectTurn(live, admission, options.signal)
      live.phase = 'READY'
      for (const chunk of chunks) yield chunk
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted === true) {
        await this.invalidate(live, 'abort')
        yield abortedFinish()
        return
      }
      await this.invalidate(live, nativeFailureReasonOf(error) ?? 'invalid')
      throw error
    } finally {
      if (live.phase !== 'INVALID') await this.dependencies.sessions.closeKey(key)
    }
  }

  private async *runAdmitted(
    options: GenerateOptions,
    workspace: string,
    sessionId: string,
  ): AsyncIterable<StreamChunk> {
    const live = this.dependencies.sessions.conversation(sessionId)
    const prompt = systemPromptOf(options)
    const tools = mapToolNames(options.tools ?? [])
    const toolsCanonical = canonicalJson(tools.tools)
    const effort = await this.effortFor(options.model, options.reasoningEffort)
    if (live !== undefined) {
      const deadReason = deadGenerationReason(live)
      if (deadReason === undefined) {
        yield* this.continueGeneration(live, options, workspace, prompt, toolsCanonical, effort)
        return
      }
      yield* this.recoverGeneration(options, workspace, sessionId, live, deadReason, effort)
      return
    }
    if (!requestNeedsRecovery(options.messages)) {
      yield* this.startGeneration(options, workspace, sessionId, effort)
      return
    }
    const reason: GenerationChangeReason = this.dependencies.sessionOrigin?.kind(sessionId) === 'fork'
      ? 'fork'
      : 'restore'
    yield* this.recoverGeneration(options, workspace, sessionId, undefined, reason, effort)
  }

  /** Continue the healthy live generation. A fixed-configuration change refuses. */
  private async *continueGeneration(
    live: LiveGeneration,
    options: GenerateOptions,
    workspace: string,
    prompt: string,
    toolsCanonical: string,
    effort: ClaudeEffort | undefined,
  ): AsyncIterable<StreamChunk> {
    if (live.model !== options.model
      || live.effort !== effort
      || live.maxOutputTokens !== options.maxTokens
      || live.workspace !== workspace
      || live.systemPrompt !== prompt
      || live.toolsCanonical !== toolsCanonical) {
      throw pluginFailure(
        'REBASE_REQUIRED',
        'The model, effort, output cap, workspace, prompt, or tools changed. Start a recorded new generation.',
      )
    }
    const admission = admitTranscript({
      messages: options.messages,
      waitingForResults: live.phase === 'WAITING_FOR_RESULTS',
      state: {
        committed: live.committed,
        pending: live.pending,
        dispatchedHash: live.dispatchedHash,
      },
    })
    // Prepare every image and result before the native boundary. A refusal
    // here sends nothing, so the same step can retry after a repair. If tool
    // handlers are parked, release them with an error instead of leaving them
    // until their deadline.
    let userContent: readonly NativeContentBlock[] | undefined
    let toolResults: readonly NativeToolResult[] | undefined
    try {
      if (admission.kind === 'tool-results') {
        toolResults = await this.prepareResults(admission.results, options.signal)
      } else if (admission.kind === 'first-user' || admission.kind === 'next-user') {
        userContent = await this.prepareContent(admission.userContent, options.signal)
      }
    } catch (error) {
      if (live.phase === 'WAITING_FOR_RESULTS') await this.invalidate(live, 'invalid')
      throw error
    }
    if (admission.kind === 'tool-results' && toolResults !== undefined) {
      live.bridge.stage(toolResults)
      if (live.pending !== undefined) {
        live.pending = { ...live.pending, boundMessageId: admission.boundMessageId }
      }
    }
    const send = admission.kind === 'tool-results'
      ? () => live.native.continueAfterResults()
      : () => live.native.sendUser({ content: userContent ?? [] })
    yield* this.dispatchTurn(live, admission, options, send)
  }

  /** Start the first native generation for this dsh session. */
  private async *startGeneration(
    options: GenerateOptions,
    workspace: string,
    sessionId: string,
    effort: ClaudeEffort | undefined,
  ): AsyncIterable<StreamChunk> {
    const admission = admitTranscript({
      messages: options.messages,
      waitingForResults: false,
      state: { committed: [], pending: undefined, dispatchedHash: undefined },
    })
    if (admission.kind !== 'first-user') {
      throw pluginFailure('REPLAY_STATE_INVALID', 'The first request did not admit as new user input.')
    }
    const userContent = await this.prepareContent(admission.userContent, options.signal)
    const generationId = this.dependencies.sessions.nextGeneration(sessionId)
    const key = `${sessionId}:${generationId}`
    const live = await this.ensureSession(undefined, key, options, workspace, false, generationId, effort)
    yield* this.dispatchTurn(live, admission, options, () => live.native.sendUser({ content: userContent }))
  }

  /**
   * Start a new native generation with one recorded textual import.
   * The imported history and the current pending content become one user turn.
   * The dsh request stays unchanged. The successful replay stores the change.
   */
  private async *recoverGeneration(
    options: GenerateOptions,
    workspace: string,
    sessionId: string,
    dead: LiveGeneration | undefined,
    reason: GenerationChangeReason,
    effort: ClaudeEffort | undefined,
  ): AsyncIterable<StreamChunk> {
    const plan = planRollover({
      messages: options.messages,
      reason,
      ...(dead === undefined ? {} : {
        dead: {
          generationId: dead.generationId,
          cliSessionId: recordedCliSessionId(dead),
          committed: dead.committed,
          dispatchedMessages: dead.dispatchedMessages,
          dispatchedHash: dead.dispatchedHash,
        },
      }),
    })
    const pendingContent = plan.pendingUserContent.length === 0
      ? []
      : await this.prepareContent(plan.pendingUserContent, options.signal)
    if (dead !== undefined) await this.dependencies.sessions.closeKey(dead.key)
    const generationId = this.dependencies.sessions.nextGeneration(sessionId)
    const key = `${sessionId}:${generationId}`
    const live = await this.ensureSession(undefined, key, options, workspace, false, generationId, effort)
    const admission: Admission = {
      kind: 'recovered',
      requestHash: plan.requestHash,
      committed: plan.committed,
      generationChange: plan.generationChange,
    }
    const content: NativeContentBlock[] = [
      { type: 'text', text: plan.importedText },
      ...pendingContent,
    ]
    yield* this.dispatchTurn(live, admission, options, () => live.native.sendUser({ content }))
  }

  private async *dispatchTurn(
    live: LiveGeneration,
    admission: Admission,
    options: GenerateOptions,
    send: () => Promise<void>,
  ): AsyncIterable<StreamChunk> {
    live.phase = 'GENERATING'
    live.dispatchedHash = admission.requestHash
    live.dispatchedMessages = admission.committed
    try {
      await send()
      const chunks = await this.collectTurn(live, admission, options.signal)
      live.phase = live.pendingCalls.length > 0 ? 'WAITING_FOR_RESULTS' : 'READY'
      for (const chunk of chunks) yield chunk
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted === true) {
        await this.invalidate(live, 'abort')
        yield abortedFinish()
        return
      }
      await this.invalidate(live, nativeFailureReasonOf(error) ?? 'invalid')
      throw error
    }
  }

  private prepareContent(
    blocks: readonly OutgoingBlock[],
    signal: AbortSignal | undefined,
  ): Promise<readonly NativeContentBlock[]> {
    return prepareNativeContent(blocks, this.dependencies.attachments(), signal)
  }

  private async prepareResults(
    results: readonly ToolResultInput[],
    signal: AbortSignal | undefined,
  ): Promise<readonly NativeToolResult[]> {
    const reader = this.dependencies.attachments()
    return Promise.all(results.map(async (result) => ({
      callId: result.callId,
      content: await prepareNativeContent(result.content, reader, signal),
      isError: result.isError,
    })))
  }

  private async collectTurn(
    live: LiveGeneration,
    admission: Admission,
    signal: AbortSignal | undefined,
  ): Promise<StreamChunk[]> {
    const events = await readUntilStop(live.iterator, live.deadlines.generationMs, signal)
    const translated = translateTurn(events, {
      nativeToDsh: live.nativeToDsh,
      dshNames: live.dshNames,
      allowedNativeTools: live.allowedNativeTools,
    })
    const replay = buildReplay(live, admission, translated.blocks, translated.nativeBlocks, translated.evidence, translated.auditAccepted)
    const publication = publicationFrom({
      blocks: translated.blocks,
      nativeMessageIds: translated.nativeMessageIds,
      replay,
      callIds: translated.pendingCalls.map((call) => call.id),
    })
    live.committed = admission.committed
    live.pending = publication
    live.pendingCalls = translated.pendingCalls
    if (translated.pendingCalls.length > 0) {
      live.bridge.expect(translated.pendingCalls.map((call) => call.id))
    }
    return [
      ...translated.chunks,
      {
        type: 'finish',
        reason: translated.stopReason === 'tool_use' ? { kind: 'tool-calls' } : { kind: 'stop' },
        replayState: { response: replay },
      },
    ]
  }

  private async ensureSession(
    live: LiveGeneration | undefined,
    key: string,
    options: GenerateOptions,
    workspace: string,
    auxiliary: boolean,
    generationId = 'aux',
    effort?: ClaudeEffort,
  ): Promise<LiveGeneration> {
    if (live !== undefined) return live
    const bridge = new McpBridge()
    const tools = mapToolNames(options.tools ?? [])
    const prompt = systemPromptOf(options)
    const launch = buildSdkLaunchPlan({
      workspace,
      model: options.model,
      systemPrompt: prompt,
      tools: tools.tools,
      parentEnv: this.dependencies.parentEnv(),
      home: this.dependencies.home.current(),
      resultWaitMs: this.dependencies.deadlines.resultWaitMs,
      ...(effort === undefined ? {} : { effort }),
      ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    })
    const native = await withDeadline(this.dependencies.runtime.start({
      workspace,
      model: options.model,
      systemPrompt: prompt,
      launch,
      callTool: (callId) => bridge.wait(callId, this.dependencies.deadlines.resultWaitMs),
    }), this.dependencies.deadlines.initializationMs, 'INCOMPATIBLE_RUNTIME', 'The native session did not initialize before the deadline.')
    const created: LiveGeneration = {
      key,
      sessionId: String(options.sessionId),
      generationId,
      auxiliary,
      phase: 'STARTING',
      native,
      bridge,
      iterator: native.events[Symbol.asyncIterator](),
      model: options.model,
      effort,
      maxOutputTokens: options.maxTokens,
      workspace,
      systemPrompt: prompt,
      toolsCanonical: canonicalJson(tools.tools),
      toolNameMap: Object.fromEntries(tools.dshToNative),
      nativeToDsh: tools.nativeToDsh,
      dshNames: new Set(tools.dshToNative.keys()),
      allowedNativeTools: new Set(launch.allowedToolNames),
      deadlines: this.dependencies.deadlines,
      pendingCalls: [],
      committed: [],
      pending: undefined,
      dispatchedHash: undefined,
      dispatchedMessages: undefined,
      invalidReason: undefined,
    }
    this.dependencies.sessions.insert(created)
    return created
  }

  private async invalidate(live: LiveGeneration, reason: GenerationChangeReason): Promise<void> {
    live.invalidReason = reason
    live.phase = 'INVALID'
    live.bridge.cancel('The native session closed before the tool result was delivered.')
    await live.native.close()
  }

  private async modelRow(model: string) {
    const rows = this.dependencies.catalog
      ?? (this.dependencies.discoverModels === undefined ? [] : await this.dependencies.discoverModels())
    return rows.find((row) => row.value === model)
  }

  private async effortFor(model: string, requested: string | undefined): Promise<ClaudeEffort | undefined> {
    const effort = claudeEffort(requested)
    if (effort === undefined) return undefined
    const row = await this.modelRow(model)
    const offered = reasoningFor(row)
    if (row !== undefined && (offered === undefined || !offered.efforts.some((item) => item.id === effort))) {
      throw pluginFailure('UNSUPPORTED_INPUT', `The reasoning effort "${effort}" is not supported for this model.`)
    }
    return effort
  }

  private assertRoute(provider: string): void {
    if (provider !== CLAUDE_CODE_SESSION_ROUTE) {
      throw pluginFailure(
        'INCOMPATIBLE_RUNTIME',
        `The provider route "${provider}" is not ${CLAUDE_CODE_SESSION_ROUTE}.`,
      )
    }
  }
}

function assertSupportedRequest(options: GenerateOptions): void {
  if (options.temperature !== undefined) refuseControl('temperature')
  if (options.stop !== undefined && options.stop.length > 0) refuseControl('stop')
  if (options.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The maxTokens control must be a positive integer.')
    }
  }
  if (options.purpose !== undefined && String(options.purpose).trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The request purpose is empty.')
  }
  // The agent loop always sends toolHistory. This route does not declare
  // toolUpdate, so the runtime already removed developer updates and sent the
  // current tool list. A developer message still fails below.
  const hasSystemMessage = options.messages.some((message) => message.role === 'system')
  if (options.system !== undefined && hasSystemMessage) {
    throw pluginFailure(
      'UNSUPPORTED_INPUT',
      'The request has both a system field and a system message.',
    )
  }
  for (const message of options.messages) {
    if (!SUPPORTED_ROLES.has(message.role)) {
      throw pluginFailure('UNSUPPORTED_INPUT', `The message role "${message.role}" is not supported.`)
    }
    const allowed = BLOCK_TYPES_BY_ROLE[message.role] ?? new Set<string>()
    for (const block of message.content) {
      const type = blockType(block)
      if (type === 'file') {
        throw pluginFailure(
          'UNSUPPORTED_INPUT',
          'The dsh runtime projects file attachments to text handles before adapter dispatch. A file block cannot reach the native session.',
        )
      }
      if (!allowed.has(type)) {
        throw pluginFailure(
          'UNSUPPORTED_INPUT',
          `The content type "${type}" is not supported in a ${message.role} message.`,
        )
      }
    }
  }
}

function systemPromptOf(options: GenerateOptions): string {
  if (options.system !== undefined) return options.system
  const system = options.messages.find((message) => message.role === 'system')
  if (system === undefined) return ''
  const parts: string[] = []
  for (const block of system.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The system message contains unsupported content.')
    }
    parts.push(block.text)
  }
  return parts.join('')
}

function refuseControl(name: string): never {
  throw pluginFailure('UNSUPPORTED_INPUT', `The request control "${name}" is not supported.`)
}

function abortedFinish(): StreamChunk {
  const failure = pluginFailure(
    'NATIVE_OUTCOME_UNKNOWN',
    'The model request was aborted. No tool result was invented.',
  )
  return { type: 'finish', reason: { kind: 'aborted', failure: failure.failure } }
}

function buildReplay(
  live: LiveGeneration,
  admission: Admission,
  blocks: readonly unknown[],
  nativeBlocks: readonly unknown[],
  evidence: unknown,
  auditAccepted: boolean,
): ReplayV1 {
  return parseReplay({
    format: 'claude-session-v1',
    generationId: live.generationId,
    cliSessionId: live.native.identity.cliSessionId,
    cliVersion: live.native.identity.cliVersion,
    sdkVersion: live.native.identity.sdkVersion,
    model: live.model,
    workspace: live.workspace,
    requestPrefixHash: admission.requestHash,
    projectedContentHash: contentHash(blocks),
    nativeRequestRecord: auditAccepted ? evidence : null,
    nativeResponseBlocks: nativeBlocks,
    toolNameMap: live.toolNameMap,
    retentionAudit: auditAccepted ? 'accepted' : 'unavailable',
    ...(admission.kind === 'recovered' ? { generationChange: admission.generationChange } : {}),
  })
}

/**
 * Why the live generation can no longer continue its native process.
 * A process that ended between turns is a process loss.
 */
function deadGenerationReason(live: LiveGeneration): GenerationChangeReason | undefined {
  if (live.phase === 'INVALID' || live.phase === 'CLOSED') return live.invalidReason ?? 'invalid'
  if (live.native.isClosed?.() === true) return 'process-loss'
  return undefined
}

/** The replaced CLI session id, when the native process reported one. */
function recordedCliSessionId(live: LiveGeneration): string | null {
  const id = live.native.identity.cliSessionId
  return id.trim() === '' || id === 'pending' ? null : id
}

function blockType(block: { readonly type?: unknown }): string {
  if (typeof block.type !== 'string' || block.type.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A content block has no type.')
  }
  return block.type
}
