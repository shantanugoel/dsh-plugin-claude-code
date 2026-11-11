import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
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
import { contextWindowFor, measuredModelCapacity, recordMeasuredModelUsage } from './capacity.js'
import { requireAbsoluteWorkspace, type SessionOriginSource, type WorkspaceSource } from './context.js'
import { withDeadline, type Deadlines } from './deadlines.js'
import { claudeEffort, reasoningFor, type ClaudeEffort } from './effort.js'
import { isPluginFailure, pluginFailure } from './errors.js'
import {
  addImageContentStats,
  claudeImageRequestPricing,
  claudeImageTarget,
  exceedsGenerationImageLimit,
  imageContentStats,
  prepareNativeContent,
  requiredRequestImageCountOffload,
  requiredRequestImageOffload,
  type ImageAttachmentReader,
  type ImageContentStats,
  type OutgoingBlock,
} from './images.js'
import { McpBridge, mapToolNames } from './mcp-bridge.js'
import { projectCatalogModel, resolvedModelName } from './catalog.js'
import type { DiscoveredModel } from './model-discovery.js'
import { recordContextImport as appendContextImport } from './rebase.js'
import { parseReplay, type GenerationChangeReason, type ReplayV1 } from './replay.js'
import { CLAUDE_CODE_SESSION_ROUTE, INFERENCE_SCOPE } from './route.js'
import { createDiagnosticsDir, removeDiagnosticsDir } from './request-log.js'
import { buildSdkLaunchPlan } from './sdk-plan.js'
import type { NativeContentBlock, NativeRuntime, NativeSession, NativeToolResult } from './sdk-runtime.js'
import type { LiveGeneration, SessionManager } from './session-manager.js'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'

import type { SpendGate } from './spend-gate.js'
import { finishReasonFor, isAbortError, nativeFailureReasonOf, readUntilStop, translateTurn } from './stream.js'
import { buildSummaryImport, isSummaryPurpose } from './summary-import.js'
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
  /** Context window that the CLI reports for one model, without a model request. */
  readonly discoverContextWindow?: (model: string) => Promise<number | undefined>
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
    return this.modelRow(model).then(async (row) => {
      // A result-message measurement needs no CLI read. Without one, ask the
      // CLI for the window of this model. A failed read keeps the fallback.
      const discovered = measuredModelCapacity(model) === undefined
        ? await this.dependencies.discoverContextWindow?.(model).catch(() => undefined)
        : undefined
      if (signal?.aborted === true) {
        throw new DOMException('The model request was aborted.', 'AbortError')
      }
      const reasoning = reasoningFor(row)
      return {
        provider,
        id: model,
        name: resolvedModelName(model, row),
        inputModalities: ['text', 'image'],
        context: { contextWindow: contextWindowFor(model, discovered) },
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

  /** Number of native sessions this adapter owns. For diagnostics and tests. */
  ownedSessionCount(): number {
    return this.dependencies.sessions.size()
  }

  /**
   * Close the conversation generation of one disposed dsh session.
   * A matching auxiliary call is not closed here. Its own stream closes it.
   */
  closeSession(sessionId: string): Promise<void> {
    return this.dependencies.sessions.closeConversation(sessionId)
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
    const purpose = options.purpose === undefined ? '' : String(options.purpose)
    const summary = isSummaryPurpose(purpose)
    let admission: Admission
    let sessionOptions: GenerateOptions = options
    let content: readonly NativeContentBlock[]
    if (summary) {
      // One deterministic textual import in a separate native session. The
      // import has no signed thinking, no tool-call IDs, and no image bytes.
      // The final user instruction stays last, so the summary model reads it
      // as the terminal request. This is a recorded textual import: it does
      // not retain a native signed prefix.
      const imported = buildSummaryImport(options.messages)
      admission = {
        kind: 'first-user',
        userContent: [{ type: 'text', text: imported.text }],
        requestHash: imported.requestHash,
        committed: [],
      }
      content = [{ type: 'text', text: imported.text }]
      // A summary session must produce text. It has no dsh tools, so it cannot
      // start a tool wait that no conversation can answer.
      sessionOptions = { ...options, tools: [] }
    } else {
      if (options.messages.some((message) => message.role === 'assistant' || message.role === 'tool')) {
        throw pluginFailure(
          'UNSUPPORTED_INPUT',
          'This auxiliary request replays conversation history, which needs a recorded import.',
        )
      }
      admission = admitTranscript({
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
      content = await this.prepareContent(admission.userContent, options.signal)
    }
    const effort = await this.effortFor(options.model, options.reasoningEffort)
    const live = await this.ensureSession(undefined, key, sessionOptions, workspace, true, 'aux', effort)
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
      // The invalid path already closed the native process. Release the key
      // either way, so an aborted or failed call cannot leave an entry that a
      // later call with the same content finds. This path cannot remove a
      // conversation generation.
      await this.dependencies.sessions.releaseAuxiliary(key)
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
        yield* this.continueGeneration(live, options, workspace, sessionId, prompt, toolsCanonical, effort)
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

  /**
   * Continue the healthy live generation. A changed fixed configuration starts
   * one new generation with the new configuration and a recorded import.
   */
  private async *continueGeneration(
    live: LiveGeneration,
    options: GenerateOptions,
    workspace: string,
    sessionId: string,
    prompt: string,
    toolsCanonical: string,
    effort: ClaudeEffort | undefined,
  ): AsyncIterable<StreamChunk> {
    const changedFields = changedConfigurationFields(live, options, workspace, prompt, toolsCanonical, effort)
    let admission: Admission
    try {
      admission = admitTranscript({
        messages: options.messages,
        waitingForResults: live.phase === 'WAITING_FOR_RESULTS',
        state: {
          committed: live.committed,
          pending: live.pending,
          dispatchedHash: live.dispatchedHash,
        },
      })
    } catch (error) {
      if (!isPluginFailure(error, 'REBASE_REQUIRED')) throw error
      // dsh changed an earlier message: a tool-result prune, a compaction
      // replacement, or an edit. The live native session cannot change its
      // prefix, and the user cannot repair this condition. Start one recorded
      // new generation from the current request. The old signed thinking is
      // not sent.
      yield* this.recoverGeneration(
        options,
        workspace,
        sessionId,
        live,
        'history-change',
        effort,
        changedFields.length > 0 ? changedFields : undefined,
      )
      return
    }
    if (changedFields.length > 0) {
      yield* this.recoverGeneration(
        options,
        workspace,
        sessionId,
        live,
        'configuration-change',
        effort,
        changedFields,
      )
      return
    }
    // A count excess is exact without reading an attachment version. Refuse it
    // before any image read. A parked tool batch stays open for the retry.
    this.assertRequestImageCountBudget(options.messages)
    // Prepare every image and result before the native boundary. A refusal
    // here sends nothing, so the same step can retry after a repair. If tool
    // handlers are parked, release them with an error instead of leaving them
    // until their deadline.
    let userContent: readonly NativeContentBlock[] | undefined
    let toolResults: readonly NativeToolResult[] | undefined
    let trailingContent: readonly (readonly NativeContentBlock[])[] = []
    try {
      if (admission.kind === 'tool-results') {
        toolResults = await this.prepareResults(admission.results, options.signal)
        trailingContent = await this.prepareTrailingContent(admission.trailing, options.signal)
      } else if (admission.kind === 'first-user' || admission.kind === 'next-user') {
        userContent = await this.prepareContent(admission.userContent, options.signal)
      }
    } catch (error) {
      if (live.phase === 'WAITING_FOR_RESULTS') await this.invalidate(live, 'invalid')
      throw error
    }
    // A request image budget failure names how many oldest occurrences dsh
    // must offload. It is thrown before the native boundary, so a parked tool
    // batch stays private to this generation and dsh can retry the step.
    this.assertRequestImageBudget(options.messages)
    const addedImages = preparedImageStats(userContent, toolResults)
    if (exceedsGenerationImageLimit(
      { count: live.retainedImageCount, bytes: live.retainedImageBytes },
      addedImages,
    )) {
      // One recorded new generation has a text import with image placeholders.
      // This keeps the provider request image count below its documented limit.
      yield* this.recoverGeneration(options, workspace, sessionId, live, 'image-budget', effort)
      return
    }
    live.retainedImageCount += addedImages.count
    live.retainedImageBytes += addedImages.bytes
    if (admission.kind === 'tool-results' && toolResults !== undefined) {
      // The CLI surfaces queued user input in the same model request as the
      // tool result only when that input arrives before the result is
      // released. The measurement in docs/evidence/trailing-context-probe
      // records that order.
      for (const content of trailingContent) {
        await live.native.sendMidTurnUser({ content })
      }
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

  /**
   * Prepare the user messages that dsh placed after a tool-result batch.
   * A non-offloaded image is refused: the measured CLI mid-turn surface is a
   * text system message, and this path has no image measurement.
   */
  private async prepareTrailingContent(
    trailing: readonly (readonly OutgoingBlock[])[],
    signal: AbortSignal | undefined,
  ): Promise<readonly (readonly NativeContentBlock[])[]> {
    const prepared: (readonly NativeContentBlock[])[] = []
    for (const blocks of trailing) {
      if (blocks.some((block) => block.type === 'image' && block.offloaded !== true)) {
        throw pluginFailure(
          'UNSUPPORTED_INPUT',
          'An image in a trailing mid-turn user message is not supported.',
        )
      }
      prepared.push(await this.prepareContent(blocks, signal))
    }
    return prepared
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
    this.assertRequestImageCountBudget(options.messages)
    const userContent = await this.prepareContent(admission.userContent, options.signal)
    this.assertRequestImageBudget(options.messages)
    const addedImages = preparedImageStats(userContent, undefined)
    const generationId = this.dependencies.sessions.nextGeneration(sessionId)
    const key = `${sessionId}:${generationId}`
    const live = await this.ensureSession(undefined, key, options, workspace, false, generationId, effort)
    live.retainedImageCount = addedImages.count
    live.retainedImageBytes = addedImages.bytes
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
    replaced: LiveGeneration | undefined,
    reason: GenerationChangeReason,
    effort: ClaudeEffort | undefined,
    changedFields?: readonly string[],
  ): AsyncIterable<StreamChunk> {
    const plan = planRollover({
      messages: options.messages,
      reason,
      ...(replaced === undefined ? {} : {
        replaced: {
          generationId: replaced.generationId,
          cliSessionId: recordedCliSessionId(replaced),
          committed: replaced.committed,
          dispatchedMessages: replaced.dispatchedMessages,
          dispatchedHash: replaced.dispatchedHash,
        },
      }),
      ...(changedFields === undefined ? {} : { changedFields }),
    })
    this.assertRequestImageCountBudget(options.messages)
    const pendingContent = plan.pendingUserContent.length === 0
      ? []
      : await this.prepareContent(plan.pendingUserContent, options.signal)
    this.assertRequestImageBudget(options.messages)
    const addedImages = preparedImageStats(pendingContent, undefined)
    if (replaced !== undefined) await this.dependencies.sessions.closeKey(replaced.key)
    const generationId = this.dependencies.sessions.nextGeneration(sessionId)
    const key = `${sessionId}:${generationId}`
    const live = await this.ensureSession(undefined, key, options, workspace, false, generationId, effort)
    live.retainedImageCount = addedImages.count
    live.retainedImageBytes = addedImages.bytes
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
    recordMeasuredModelUsage(events)
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
        reason: finishReasonFor(translated.stopReason),
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
    // Only a conversation generation captures request evidence. An auxiliary
    // title or summary call has its own request audit and no dsh turn.
    const diagnosticsDir = auxiliary ? undefined : createDiagnosticsDir()
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
      ...(diagnosticsDir === undefined ? {} : { diagnosticsDir }),
    })
    let native: NativeSession
    try {
      native = await withDeadline(this.dependencies.runtime.start({
        workspace,
        model: options.model,
        systemPrompt: prompt,
        launch,
        callTool: (callId) => bridge.wait(callId, this.dependencies.deadlines.resultWaitMs),
      }), this.dependencies.deadlines.initializationMs, 'INCOMPATIBLE_RUNTIME', 'The native session did not initialize before the deadline.')
    } catch (error) {
      removeDiagnosticsDir(diagnosticsDir)
      throw error
    }
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
      diagnosticsDir,
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
      retainedImageCount: 0,
      retainedImageBytes: 0,
    }
    this.dependencies.sessions.insert(created)
    return created
  }

  /**
   * Refuse a count excess before any attachment read. The count budget does
   * not depend on an image size, so this result is exact.
   */
  private assertRequestImageCountBudget(messages: GenerateOptions['messages']): void {
    this.refuseImageOffload(requiredRequestImageCountOffload(messages))
  }

  /**
   * Refuse a request whose retained image occurrences or encoded bytes exceed
   * the route request budget. dsh records an image/offload selection for the
   * named count and retries the step. A retry sends placeholder text for each
   * offloaded occurrence, so the count is smaller on the next attempt.
   */
  private assertRequestImageBudget(messages: GenerateOptions['messages']): void {
    this.refuseImageOffload(requiredRequestImageOffload(messages))
  }

  private refuseImageOffload(offloadImages: number): void {
    if (offloadImages === 0) return
    throw new LlmError(
      `The request retains more images than this route sends at once. Offload ${offloadImages} more oldest image occurrence${offloadImages === 1 ? '' : 's'} and retry.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
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
  // An auxiliary call that replays a flattened import is never an audit of a
  // native signed prefix, even when its own turn carries request evidence.
  const audit = auditAccepted && !live.auxiliary
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
    nativeRequestRecord: audit ? evidence : null,
    nativeResponseBlocks: nativeBlocks,
    toolNameMap: live.toolNameMap,
    retentionAudit: audit ? 'accepted' : 'unavailable',
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

/**
 * Fixed generation configuration fields that differ from the current request.
 * The order is stable so the recorded list is deterministic.
 */
function changedConfigurationFields(
  live: LiveGeneration,
  options: GenerateOptions,
  workspace: string,
  prompt: string,
  toolsCanonical: string,
  effort: ClaudeEffort | undefined,
): string[] {
  const changed: string[] = []
  if (live.model !== options.model) changed.push('model')
  if (live.effort !== effort) changed.push('reasoningEffort')
  if (live.maxOutputTokens !== options.maxTokens) changed.push('maxTokens')
  if (live.workspace !== workspace) changed.push('workspace')
  if (live.systemPrompt !== prompt) changed.push('systemPrompt')
  if (live.toolsCanonical !== toolsCanonical) changed.push('tools')
  return changed
}

function preparedImageStats(
  content: readonly NativeContentBlock[] | undefined,
  results: readonly NativeToolResult[] | undefined,
): ImageContentStats {
  let stats: ImageContentStats = { count: 0, bytes: 0 }
  if (content !== undefined) stats = addImageContentStats(stats, imageContentStats(content))
  for (const result of results ?? []) stats = addImageContentStats(stats, imageContentStats(result.content))
  return stats
}

function blockType(block: { readonly type?: unknown }): string {
  if (typeof block.type !== 'string' || block.type.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A content block has no type.')
  }
  return block.type
}
