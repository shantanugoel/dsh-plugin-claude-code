import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'

import { ClaudeCodeAdapter } from '../src/adapter.js'
import type { DiscoveredModel } from '../src/model-discovery.js'
import { DEFAULT_DEADLINES, type Deadlines } from '../src/deadlines.js'
import { AuthGuard, type AuthCommand, type AuthCommandResult, type AuthGuardOptions } from '../src/auth.js'
import type { SessionOriginSource, WorkspaceSource } from '../src/context.js'
import type { ImageAttachmentReader } from '../src/images.js'
import { SessionManager } from '../src/session-manager.js'
import type { SpendGate } from '../src/spend-gate.js'
import type { NativeRuntime } from '../src/sdk-runtime.js'

export const SYNTHETIC_AUTH_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  orgId: 'org-synthetic',
})

/** One decoded 1x1 PNG. It exercises transport bytes only; no image is decoded. */
export const SYNTHETIC_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export function syntheticImage(
  id = 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  overrides: Partial<ImageAttachmentRef> = {},
): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: SYNTHETIC_PNG_BYTES.byteLength,
    width: 1,
    height: 1,
    ...overrides,
  }
}

/** Attachment service double. It records each exact request target. */
export class FakeImageAttachments implements ImageAttachmentReader {
  readonly requests: { readonly ref: ImageAttachmentRef; readonly target: ImageRequestTarget }[] = []

  constructor(private readonly bytes: Uint8Array = SYNTHETIC_PNG_BYTES) {}

  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    this.requests.push({ ref, target })
    return Promise.resolve({
      variantId: ref.attachmentId,
      attachment: ref,
      data: this.bytes,
      mediaType: ref.mediaType,
      bytes: this.bytes.byteLength,
      width: target.width,
      height: target.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    } as unknown as RequestImageAttachment)
  }
}

export class RecordingRunner {
  readonly calls: AuthCommand[] = []

  constructor(private readonly result: AuthCommandResult) {}

  run(command: AuthCommand): Promise<AuthCommandResult> {
    this.calls.push(command)
    return Promise.resolve(this.result)
  }
}

export function acceptedRunner(): RecordingRunner {
  return new RecordingRunner({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
}

export function makeAdapter(input: {
  readonly runtime: NativeRuntime
  readonly spendGate: SpendGate
  readonly runner?: RecordingRunner
  readonly workspace?: WorkspaceSource
  readonly sessionOrigin?: SessionOriginSource
  readonly attachments?: () => ImageAttachmentReader | undefined
  readonly settingsFiles?: readonly string[]
  readonly parentEnv?: NodeJS.ProcessEnv
  readonly deadlines?: Deadlines
  readonly configuration?: { current(): number }
  readonly catalog?: readonly DiscoveredModel[]
  readonly discoverContextWindow?: (model: string) => Promise<number | undefined>
  readonly authOptions?: AuthGuardOptions
}): {
  readonly model: ClaudeCodeAdapter
  readonly sessions: SessionManager
  readonly runner: RecordingRunner
  readonly home: string
  readonly workspace: string
} {
  const runner = input.runner ?? acceptedRunner()
  const home = mkdtempSync(join(tmpdir(), 'dsh-claude-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-claude-ws-'))
  const settingsFiles = input.settingsFiles ?? []
  const sessions = new SessionManager()
  const model = new ClaudeCodeAdapter({
    runtime: input.runtime,
    spendGate: input.spendGate,
    sessions,
    workspace: input.workspace ?? { current: () => workspace },
    ...(input.sessionOrigin === undefined ? {} : { sessionOrigin: input.sessionOrigin }),
    auth: new AuthGuard(runner, 'claude', input.authOptions),
    home: { current: () => home },
    parentEnv: () => input.parentEnv ?? {
      PATH: '/usr/bin',
      HOME: home,
      ANTHROPIC_API_KEY: 'secret-token',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
    },
    deadlines: input.deadlines ?? DEFAULT_DEADLINES,
    attachments: input.attachments ?? (() => undefined),
    settingsFiles: () => settingsFiles,
    ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    ...(input.discoverContextWindow === undefined ? {} : { discoverContextWindow: input.discoverContextWindow }),
  })
  return { model, sessions, runner, home, workspace }
}
