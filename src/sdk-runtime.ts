import { pluginFailure } from './errors.js'

/**
 * Internal native session boundary. Tests inject a scripted implementation.
 * The production class must not import or start the official SDK while the
 * spend guard is unavailable.
 */
export interface NativeToolResult {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}

export interface NativeSessionConfig {
  readonly workspace: string
  readonly model: string
  readonly systemPrompt: string
  readonly callTool?: (callId: string) => Promise<NativeToolResult>
}

export interface NativeUserInput {
  readonly text: string
}

export type NativeBlockType = 'text' | 'reasoning' | 'tool-call' | 'redacted-thinking'

export type NativeEvent =
  | { readonly type: 'block-start'; readonly messageId: string; readonly index: number; readonly blockType: NativeBlockType }
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
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'message-stop'; readonly messageId: string; readonly stopReason: 'end_turn' | 'tool_use' }

export interface NativeSession {
  readonly events: AsyncIterable<NativeEvent>
  sendUser(input: NativeUserInput): Promise<void>
  continueAfterResults(): Promise<void>
  close(): Promise<void>
}

export interface NativeRuntime {
  start(config: NativeSessionConfig): Promise<NativeSession>
}

/**
 * Production runtime. `start` fails before it loads the Agent SDK and before
 * it starts a process.
 */
export class SdkNativeRuntime implements NativeRuntime {
  async start(_config: NativeSessionConfig): Promise<NativeSession> {
    throw pluginFailure(
      'BILLING_GUARD_UNAVAILABLE',
      'No accepted spend guard can prevent a paid request. The native session did not start.',
    )
  }
}
