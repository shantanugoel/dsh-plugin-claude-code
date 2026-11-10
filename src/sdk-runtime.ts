import { pluginFailure } from './errors.js'

/**
 * Internal native session boundary. Tests inject a scripted implementation.
 * The production class must not import or start the official SDK while the
 * spend guard is unavailable.
 */
export interface NativeSessionConfig {
  readonly workspace: string
  readonly model: string
  readonly systemPrompt: string
}

export interface NativeUserInput {
  readonly text: string
}

export type NativeEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'text'; readonly text: string }

export interface NativeSession {
  readonly events: AsyncIterable<NativeEvent>
  sendUser(input: NativeUserInput): Promise<void>
  close(): Promise<void>
}

export interface NativeRuntime {
  start(config: NativeSessionConfig): Promise<NativeSession>
}

/**
 * Production runtime. `start` fails before it loads the Agent SDK and before
 * it starts a process. A later milestone may load the SDK only after the
 * spend gate allows the request.
 */
export class SdkNativeRuntime implements NativeRuntime {
  async start(_config: NativeSessionConfig): Promise<NativeSession> {
    throw pluginFailure(
      'BILLING_GUARD_UNAVAILABLE',
      'No accepted spend guard can prevent a paid request. The native session did not start.',
    )
  }
}
