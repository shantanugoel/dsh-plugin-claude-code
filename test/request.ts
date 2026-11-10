import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { CLAUDE_CODE_SESSION_ROUTE } from '../src/route.js'

export function textRequest(text = 'hello'): GenerateOptions {
  return {
    provider: CLAUDE_CODE_SESSION_ROUTE,
    model: 'claude-haiku-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }
}
