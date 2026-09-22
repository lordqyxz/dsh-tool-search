import type { CatalogTool, DeferredToolMatch, ToolCatalog, ToolSchemaView } from './types.js'

const WORD_PATTERN = /[\p{L}\p{N}]+/gu

function normalize(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .toLocaleLowerCase('en-US')
    .match(WORD_PATTERN)
    ?.join(' ') ?? ''
}

const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/**
 * CJK text has no space-delimited word boundaries, so whole-phrase tokens
 * would never overlap between queries and definitions. Character bigrams give
 * both sides comparable terms without a segmentation dictionary.
 */
function tokens(value: string): string[] {
  const normalized = normalize(value)
  if (normalized === '') return []
  const result: string[] = []
  for (const token of normalized.split(' ')) {
    result.push(token)
    for (const run of token.match(CJK_RUN_PATTERN) ?? []) {
      for (let index = 0; index + 1 < run.length; index += 1) {
        const bigram = run.slice(index, index + 2)
        if (bigram !== token) result.push(bigram)
      }
    }
  }
  return result
}

export function matchesToolName(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => wildcard(pattern).test(name))
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, ch => '\\' + ch)
  return new RegExp('^' + escaped.replaceAll('*', '.*') + '$', 'i')
}

function parameterKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const own = Object.keys(record)
  return [...own, ...Object.values(record).flatMap(parameterKeys)]
}

function schemaSearchText(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? value : ''
  if (Array.isArray(value)) return value.map(schemaSearchText).join(' ')
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => [key, schemaSearchText(child)])
    .join(' ')
}

export function estimateSchemaTokens(schema: ToolSchemaView, charactersPerToken: number): number {
  return Math.max(1, Math.ceil(JSON.stringify(schema).length / charactersPerToken))
}

function createCatalogTool(schema: ToolSchemaView, charactersPerToken: number): CatalogTool {
  return {
    ...schema,
    estimatedTokens: estimateSchemaTokens(schema, charactersPerToken),
    searchText: normalize([
      schema.name,
      schema.description,
      parameterKeys(schema.parameters).join(' '),
      schemaSearchText(schema.parameters),
    ].join(' ')),
  }
}

export function buildCatalog(schemas: readonly ToolSchemaView[], charactersPerToken: number): ToolCatalog {
  const tools = new Map<string, CatalogTool>()
  for (const schema of schemas) tools.set(schema.name, createCatalogTool(schema, charactersPerToken))
  return {
    tools,
    totalEstimatedTokens: [...tools.values()].reduce((total, tool) => total + tool.estimatedTokens, 0),
  }
}

function termFrequency(documentTokens: readonly string[], term: string): number {
  return documentTokens.reduce((count, token) => count + (token === term ? 1 : 0), 0)
}

/**
 * Rank individual tools with exact-name bonuses and a compact BM25-style score.
 * Definitions, parameter descriptions, enums, and nested property names all
 * participate in the searchable document.
 */
export function searchTools(catalog: ToolCatalog, query: string, limit: number): DeferredToolMatch[] {
  const normalizedQuery = normalize(query)
  const queryTokens = [...new Set(tokens(query))]
  if (normalizedQuery === '' || queryTokens.length === 0) return []

  const documents = [...catalog.tools.values()].map(tool => ({
    tool,
    tokens: [] as string[],
  }))
  for (const document of documents) {
    document.tokens = tokens(document.tool.searchText)
  }
  const averageLength = documents.length === 0
    ? 1
    : documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length
  const k1 = 1.2
  const b = 0.75

  return documents
    .map(({ tool, tokens: documentTokens }) => {
      let score = 0
      const normalizedName = normalize(tool.name)
      if (normalizedName === normalizedQuery) score += 160
      else if (normalizedName.includes(normalizedQuery)) score += 48
      if (tool.searchText.includes(normalizedQuery)) score += 20

      for (const term of queryTokens) {
        const frequency = termFrequency(documentTokens, term)
        if (frequency === 0) continue
        const documentFrequency = documents.reduce(
          (count, document) => count + (document.tokens.includes(term) ? 1 : 0),
          0,
        )
        const inverseFrequency = Math.log(
          1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
        )
        const denominator = frequency + k1 * (1 - b + b * documentTokens.length / averageLength)
        score += inverseFrequency * (frequency * (k1 + 1)) / denominator * 10
        if (tokens(tool.name).includes(term)) score += 18
      }

      return { tool, score }
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.tool.estimatedTokens - right.tool.estimatedTokens
      || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit)
    .map(({ tool, score }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      score: Math.round(score * 100) / 100,
      estimatedTokens: tool.estimatedTokens,
    }))
}
