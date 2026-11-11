import type { SdkLaunchPlan } from './sdk-plan.js'

/** Raster image media types accepted by the official Claude interfaces. */
export type NativeImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One content block sent to the native session. Images carry base64 bytes. */
export type NativeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: NativeImageMediaType
    readonly data: string
  }

/**
 * Internal native session boundary. Tests inject a scripted implementation.
 * The production class loads the official SDK only when `start` runs.
 */
export interface NativeToolResult {
  readonly callId: string
  readonly content: readonly NativeContentBlock[]
  readonly isError: boolean
}

export interface NativeSessionConfig {
  readonly workspace: string
  readonly model: string
  readonly systemPrompt: string
  readonly launch?: SdkLaunchPlan
  readonly callTool?: (callId: string) => Promise<NativeToolResult>
}

export interface NativeUserInput {
  readonly content: readonly NativeContentBlock[]
}

export interface NativeSessionIdentity {
  readonly cliSessionId: string
  readonly cliVersion: string
  readonly sdkVersion: string
}

export type NativeBlockType = 'text' | 'reasoning' | 'tool-call' | 'redacted-thinking'

export type NativeEvent =
  | {
    readonly type: 'block-start'
    readonly messageId: string
    readonly index: number
    readonly blockType: NativeBlockType
    readonly signature?: string
    readonly redactedData?: string
  }
  | { readonly type: 'text-delta'; readonly messageId: string; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly messageId: string; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-delta'
    readonly messageId: string
    readonly index: number
    readonly id: string
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-stop'; readonly messageId: string; readonly index: number }
  | {
    readonly type: 'block-snapshot'
    readonly messageId: string
    readonly index: number
    readonly blockType: NativeBlockType
    readonly text?: string
    readonly id?: string
    readonly name?: string
    readonly argumentsText?: string
    readonly signature?: string
    readonly redactedData?: string
  }
  | {
    readonly type: 'usage'
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  }
  | { readonly type: 'message-stop'; readonly messageId: string; readonly stopReason: 'end_turn' | 'tool_use' }
  | { readonly type: 'native-tool-list'; readonly names: readonly string[] }
  | { readonly type: 'request-evidence'; readonly record: unknown }

export interface NativeSession {
  readonly events: AsyncIterable<NativeEvent>
  readonly identity: NativeSessionIdentity
  sendUser(input: NativeUserInput): Promise<void>
  continueAfterResults(): Promise<void>
  close(): Promise<void>
  /** True after the native process or event stream ended. */
  isClosed?(): boolean
}

export interface NativeRuntime {
  start(config: NativeSessionConfig): Promise<NativeSession>
}

/**
 * Production runtime. `start` loads the official SDK and the installed Claude
 * executable. The offline suite does not call `start`.
 */
export class SdkNativeRuntime implements NativeRuntime {
  async start(config: NativeSessionConfig): Promise<NativeSession> {
    const official = await import('./official-session.js')
    return official.startOfficialSession(config)
  }
}
