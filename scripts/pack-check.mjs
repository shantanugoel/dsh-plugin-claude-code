import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
})
const parsed = JSON.parse(stdout)
const entry = Array.isArray(parsed) ? parsed[0] : parsed
const files = (entry.files ?? []).map((file) => (typeof file === 'string' ? file : file.path))
const required = [
  'package.json',
  'README.md',
  'cordis.patch.yml',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/adapter.js',
  'dist/sdk-runtime.js',
  'dist/spend-gate.js',
]
const missing = required.filter((path) => !files.includes(path))
const forbidden = files.filter((path) => {
  const name = path.toLowerCase()
  return name.includes('/test/')
    || name.startsWith('test/')
    || name.includes('/tests/')
    || name.startsWith('tests/')
    || name.includes('/src/')
    || name.startsWith('src/')
    || name.includes('.local')
    || name.includes('node_modules')
    || name.includes('.env')
    || name.endsWith('.jsonl')
    || name.endsWith('.ndjson')
    || name.includes('credential')
    || name.includes('.dsh')
    || name.includes('dist-test')
    || name.includes('/docs/')
    || name.startsWith('docs/')
})

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) console.error(`The package is missing: ${missing.join(', ')}.`)
  if (forbidden.length > 0) console.error(`The package includes forbidden files: ${forbidden.join(', ')}.`)
  process.exit(1)
}

console.log(`Package inspection accepted ${files.length} files. No license is selected yet.`)
