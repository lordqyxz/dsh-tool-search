// Efficiency benchmark: resident prompt cost, search cost, break-even,
// ranking quality, and latency — all measured against the real
// buildCatalog / searchTools / estimateSchemaTokens implementations.
// Run: pnpm run bench   (builds lib/ first)

import { performance } from 'node:perf_hooks'
import { buildCatalog, searchTools } from '../lib/index.js'
import { buildRegistry } from './registry.mjs'

const CHARACTERS_PER_TOKEN = 4
const DESCRIPTION_CHARS = 110
const MAX_RESULTS = 5
const SIZES = [15, 30, 60, 120]
const LATENCY_ITERATIONS = 500

const tok = (text) => Math.ceil(text.length / CHARACTERS_PER_TOKEN)

// Replicates catalogSectionText() from src/index.ts exactly.
function catalogSectionText(catalog) {
  const lines = [...catalog.tools.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      const description = tool.description.replace(/\s+/g, ' ').trim()
      const truncated = description.length > DESCRIPTION_CHARS
        ? description.slice(0, DESCRIPTION_CHARS - 1) + '…'
        : description
      return '- ' + tool.name + ' — ' + truncated
    })
  return [
    '## Deferred tool catalog',
    '',
    'The tools below stay deferred: only their names and purposes are listed here; their full parameter'
      + ' schemas are not loaded. When one fits the task, call tool_search with a capability'
      + ' query - it returns the most relevant tools with complete schemas - then call the chosen tool'
      + ' directly by its exact name.',
    '',
    ...lines,
  ].join('\n')
}

// Replicates the discovery guidance section registered in src/index.ts.
const DISCOVERY_GUIDANCE = 'Most tools are deferred: the prompt lists every deferred tool with a one-line purpose, but not'
  + ' its parameter schema. When a deferred tool fits the task, call tool_search'
  + ' with a capability query to load the full schemas of the most relevant tools, then call the chosen'
  + ' tool directly by its exact name. Do not claim a capability is unavailable before searching.'

// Replicates the search tool's render(): the value with allDiscoveredTools removed.
function searchCallTokens(catalog, query) {
  const matches = searchTools(catalog, query, MAX_RESULTS)
  const discovered = matches.map((match) => match.name)
  const value = {
    protocol: 'dsh-tool-search/v1',
    query,
    matches,
    discoveredTools: discovered,
    discoveredCount: discovered.length,
    catalogTools: catalog.tools.size,
    instruction: 'Call any returned tool directly by its exact name with arguments matching the returned parameters schema.',
  }
  const argsJson = JSON.stringify({ query })
  return tok(argsJson) + tok(JSON.stringify(value))
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(size) {
  const registry = buildRegistry(size)
  const catalog = buildCatalog(
    registry.map(({ name, description, parameters }) => ({ name, description, parameters })),
    CHARACTERS_PER_TOKEN,
  )

  // Resident surface, per request.
  const baselineTokens = catalog.totalEstimatedTokens
  const deferredTokens = tok(catalogSectionText(catalog)) + tok(DISCOVERY_GUIDANCE)
  const saving = 1 - deferredTokens / baselineTokens

  // One search call, worst case: one new tool discovered per search.
  const searchTokens = searchCallTokens(catalog, registry[0].capQuery)
  const breakEven = Math.ceil(searchTokens / (baselineTokens - deferredTokens))

  // Ranking quality.
  let nameTop1 = 0
  let capHit5 = 0
  for (const tool of registry) {
    if (searchTools(catalog, tool.nameQuery, MAX_RESULTS)[0]?.name === tool.name) nameTop1++
    const hits = searchTools(catalog, tool.capQuery, MAX_RESULTS).some((match) => match.name === tool.name)
    if (hits) capHit5++
  }

  // Latency (median of repeated searches).
  const samples = []
  for (let i = 0; i < LATENCY_ITERATIONS; i++) {
    const query = registry[i % registry.length].capQuery
    const start = performance.now()
    searchTools(catalog, query, MAX_RESULTS)
    samples.push((performance.now() - start) * 1000)
  }

  return {
    tools: size,
    baselineTokens,
    deferredTokens,
    saving,
    searchTokens,
    breakEven,
    nameTop1: nameTop1 / size,
    capHit5: capHit5 / size,
    latencyUs: median(samples),
  }
}

const rows = SIZES.map(measure)
console.log('| Tools | Baseline tok/req | Deferred tok/req | Resident saving | Search call tok | Break-even | Top-1 (name) | R@5 (paraphrase) | Search latency (median) |')
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const r of rows) {
  console.log(`| ${r.tools} | ${r.baselineTokens} | ${r.deferredTokens} | ${(r.saving * 100).toFixed(1)}%`
    + ` | ${r.searchTokens} | ${r.breakEven} | ${(r.nameTop1 * 100).toFixed(0)}%`
    + ` | ${(r.capHit5 * 100).toFixed(0)}% | ${r.latencyUs.toFixed(0)} µs |`)
}
