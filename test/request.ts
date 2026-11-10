import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import type { NativeEvent } from '../src/sdk-runtime.js'

export function textRequest(text = 'hello', sessionId = 'session-1'): GenerateOptions {
  return {
    provider: CLAUDE_CODE_SESSION_ROUTE,
    model: 'claude-haiku-5-5',
    sessionId: sessionId as Exclude<GenerateOptions['sessionId'], undefined>,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }
}

export function textTurn(text: string, messageId = 'm1'): { events: NativeEvent[] } {
  return {
    events: [
      { type: 'block-start', messageId, index: 0, blockType: 'text' },
      { type: 'text-delta', messageId, index: 0, text },
      { type: 'block-stop', messageId, index: 0 },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'message-stop', messageId, stopReason: 'end_turn' },
    ],
  }
}
