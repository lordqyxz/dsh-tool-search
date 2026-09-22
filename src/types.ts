export interface ToolSchemaView {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface CatalogTool extends ToolSchemaView {
  readonly estimatedTokens: number
  readonly searchText: string
}

export interface ToolCatalog {
  readonly tools: ReadonlyMap<string, CatalogTool>
  readonly totalEstimatedTokens: number
}

export interface DeferredToolMatch {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly score: number
  readonly estimatedTokens: number
}

export interface SearchValue {
  readonly protocol: 'dsh-tool-search/v1'
  readonly query: string
  readonly matches: readonly DeferredToolMatch[]
  readonly discoveredTools: readonly string[]
  readonly discoveredCount: number
  readonly catalogTools: number
  readonly instruction: string
}

export interface ResolvedConfig {
  readonly toolName: string
  readonly alwaysVisible: readonly string[]
  readonly threshold: number
  readonly maxResults: number
  readonly requireDiscovery: boolean
  readonly charactersPerToken: number
  readonly descriptionChars: number
  readonly deferToolGuidance: boolean
}
