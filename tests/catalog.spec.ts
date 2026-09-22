import { describe, expect, it } from 'vitest'
import { buildCatalog, estimateSchemaTokens, matchesToolName, searchTools } from '../src/catalog.js'
import { resolveConfig } from '../src/index.js'
import type { ToolSchemaView } from '../src/types.js'

function schema(name: string, description: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }): ToolSchemaView {
  return { name, description, parameters }
}

const catalog = buildCatalog([
  schema('web_search', 'Search the web for current information.', {
    type: 'object',
    properties: { queries: { type: 'array', description: 'Required search queries' } },
    required: ['queries'],
  }),
  schema('gitlab_list_projects', 'List GitLab projects visible to the authenticated user.'),
  schema('memory_save', 'Explicitly save an important insight or decision to long-term memory.'),
], 4)

describe('matchesToolName', () => {
  it('supports trailing wildcards and exact names case-insensitively', () => {
    expect(matchesToolName('submit_report', ['submit_*'])).toBe(true)
    expect(matchesToolName('skill', ['skill'])).toBe(true)
    expect(matchesToolName('Skill', ['skill'])).toBe(true)
    expect(matchesToolName('skillful', ['skill'])).toBe(false)
  })
})

describe('buildCatalog', () => {
  it('estimates tokens from the serialized schema view', () => {
    const tool = catalog.tools.get('web_search')
    expect(tool).toBeDefined()
    const view: ToolSchemaView = { name: tool!.name, description: tool!.description, parameters: tool!.parameters }
    expect(tool!.estimatedTokens).toBe(estimateSchemaTokens(view, 4))
    expect(catalog.totalEstimatedTokens).toBeGreaterThan(0)
  })
})

describe('searchTools', () => {
  it('ranks the exact tool name first', () => {
    const matches = searchTools(catalog, 'web_search', 5)
    expect(matches[0]?.name).toBe('web_search')
    expect(matches[0]!.parameters).toEqual(catalog.tools.get('web_search')!.parameters)
  })

  it('matches capability words across names and descriptions', () => {
    const matches = searchTools(catalog, 'list repositories in gitlab', 5)
    expect(matches[0]?.name).toBe('gitlab_list_projects')
  })

  it('returns nothing for empty or whitespace queries', () => {
    expect(searchTools(catalog, '', 5)).toEqual([])
    expect(searchTools(catalog, '   ', 5)).toEqual([])
  })

  it('honours the limit', () => {
    expect(searchTools(catalog, 'search list memory', 2)).toHaveLength(2)
  })
})

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const config = resolveConfig()
    expect(config.toolName).toBe('tool_search')
    expect(config.threshold).toBe(15)
    expect(config.maxResults).toBe(5)
    expect(config.requireDiscovery).toBe(true)
  })

  it('rejects empty tool names and invalid integers', () => {
    expect(() => resolveConfig({ toolName: '  ' })).toThrow()
    expect(() => resolveConfig({ threshold: 0 })).toThrow()
    expect(() => resolveConfig({ maxResults: 1.5 })).toThrow()
  })
})
