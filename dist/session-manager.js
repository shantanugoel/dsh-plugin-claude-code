import { withDeadline } from './deadlines.js';
import { pluginFailure } from './errors.js';
/**
 * Owned native sessions. Close is safe to call more than once.
 */
export class SessionManager {
    live = new Map();
    admitting = new Set();
    generationCount = new Map();
    size() {
        return this.live.size;
    }
    get(key) {
        return this.live.get(key);
    }
    conversation(sessionId) {
        for (const session of this.live.values()) {
            if (!session.auxiliary && session.sessionId === sessionId && session.phase !== 'CLOSED')
                return session;
        }
        return undefined;
    }
    insert(session) {
        this.live.set(session.key, session);
    }
    /** Allocate the next generation id for one dsh session. */
    nextGeneration(sessionId) {
        const next = (this.generationCount.get(sessionId) ?? 0) + 1;
        this.generationCount.set(sessionId, next);
        return String(next);
    }
    /** Reserve one key before the first await. A second admission fails closed. */
    tryAdmit(key) {
        const live = this.live.get(key);
        if (this.admitting.has(key) || live?.phase === 'GENERATING' || live?.phase === 'STARTING') {
            throw pluginFailure('SESSION_BUSY', 'This native session already has an active stream.');
        }
        this.admitting.add(key);
    }
    endAdmit(key) {
        this.admitting.delete(key);
    }
    async closeKey(key) {
        const session = this.live.get(key);
        if (session === undefined)
            return;
        this.live.delete(key);
        session.phase = 'CLOSED';
        session.bridge.cancel('The native session closed before the tool result was delivered.');
        await withDeadline(session.native.close(), session.deadlines.closeMs, 'NATIVE_OUTCOME_UNKNOWN', 'The native session did not close before the deadline.');
    }
    async closeOwned() {
        const sessions = [...this.live.values()];
        this.live.clear();
        await Promise.all(sessions.map(async (session) => {
            session.phase = 'CLOSED';
            session.bridge.cancel('The native session closed before the tool result was delivered.');
            await withDeadline(session.native.close(), session.deadlines.closeMs, 'NATIVE_OUTCOME_UNKNOWN', 'The native session did not close before the deadline.');
        }));
    }
}
