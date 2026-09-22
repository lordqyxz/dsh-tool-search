import { describe, expect, it } from 'vitest'
import { buildCatalog, searchTools } from '../src/catalog.js'
import { buildRegistry, MAX_REGISTRY } from '../bench/registry.mjs'

// Efficiency regression guards for the numbers published in README.
// Mirrors bench/run-benchmark.mjs measurement logic.

const tok = (text: string): number => Math.ceil(text.length / 4)

const DISCOVERY_GUIDANCE = 'Most tools are deferred: the prompt lists every deferred tool with a one-line purpose, but not'
  + ' its parameter schema. When a deferred tool fits the task, call tool_search'
  + ' with a capability query to load the full schemas of the most relevant tools, then call the chosen'
  + ' tool directly by its exact name. Do not claim a capability is unavailable before searching.'

function catalogSectionTokens(tools: ReturnType<typeof buildRegistry>): number {
  const lines = tools.map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim()
    const truncated = description.length > 110 ? description.slice(0, 109) + '…' : description
    return '- ' + tool.name + ' — ' + truncated
  })
  return tok([...lines, DISCOVERY_GUIDANCE].join('\n'))
}

function searchCallTokens(catalog: ReturnType<typeof buildCatalog>, query: string): number {
  const matches = searchTools(catalog, query, 5)
  const value = {
    protocol: 'dsh-tool-search/v1', query, matches,
    discoveredTools: matches.map((match) => match.name),
    discoveredCount: matches.length,
    catalogTools: catalog.tools.size,
    instruction: 'x',
  }
  return tok(JSON.stringify({ query })) + tok(JSON.stringify(value))
}

describe('efficiency invariants', () => {
  const registry = buildRegistry(MAX_REGISTRY)
  const catalog = buildCatalog(registry, 4)
  const baseline = catalog.totalEstimatedTokens
  const deferred = catalogSectionTokens(registry)
  const search = searchCallTokens(catalog, registry[0]!.capQuery)

  it('resident surface shrinks by at least 70% on the 120-tool registry', () => {
    expect(1 - deferred / baseline).toBeGreaterThan(0.7)
  })

  it('a single search pays for itself within one request', () => {
    expect(Math.ceil(search / (baseline - deferred))).toBeLessThanOrEqual(2)
  })

  it('name queries rank the exact tool first', () => {
    for (const tool of registry) {
      expect(searchTools(catalog, tool.nameQuery, 5)[0]?.name).toBe(tool.name)
    }
  })

  it('paraphrase queries hit the target within the top 5', () => {
    const misses = registry
      .filter((tool) => !searchTools(catalog, tool.capQuery, 5).some((match) => match.name === tool.name))
    expect(misses.length / registry.length).toBeLessThan(0.05)
  })
})
