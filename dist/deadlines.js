import { pluginFailure } from './errors.js';
export const DEFAULT_DEADLINES = {
    initializationMs: 30_000,
    generationMs: 120_000,
    resultWaitMs: 3_600_000,
    closeMs: 5_000,
};
/** Race one operation with a deadline. The timer does not keep the process alive. */
export function withDeadline(work, timeoutMs, code, message) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(pluginFailure(code, message)), timeoutMs);
        timer.unref?.();
    });
    timeout.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
