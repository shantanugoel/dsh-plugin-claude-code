import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'
import type {
  NativeContentBlock,
  NativeEvent,
  NativeToolResult,
  NativeUserInput,
} from '../src/sdk-runtime.js'

/** Join the text of one native content list. Images show their media type. */
export function contentText(content: readonly NativeContentBlock[]): string {
  return content.map((block) => block.type === 'text' ? block.text : `[image ${block.mediaType}]`).join('')
}

export function inputText(input: NativeUserInput): string {
  return contentText(input.content)
}

export function resultText(result: NativeToolResult): string {
  return contentText(result.content)
}

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
