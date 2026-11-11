#!/usr/bin/env node
// Live context-window probe. It starts the official Claude CLI through the
// Agent SDK with the user's login. It sends no user prompt. Run it only by
// hand. It never runs from test, build, pack:check, or installation.
//
// It uses the production model discovery and the production window reader, so
// the values seen here are the values that `resolveModel` reports.
import { officialContextWindows, officialModelDiscovery } from '../dist/model-discovery.js'

const rows = await officialModelDiscovery.list()
const out = []
for (const row of rows) {
  out.push({
    requested: row.value,
    displayName: row.displayName,
    contextWindow: (await officialContextWindows.read(row.value)) ?? null,
  })
}
console.log(JSON.stringify(out, null, 1))
process.exit(0)
