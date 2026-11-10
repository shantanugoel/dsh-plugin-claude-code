import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { pluginFailure } from './errors.js';
/**
 * Quote completed history for a new generation.
 * The text has no thinking blocks and no live tool-call ids.
 */
export function historicalContextText(messages) {
    const lines = [
        'Historical context for a new Claude session.',
        'Completed tool outcomes are quoted.',
        'This context has no live tool call and no previous thinking.',
    ];
    for (const message of messages) {
        if (message.role === 'system')
            continue;
        if (message.role === 'assistant') {
            for (const block of message.content) {
                if (block.type === 'text' && block.text !== undefined)
                    lines.push(`Assistant: ${quote(block.text)}`);
                if (block.type === 'tool-call' && block.name !== undefined)
                    lines.push(`Assistant requested tool ${quote(block.name)}.`);
            }
            continue;
        }
        if (message.role === 'tool' || message.role === 'user') {
            const text = message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
            const label = message.role === 'tool' ? 'Tool outcome' : 'User';
            lines.push(`${label}: ${quote(text)}`);
        }
    }
    return lines.join('\n');
}
/**
 * Replace the model-visible conversation with one historical import.
 * The leading system prompt stays. The raw log keeps the earlier events.
 * Flush must have a durability listener before the import is complete.
 */
export async function recordContextImport(input) {
    const derived = input.session.deriveMessages();
    const nodes = input.session.surface.nodes;
    const keepSystem = derived[0]?.role === 'system' && nodes.length > 0;
    const replaceNodes = keepSystem ? nodes.slice(1) : [...nodes];
    if (replaceNodes.length > 0) {
        const start = replaceNodes[0];
        const end = replaceNodes[replaceNodes.length - 1];
        if (start === undefined || end === undefined
            || !toolPairingBalancedBefore(input.session, start)
            || !toolPairingBalancedAfter(input.session, end)) {
            throw pluginFailure('REBASE_REQUIRED', 'The context import needs a balanced tool boundary.');
        }
    }
    const text = historicalContextText(derived);
    const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
    });
    const start = replaceNodes[0];
    const end = replaceNodes[replaceNodes.length - 1];
    const event = start === undefined || end === undefined
        ? input.session.append('user/message', message, { surfaceOp: 'append' })
        : input.session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
            sourceEventSeqs: [...replaceNodes],
        });
    const flushed = await input.sessions.flush(input.session);
    if (flushed !== true) {
        throw pluginFailure('REBASE_REQUIRED', 'The context import has no durability listener.');
    }
    return { text, seq: Number(event.seq) };
}
function quote(text) {
    return JSON.stringify(text);
}
