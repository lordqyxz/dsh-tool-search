/**
 * Vendor-style tool deferral for the DeepSeek Harness tool registry.
 *
 * Mirrors the deferred-loading model of provider-hosted tool search: every
 * deferrable tool contributes only its name and description to the stable
 * request surface, while the search tool returns the full parameter schemas
 * of the most relevant tools on demand. Discovered tools are then called
 * directly through the ordinary Harness pipeline - no dispatcher hop.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import type { InferValue, JsonSchemaNode, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { buildCatalog, matchesToolName, searchTools } from './catalog.js'
import {
  DEFAULT_ALWAYS_VISIBLE,
  DEFAULT_CHARACTERS_PER_TOKEN,
  DEFAULT_DEFER_TOOL_GUIDANCE,
  DEFAULT_DESCRIPTION_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_REQUIRE_DISCOVERY,
  DEFAULT_THRESHOLD,
  DEFAULT_TOOL_NAME,
} from './defaults.js'
import type { ResolvedConfig, ToolCatalog, ToolSchemaView } from './types.js'

export { buildCatalog, estimateSchemaTokens, matchesToolName, searchTools } from './catalog.js'
export type {
  CatalogTool,
  DeferredToolMatch,
  ResolvedConfig,
  SearchValue,
  ToolCatalog,
  ToolSchemaView,
} from './types.js'

type JsonValue = InferValue<{ type: 'json' }>

export const name = 'tool-search'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Registered discovery tool name. */
  readonly toolName?: string
  /** Tool-name wildcard patterns whose full schemas stay directly visible. */
  readonly alwaysVisible?: readonly string[]
  /** Deferred loading activates only at or above this many deferrable tools. */
  readonly threshold?: number
  /** Maximum full definitions returned by one search. */
  readonly maxResults?: number
  /** Require a successful search before a deferred tool can be called directly. */
  readonly requireDiscovery?: boolean
  /** Schema characters represented by one estimated token. */
  readonly charactersPerToken?: number
  /** Per-tool description cap in the resident catalog section, in characters. */
  readonly descriptionChars?: number
  /** Remove exact hidden tool guidance sections from the stable prompt. */
  readonly deferToolGuidance?: boolean
}

export const Config = z.object({
  toolName: z.string().default(DEFAULT_TOOL_NAME),
  alwaysVisible: z.array(z.string()).default([...DEFAULT_ALWAYS_VISIBLE]),
  threshold: z.number().default(DEFAULT_THRESHOLD),
  maxResults: z.number().default(DEFAULT_MAX_RESULTS),
  requireDiscovery: z.boolean().default(DEFAULT_REQUIRE_DISCOVERY),
  charactersPerToken: z.number().default(DEFAULT_CHARACTERS_PER_TOKEN),
  descriptionChars: z.number().default(DEFAULT_DESCRIPTION_CHARS),
  deferToolGuidance: z.boolean().default(DEFAULT_DEFER_TOOL_GUIDANCE),
}) as unknown as z<Config>

function nonEmpty(value: string, path: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(path + ' must not be empty')
  return trimmed
}

function integer(value: number, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(path + ' must be a safe integer greater than or equal to ' + String(minimum))
  }
  return value
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const toolName = nonEmpty(config.toolName ?? DEFAULT_TOOL_NAME, 'toolName')
  const alwaysVisible = (config.alwaysVisible ?? DEFAULT_ALWAYS_VISIBLE)
    .map((pattern, index) => nonEmpty(pattern, 'alwaysVisible[' + String(index) + ']'))
  return {
    toolName,
    alwaysVisible,
    threshold: integer(config.threshold ?? DEFAULT_THRESHOLD, 'threshold', 1),
    maxResults: integer(config.maxResults ?? DEFAULT_MAX_RESULTS, 'maxResults', 1),
    requireDiscovery: config.requireDiscovery ?? DEFAULT_REQUIRE_DISCOVERY,
    charactersPerToken: integer(config.charactersPerToken ?? DEFAULT_CHARACTERS_PER_TOKEN, 'charactersPerToken', 1),
    descriptionChars: integer(config.descriptionChars ?? DEFAULT_DESCRIPTION_CHARS, 'descriptionChars', 20),
    deferToolGuidance: config.deferToolGuidance ?? DEFAULT_DEFER_TOOL_GUIDANCE,
  }
}

interface AgentState {
  readonly agent: Agent
  catalog: ToolCatalog
  readonly stableNames: Set<string>
  readonly discovered: Set<string>
  catalogDirty: boolean
  restored: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function textContentValue(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  const first = content[0]
  return isRecord(first) && first.type === 'text' ? parseJson(first.text) : undefined
}

/**
 * The cumulative list wins over per-call increments so resume restores the
 * full discovery state from the latest entry even when older events were
 * compacted away.
 */
function discoveredFromValue(value: unknown): string[] | undefined {
  if (!isRecord(value) || value.protocol !== 'dsh-tool-search/v1') return undefined
  if (Array.isArray(value.allDiscoveredTools)
    && value.allDiscoveredTools.every(item => typeof item === 'string')) {
    return value.allDiscoveredTools as string[]
  }
  if (Array.isArray(value.discoveredTools)
    && value.discoveredTools.every(item => typeof item === 'string')) {
    return value.discoveredTools as string[]
  }
  if (!Array.isArray(value.matches)) return undefined
  return value.matches
    .map(match => isRecord(match) && typeof match.name === 'string' ? match.name : undefined)
    .filter((item): item is string => item !== undefined)
}

function toolResultContent(message: unknown): { callId: string; isError: boolean; value: unknown } | undefined {
  if (!isRecord(message) || !isRecord(message.source) || typeof message.source.callId !== 'string') return undefined
  if (!Array.isArray(message.content) || !isRecord(message.content[0])) return undefined
  const block = message.content[0]
  if (block.type !== 'tool-result') return undefined
  return {
    callId: message.source.callId,
    isError: block.isError === true,
    value: textContentValue(block.content),
  }
}

function nestedDispatch(event: unknown): { name: string; content: unknown } | undefined {
  if (!isRecord(event)
    || (event.type !== 'tool/ptc-dispatch' && event.type !== 'tool/code-dispatch')
    || !isRecord(event.data)
    || event.data.isError !== false
    || typeof event.data.name !== 'string') return undefined
  return { name: event.data.name, content: event.data.content }
}

function cloneSchemas(
  value: readonly { name: string; description: string; parameters: Record<string, unknown> }[],
): ToolSchemaView[] {
  return value.map(schema => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  }))
}

const resultSchema = {
  type: 'object',
  additionalProperties: true,
} as const

function searchValueFromExecution(result: Readonly<ToolExecutionResult>): unknown | undefined {
  if (result.isError || !isRecord(result.value) || result.value.protocol !== 'dsh-tool-search/v1') return undefined
  return result.value
}

function exactGuidanceForDeferredTool(sectionName: string, deferredNames: ReadonlySet<string>): boolean {
  if (!sectionName.startsWith('tool:') || sectionName === 'tools:sdk' || sectionName === 'tools:code-only') {
    return false
  }
  const suffix = sectionName.slice('tool:'.length)
  for (const name of deferredNames) {
    if (suffix === name || suffix.startsWith(name + ':')) return true
  }
  return false
}

function catalogSectionText(catalog: ToolCatalog, config: ResolvedConfig): string {
  const lines = [...catalog.tools.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(tool => {
      const description = tool.description.replace(/\s+/g, ' ').trim()
      const truncated = description.length > config.descriptionChars
        ? description.slice(0, config.descriptionChars - 1) + '…'
        : description
      return '- ' + tool.name + ' — ' + truncated
    })
  return [
    '## Deferred tool catalog',
    '',
    'The tools below stay deferred: only their names and purposes are listed here; their full parameter'
      + ' schemas are not loaded. When one fits the task, call ' + config.toolName + ' with a capability'
      + ' query - it returns the most relevant tools with complete schemas - then call the chosen tool'
      + ' directly by its exact name.',
    '',
    ...lines,
  ].join('\n')
}

export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input)
  const states = new WeakMap<Agent, AgentState>()
  const liveStates = new Set<AgentState>()

  const ensureState = (agent: Agent): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created: AgentState = {
      agent,
      catalog: buildCatalog([], config.charactersPerToken),
      stableNames: new Set(),
      discovered: new Set(),
      catalogDirty: true,
      restored: false,
    }
    states.set(agent, created)
    liveStates.add(created)
    return created
  }

  const restoreFromEvents = (state: AgentState): void => {
    const calls = new Map<string, string>()
    for (const event of state.agent.session.snapshotEvents()) {
      if (event.type === 'tool/call'
        && isRecord(event.data)
        && typeof event.data.callId === 'string'
        && typeof event.data.name === 'string') {
        calls.set(event.data.callId, event.data.name)
        continue
      }
      if (event.type === 'tool/result' && isRecord(event.data)) {
        const result = toolResultContent(event.data.message)
        if (result === undefined || result.isError) continue
        if (calls.get(result.callId) !== config.toolName) continue
        const meta = isRecord(event.data.meta) ? event.data.meta : undefined
        const sources = [meta === undefined ? undefined : discoveredFromValue(meta), discoveredFromValue(result.value)]
        for (const discovered of sources) {
          for (const name of discovered ?? []) state.discovered.add(name)
        }
        continue
      }
      const nested = nestedDispatch(event)
      if (nested === undefined || nested.name !== config.toolName) continue
      for (const name of discoveredFromValue(textContentValue(nested.content)) ?? []) state.discovered.add(name)
    }
  }

  const rebuildCatalog = (state: AgentState): void => {
    const schemas = cloneSchemas(state.agent.ctx.tools.schemas(state.agent))
    state.stableNames.clear()
    for (const schema of schemas) {
      if (schema.name === config.toolName || matchesToolName(schema.name, config.alwaysVisible)) {
        state.stableNames.add(schema.name)
      }
    }
    const managed = schemas.filter(schema => !state.stableNames.has(schema.name))
    state.catalog = buildCatalog(managed, config.charactersPerToken)
    // Discovered names deliberately survive registry refreshes (for example a
    // provider reconnect); the guard validates catalog membership at call time.
    if (!state.restored) {
      restoreFromEvents(state)
      state.restored = true
    }
    state.catalogDirty = false
  }

  const prepareState = (agent: Agent): AgentState => {
    const state = ensureState(agent)
    if (state.catalogDirty) rebuildCatalog(state)
    return state
  }

  const belowThreshold = (state: AgentState): boolean => state.catalog.tools.size < config.threshold

  const clampLimit = (requested: number | undefined): number => {
    if (requested === undefined) return config.maxResults
    return Math.min(Math.max(requested, 1), config.maxResults)
  }

  interface ToolSdkSchema extends ToolSchemaView {
    readonly output: JsonSchemaNode
  }

  const shapeSdkSection = (state: AgentState, visibleNames: ReadonlySet<string>, text: string): string => {
    const schemas: ToolSdkSchema[] = []
    for (const name of [...visibleNames].sort()) {
      if (name === 'run_code') continue
      const definition = state.agent.ctx.tools.get(name, state.agent)
      if (definition === undefined) continue
      schemas.push({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: definition.output.schema,
      })
    }
    return text.includes('python') ? renderToolsSdkPy(schemas) : renderToolsSdk(schemas)
  }

  ctx.tools.register(defineTool({
    name: config.toolName,
    description: 'Search deferred tools by capability. Only tool names and purposes are listed upfront; '
      + 'this returns the full parameter schemas of the most relevant tools so they can be called directly.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Task-oriented capability query. Include the object, action, or service involved.',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum tools to return (1-' + String(config.maxResults) + '); defaults to ' + String(config.maxResults) + '.',
      },
    },
    output: {
      schema: resultSchema,
      render: (_args, value) => {
        // The cumulative list lives in presentation meta only; rendering it
        // would leak the ever-growing discovery table back into the prompt.
        const rendered = { ...(value as Record<string, unknown>) }
        delete rendered.allDiscoveredTools
        return [{ type: 'text', text: JSON.stringify(rendered) }]
      },
      presentationMeta: (_args, value) => ({
        protocol: 'dsh-tool-search/v1',
        allDiscoveredTools: (value as { allDiscoveredTools?: readonly string[] }).allDiscoveredTools ?? [],
      }) as unknown as JsonValue,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(config.toolName + ' requires an agent-scoped execution')
      const state = prepareState(exec.agent)
      const query = args.query.trim()
      if (query === '') throw new Error('query must not be empty')
      const matches = belowThreshold(state)
        ? []
        : searchTools(state.catalog, query, clampLimit(args.max_results))
      const allDiscovered = new Set(state.discovered)
      const newly: string[] = []
      for (const match of matches) {
        if (!allDiscovered.has(match.name)) {
          allDiscovered.add(match.name)
          newly.push(match.name)
        }
      }
      return {
        protocol: 'dsh-tool-search/v1',
        query,
        matches,
        discoveredTools: newly,
        discoveredCount: allDiscovered.size,
        catalogTools: state.catalog.tools.size,
        allDiscoveredTools: [...allDiscovered].sort(),
        instruction: matches.length > 0
          ? 'Call any returned tool directly by its exact name with arguments matching the returned parameters schema.'
          : 'No tool matched. Rephrase the query with exact capability words, or consult the deferred tool catalog section of the prompt.',
      } as unknown as InferValue<typeof resultSchema>
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool-search:discovery',
    order: 140,
    text: 'Most tools are deferred: the prompt lists every deferred tool with a one-line purpose, but not'
      + ' its parameter schema. When a deferred tool fits the task, call ' + config.toolName
      + ' with a capability query to load the full schemas of the most relevant tools, then call the chosen'
      + ' tool directly by its exact name. Do not claim a capability is unavailable before searching.',
  })

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (execution.name === 'run_code' || execution.name === config.toolName) return undefined
    // Prepare lazily so calls arriving before the first assembly or
    // session-start event are still classified against the deferred catalog.
    const state = prepareState(agent)
    if (belowThreshold(state)) return undefined
    if (state.stableNames.has(execution.name)) return undefined
    if (!state.catalog.tools.has(execution.name)) return undefined
    if (state.discovered.has(execution.name)) return undefined
    if (!config.requireDiscovery) return undefined
    return 'tool ' + JSON.stringify(execution.name) + ' is deferred; call ' + config.toolName
      + ' with the exact name ' + JSON.stringify(execution.name)
      + ' as the query to load its schema, then call it directly'
  })

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = await next()
    const agent = context.agent
    if (agent === undefined) return resolved
    const state = prepareState(agent)
    const deferred = belowThreshold(state)
      ? new Set<string>()
      : new Set(state.catalog.tools.keys())
    const visibleNames = deferred.size === 0
      ? new Set(state.agent.ctx.tools.schemas(state.agent).map(schema => schema.name))
      : new Set<string>([...state.stableNames, 'run_code'])
    const sections = resolved.sections
      .filter(section => !config.deferToolGuidance || !exactGuidanceForDeferredTool(section.name, deferred))
      .map(section => section.name === 'tools:sdk'
        ? { ...section, text: shapeSdkSection(state, visibleNames, section.text) }
        : section)
    if (deferred.size > 0) {
      sections.push({ name: 'tool-search:catalog', text: catalogSectionText(state.catalog, config) })
    }
    return {
      ...resolved,
      sections,
      tools: resolved.tools.filter(schema => visibleNames.has(schema.name)),
    }
  }, { prepend: true })

  ctx.on('agent/created', ({ agent }) => {
    prepareState(agent)
  }, { prepend: true })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined || result.isError) return
    if (exec.name !== config.toolName) return
    const state = ensureState(agent)
    const value = searchValueFromExecution(result)
    if (value === undefined) return
    for (const discovered of discoveredFromValue(value) ?? []) state.discovered.add(discovered)
  })

  ctx.on('tools/change', () => {
    for (const state of liveStates) state.catalogDirty = true
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    liveStates.delete(state)
    states.delete(agent)
  })

  ctx.effect(() => () => {
    liveStates.clear()
  }, 'tool-search.agent-state')
}
