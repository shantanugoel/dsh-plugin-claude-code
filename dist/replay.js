import { pluginFailure } from './errors.js';
/** Refuse the per-block replay shape. Response-level data has no `blocks` field. */
export function rejectBlockReplay(value) {
    if (typeof value !== 'object' || value === null || !('blocks' in value))
        return;
    if (value.blocks === undefined)
        return;
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data must not use a blocks field.');
}
/** Read one response envelope. A missing or changed field is refused. */
export function parseReplayEnvelope(value) {
    rejectBlockReplay(value);
    if (!isRecord(value) || !('response' in value)) {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no response envelope.');
    }
    return parseReplay(value['response']);
}
export function parseReplay(value) {
    if (!isRecord(value)) {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data is not an object.');
    }
    if (value['format'] !== 'claude-session-v1') {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data uses an unknown format.');
    }
    const nativeResponseBlocks = value['nativeResponseBlocks'];
    if (!Array.isArray(nativeResponseBlocks)) {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no native response blocks.');
    }
    const toolNameMap = value['toolNameMap'];
    if (!isStringRecord(toolNameMap)) {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no tool-name map.');
    }
    const retentionAudit = value['retentionAudit'];
    if (retentionAudit !== 'accepted' && retentionAudit !== 'unavailable') {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no retention audit.');
    }
    if (retentionAudit === 'unavailable' && value['nativeRequestRecord'] !== null) {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Unavailable retention evidence is stored as a request record.');
    }
    return {
        format: 'claude-session-v1',
        generationId: requiredString(value, 'generationId'),
        cliSessionId: requiredString(value, 'cliSessionId'),
        cliVersion: requiredString(value, 'cliVersion'),
        sdkVersion: requiredString(value, 'sdkVersion'),
        model: requiredString(value, 'model'),
        workspace: requiredString(value, 'workspace'),
        requestPrefixHash: requiredString(value, 'requestPrefixHash'),
        projectedContentHash: requiredString(value, 'projectedContentHash'),
        nativeRequestRecord: value['nativeRequestRecord'] ?? null,
        nativeResponseBlocks,
        toolNameMap,
        retentionAudit,
    };
}
function requiredString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data is missing a required field.');
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringRecord(value) {
    if (!isRecord(value))
        return false;
    return Object.values(value).every((entry) => typeof entry === 'string');
}
