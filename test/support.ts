import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeCodeAdapter } from '../src/adapter.js'
import { AuthGuard, type AuthCommand, type AuthCommandResult } from '../src/auth.js'
import type { WorkspaceSource } from '../src/context.js'
import { SessionManager } from '../src/session-manager.js'
import type { SpendGate } from '../src/spend-gate.js'
import type { NativeRuntime } from '../src/sdk-runtime.js'

export const SYNTHETIC_AUTH_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  orgId: 'org-synthetic',
})

export class RecordingRunner {
  readonly calls: AuthCommand[] = []

  constructor(private readonly result: AuthCommandResult) {}

  run(command: AuthCommand): Promise<AuthCommandResult> {
    this.calls.push(command)
    return Promise.resolve(this.result)
  }
}

export function acceptedRunner(): RecordingRunner {
  return new RecordingRunner({ stdout: SYNTHETIC_AUTH_STATUS, exitCode: 0 })
}

export function makeAdapter(input: {
  readonly runtime: NativeRuntime
  readonly spendGate: SpendGate
  readonly runner?: RecordingRunner
  readonly workspace?: WorkspaceSource
  readonly settingsFiles?: readonly string[]
  readonly parentEnv?: NodeJS.ProcessEnv
}): {
  readonly model: ClaudeCodeAdapter
  readonly runner: RecordingRunner
  readonly home: string
  readonly workspace: string
} {
  const runner = input.runner ?? acceptedRunner()
  const home = mkdtempSync(join(tmpdir(), 'dsh-claude-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-claude-ws-'))
  const settingsFiles = input.settingsFiles ?? []
  const model = new ClaudeCodeAdapter({
    runtime: input.runtime,
    spendGate: input.spendGate,
    sessions: new SessionManager(),
    workspace: input.workspace ?? { current: () => workspace },
    auth: new AuthGuard(runner),
    home: { current: () => home },
    parentEnv: () => input.parentEnv ?? {
      PATH: '/usr/bin',
      HOME: home,
      ANTHROPIC_API_KEY: 'secret-token',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
    },
    settingsFiles: () => settingsFiles,
  })
  return { model, runner, home, workspace }
}
