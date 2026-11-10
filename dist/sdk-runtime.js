/**
 * Production runtime. `start` loads the official SDK and the installed Claude
 * executable. The offline suite does not call `start`.
 */
export class SdkNativeRuntime {
    async start(config) {
        const official = await import('./official-session.js');
        return official.startOfficialSession(config);
    }
}
