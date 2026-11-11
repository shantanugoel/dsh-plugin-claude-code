import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import { contentHash } from './canonical.js'
import { pluginFailure } from './errors.js'

/**
 * Process variables the auth command may inherit.
 * Claude billing, provider, endpoint, and header variables are not on this list.
 * Reviewed against the Claude Code environment reference on 2026-11-10.
 */
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

const HELPER_KEYS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'gcpAuthRefresh'])
const MAX_SETTINGS_BYTES = 1_048_576
const MAX_AUTH_STDOUT_BYTES = 65_536

/** Default life of one accepted auth-check result. A refusal is never cached. */
export const DEFAULT_AUTH_CACHE_MS = 60_000
const MAX_AUTH_CACHE_ENTRIES = 16

export interface AuthCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
}

export interface AuthCommandResult {
  readonly stdout: string
  readonly exitCode: number
}

/** Runs one local command. Tests supply a fake. Production uses the official CLI. */
export interface AuthCommandRunner {
  run(command: AuthCommand): Promise<AuthCommandResult>
}

export interface AuthCheck {
  readonly workspace: string
  readonly home: string
  readonly parentEnv: NodeJS.ProcessEnv
  readonly settingsFiles?: readonly string[]
  /**
   * Optional accepted account binding that the caller requires. A cached
   * acceptance is used only for this binding. A different account binding
   * refuses the check. The plugin has no pre-command source for the current
   * binding, so the short cache interval bounds an unnoticed login change.
   */
  readonly expectedIdentityBinding?: string
}

export interface AuthGuardOptions {
  /** Time source in milliseconds. Tests supply a controlled clock. */
  readonly now?: () => number
  /** How long one accepted check stays valid. */
  readonly ttlMs?: number
}

interface CachedAcceptance {
  readonly acceptance: AuthAcceptance
  readonly expiresAt: number
}

/** One settings file state in the cache scope. The content is not read again. */
interface SettingsFileState {
  readonly path: string
  readonly state: string
}

/** Account material stays out of this object. `identityBinding` is a hash. */
export interface AuthAcceptance {
  readonly identityBinding: string
  readonly authMethod: 'claude.ai'
  readonly apiProvider: 'firstParty'
}

export interface HomeSource {
  current(): string
}

export class ProcessHome implements HomeSource {
  current(): string {
    return homedir()
  }
}

/**
 * Copy the allowlisted parent environment and force HOME to the inspected home.
 * The result never receives a billing variable, even when the parent has one.
 */
export function buildChildEnvironment(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name]
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }
  env['HOME'] = home
  return env
}

/** True when a settings `env` entry can change auth, provider, endpoint, or headers. */
export function isIsolatedOverride(name: string): boolean {
  return name.startsWith('ANTHROPIC_')
    || name.startsWith('AWS_')
    || name.startsWith('VERTEX_')
    || name.startsWith('GOOGLE_')
    || name.startsWith('AZURE_')
    || name.startsWith('CLAUDE_CODE_USE_')
    || name.startsWith('CLAUDE_CODE_OAUTH_')
    || name === 'CLAUDE_CODE_EXTRA_BODY'
    || name === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'
    || name === 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'
    || name === 'CLAUDE_CONFIG_DIR'
}

/**
 * Settings files inspected before any auth command.
 * User, project, local, and the platform managed file are included.
 * A helper outside these files is not detected.
 */
export function defaultSettingsFiles(home: string, workspace: string): readonly string[] {
  const files = [
    join(home, '.claude', 'settings.json'),
    join(home, '.claude.json'),
    join(workspace, '.claude', 'settings.json'),
    join(workspace, '.claude', 'settings.local.json'),
  ]
  const host = platform()
  if (host === 'darwin') files.push('/Library/Application Support/ClaudeCode/managed-settings.json')
  else if (host === 'linux') files.push('/etc/claude-code/managed-settings.json')
  else if (host === 'win32') files.push('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  return files
}

/**
 * Refuse when a settings file can run a credential helper or can select
 * another billing route. This function does not execute a helper.
 */
export function assertSettingsSafe(files: readonly string[]): void {
  for (const file of files) {
    if (!existsSync(file)) continue
    const size = statSync(file).size
    if (size > MAX_SETTINGS_BYTES) {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'A settings file is too large to inspect. No command was started.',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'A settings file is not JSON. No command was started.',
      )
    }
    assertSettingsValue(parsed)
  }
}

export class AuthGuard {
  private readonly cache = new Map<string, CachedAcceptance>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(
    private readonly runner: AuthCommandRunner,
    private readonly executable = 'claude',
    options: AuthGuardOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_AUTH_CACHE_MS
  }

  async check(input: AuthCheck): Promise<AuthAcceptance> {
    const settingsFiles = input.settingsFiles ?? defaultSettingsFiles(input.home, input.workspace)
    // The settings safety check runs on every call, including a cache hit.
    // A helper or a billing override cannot hide behind a cached acceptance.
    assertSettingsSafe(settingsFiles)
    const key = authCacheKey({
      executable: this.executable,
      home: input.home,
      workspace: input.workspace,
      parentEnv: input.parentEnv,
      settingsFiles,
    })
    const cached = this.cachedFor(key, input.expectedIdentityBinding)
    if (cached !== undefined) return cached
    const result = await this.runner.run({
      executable: this.executable,
      args: ['auth', 'status'],
      env: buildChildEnvironment(input.parentEnv, input.home),
      cwd: input.workspace,
    })
    const acceptance = interpretAuthStatus(result)
    if (input.expectedIdentityBinding !== undefined && acceptance.identityBinding !== input.expectedIdentityBinding) {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'The auth account binding changed. No model prompt was sent.',
      )
    }
    this.remember(key, acceptance)
    return acceptance
  }

  private cachedFor(key: string, expectedIdentityBinding: string | undefined): AuthAcceptance | undefined {
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return undefined
    }
    if (expectedIdentityBinding !== undefined && entry.acceptance.identityBinding !== expectedIdentityBinding) {
      return undefined
    }
    return entry.acceptance
  }

  private remember(key: string, acceptance: AuthAcceptance): void {
    this.cache.delete(key)
    this.cache.set(key, { acceptance, expiresAt: this.now() + this.ttlMs })
    if (this.cache.size > MAX_AUTH_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
  }
}

/**
 * Build the cache scope from the facts that can change the accepted route.
 * Settings file contents are not read here: each file's modification time and
 * size change the key. The allowlisted environment values are included.
 */
function authCacheKey(input: {
  readonly executable: string
  readonly home: string
  readonly workspace: string
  readonly parentEnv: NodeJS.ProcessEnv
  readonly settingsFiles: readonly string[]
}): string {
  return contentHash({
    executable: input.executable,
    home: input.home,
    workspace: input.workspace,
    env: buildChildEnvironment(input.parentEnv, input.home),
    settingsFiles: settingsFileStates(input.settingsFiles),
  })
}

function settingsFileStates(files: readonly string[]): readonly SettingsFileState[] {
  return files.map((path) => {
    try {
      const stat = statSync(path)
      return { path, state: `${stat.mtimeMs}:${stat.size}` }
    } catch {
      return { path, state: 'missing' }
    }
  })
}

export function interpretAuthStatus(result: AuthCommandResult): AuthAcceptance {
  if (result.exitCode !== 0) {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status command failed. No model prompt was sent.')
  }
  if (result.stdout.length > MAX_AUTH_STDOUT_BYTES) {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status output is too large. No model prompt was sent.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout) as unknown
  } catch {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status output is not JSON. No model prompt was sent.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status output has no object. No model prompt was sent.')
  }
  const record = parsed as Record<string, unknown>
  if (record['loggedIn'] !== true || record['authMethod'] !== 'claude.ai' || record['apiProvider'] !== 'firstParty') {
    throw pluginFailure(
      'AUTH_ROUTE_REFUSED',
      'The auth route is not a first-party Claude subscription. No model prompt was sent.',
    )
  }
  const apiKeySource = record['apiKeySource']
  if (typeof apiKeySource === 'string' && apiKeySource.trim() !== '') {
    throw pluginFailure(
      'AUTH_ROUTE_REFUSED',
      'The auth status names an API key source. No model prompt was sent.',
    )
  }
  const account = stringField(record, 'orgId') ?? stringField(record, 'accountId')
  if (account === undefined) {
    throw pluginFailure(
      'AUTH_ROUTE_REFUSED',
      'The auth status has no account binding. No model prompt was sent.',
    )
  }
  return {
    identityBinding: createHash('sha256').update(account).digest('hex'),
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
  }
}

function assertSettingsValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSettingsValue(item)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (HELPER_KEYS.has(key) && typeof child === 'string' && child.trim() !== '') {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'A settings file enables a credential helper. No helper command was started.',
      )
    }
    if (key === 'env') assertEnvBlock(child)
    else assertSettingsValue(child)
  }
}

function assertEnvBlock(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'A settings env block is not an object. No command was started.')
  }
  for (const [name, envValue] of Object.entries(value)) {
    if (typeof envValue === 'string' && envValue.trim() !== '' && isIsolatedOverride(name)) {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'A settings file sets an auth, provider, endpoint, or header override. No command was started.',
      )
    }
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
}
