/**
 * Process variables the auth command may inherit.
 * Claude billing, provider, endpoint, and header variables are not on this list.
 * Reviewed against the Claude Code environment reference on 2026-11-10.
 */
export declare const CHILD_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
export interface AuthCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
}
export interface AuthCommandResult {
    readonly stdout: string;
    readonly exitCode: number;
}
/** Runs one local command. Tests supply a fake. Production uses the official CLI. */
export interface AuthCommandRunner {
    run(command: AuthCommand): Promise<AuthCommandResult>;
}
export interface AuthCheck {
    readonly workspace: string;
    readonly home: string;
    readonly parentEnv: NodeJS.ProcessEnv;
    readonly settingsFiles?: readonly string[];
}
/** Account material stays out of this object. `identityBinding` is a hash. */
export interface AuthAcceptance {
    readonly identityBinding: string;
    readonly authMethod: 'claude.ai';
    readonly apiProvider: 'firstParty';
}
export interface HomeSource {
    current(): string;
}
export declare class ProcessHome implements HomeSource {
    current(): string;
}
/**
 * Copy the allowlisted parent environment and force HOME to the inspected home.
 * The result never receives a billing variable, even when the parent has one.
 */
export declare function buildChildEnvironment(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv;
/** True when a settings `env` entry can change auth, provider, endpoint, or headers. */
export declare function isIsolatedOverride(name: string): boolean;
/**
 * Settings files inspected before any auth command.
 * User, project, local, and the platform managed file are included.
 * A helper outside these files is not detected.
 */
export declare function defaultSettingsFiles(home: string, workspace: string): readonly string[];
/**
 * Refuse when a settings file can run a credential helper or can select
 * another billing route. This function does not execute a helper.
 */
export declare function assertSettingsSafe(files: readonly string[]): void;
export declare class AuthGuard {
    private readonly runner;
    private readonly executable;
    constructor(runner: AuthCommandRunner, executable?: string);
    check(input: AuthCheck): Promise<AuthAcceptance>;
}
export declare function interpretAuthStatus(result: AuthCommandResult): AuthAcceptance;
