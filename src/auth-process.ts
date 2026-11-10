import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { pluginFailure } from './errors.js'
import type { AuthCommand, AuthCommandResult, AuthCommandRunner } from './auth.js'

const MAX_STDOUT_BYTES = 65_536

export interface SpawnLike {
  (command: string, args: readonly string[], options: SpawnOptions): ChildProcess
}

/**
 * Run `claude auth status` without a shell. The caller supplies the allowlisted
 * environment. stderr is discarded so a credential cannot enter an error string.
 */
export function createProcessAuthRunner(timeoutMs = 10_000, spawnImpl: SpawnLike = spawn): AuthCommandRunner {
  return {
    run(command: AuthCommand): Promise<AuthCommandResult> {
      return runAuthProcess(command, timeoutMs, spawnImpl)
    },
  }
}

export async function runAuthProcess(
  command: AuthCommand,
  timeoutMs: number,
  spawnImpl: SpawnLike,
): Promise<AuthCommandResult> {
  const child = spawnImpl(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    signal: AbortSignal.timeout(timeoutMs),
  })
  const output = collectStdout(child, MAX_STDOUT_BYTES)
  const exitCode = await waitForExit(child)
  if (output.tooBig) {
    throw pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status output is too large. No model prompt was sent.')
  }
  return { stdout: output.text, exitCode }
}

function collectStdout(child: ChildProcess, limit: number): { text: string; tooBig: boolean } {
  const output = { text: '', tooBig: false }
  const stream = child.stdout
  if (stream === null) return output
  stream.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (output.text.length + bytes.length > limit) {
      output.tooBig = true
      child.kill()
      return
    }
    output.text += bytes.toString('utf8')
  })
  return output
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        reject(pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status command timed out. No model prompt was sent.'))
        return
      }
      reject(pluginFailure('AUTH_ROUTE_REFUSED', 'The auth status command did not start. No model prompt was sent.'))
    }
    child.once('error', fail)
    child.once('close', (code) => {
      resolve(code ?? 1)
    })
  })
}
