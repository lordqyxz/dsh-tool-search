import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

// Regression guard for direct calls after discovery: a model can only emit
// native calls for tool declarations present in the request surface, so the
// assemble hook must declare every discovered tool, not just return its
// schema as search-result text.

interface FakeDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute?: (args: Record<string, unknown>, exec: { agent: FakeAgent }) => unknown
}

interface FakeAgent {
  ctx: {
    tools: {
      get: (name: string, agent: FakeAgent) => FakeDefinition | undefined
      schemas: (agent: FakeAgent) => FakeDefinition[]
    }
  }
  session: {
    snapshotEvents: () => unknown[]
  }
}

function definition(name: string, description: string): FakeDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Capability query' } },
      required: ['query'],
    },
  }
}

function makeAgent(registry: Map<string, FakeDefinition>): FakeAgent {
  const ctxTools = {
    get: (name: string, _agent: FakeAgent) => registry.get(name),
    schemas: (_agent: FakeAgent) => [...registry.values()],
  }
  return {
    ctx: { tools: ctxTools },
    session: { snapshotEvents: () => [] },
  }
}

function makeContext(registry: Map<string, FakeDefinition>) {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
  const ctx = {
    tools: {
      register: (def: FakeDefinition) => {
        registry.set(def.name, def)
        return () => registry.delete(def.name)
      },
      guard: (_fn: unknown) => undefined,
      get: (name: string, agent: FakeAgent) => registry.get(name),
      schemas: (agent: FakeAgent) => [...registry.values()].map(def => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      })),
    },
    systemPrompt: {
      section: (_section: unknown) => undefined,
    },
    on: (event: string, handler: (...args: never[]) => unknown, _opts?: unknown) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect: (_fn: unknown, _key?: unknown) => undefined,
  }
  return { ctx, handlers }
}

function setup() {
  const registry = new Map<string, FakeDefinition>()
  registry.set('skill', definition('skill', 'Load task-specific instructions.'))
  registry.set('subagent', definition('subagent', 'Delegate a self-contained task to a subagent.'))
  registry.set('web_search', definition('web_search', 'Search the web for current information.'))
  registry.set('ssh_exec', definition('ssh_exec', 'Run a POSIX sh script on a remote host over SSH.'))
  for (const index of [1, 2, 3]) {
    registry.set('matrix_row_' + index, definition('matrix_row_' + index, 'Render spreadsheet matrix row ' + String(index) + '.'))
  }
  const { ctx, handlers } = makeContext(registry)
  apply(ctx as never, { threshold: 3, alwaysVisible: ['skill'] })
  const agent = makeAgent(registry)
  const assemble = handlers.get('system-prompt/assemble')![0]!
  const next = async () => ({
    sections: [] as Array<{ name: string; text: string }>,
    tools: [...registry.values()].map(def => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    })),
  })
  const declaredNames = async (): Promise<string[]> => {
    const assembly = await (assemble as (...a: unknown[]) => Promise<{ tools: Array<{ name: string }> }>)(
      { sections: [], tools: [] },
      { agent },
      next,
    )
    return assembly.tools.map(tool => tool.name)
  }
  return { registry, handlers, agent, declaredNames }
}

describe('discovered tool declaration', () => {
  it('keeps undiscovered deferred tools out of the request surface', async () => {
    const { declaredNames } = setup()
    const names = await declaredNames()
    expect(names.sort()).toEqual(['skill', 'tool_search'])
  })

  it('declares a discovered tool so its call can be emitted natively', async () => {
    const { registry, handlers, agent, declaredNames } = setup()
    const search = registry.get('tool_search')!
    const value = (await search.execute!(
      { query: 'delegate a self-contained task to a subagent' },
      { agent },
    )) as { matches: Array<{ name: string }> }
    expect(value.matches.some(match => match.name === 'subagent')).toBe(true)
    for (const handler of handlers.get('tools/result') ?? []) {
      ;(handler as (exec: unknown, result: unknown) => void)(
        { agent, name: 'tool_search' },
        { isError: false, value },
      )
    }
    const names = await declaredNames()
    expect(names).toContain('subagent')
    expect(names).not.toContain('matrix_row_3')
  })

  it('skips discovered names whose definition left the registry', async () => {
    const { registry, handlers, agent, declaredNames } = setup()
    const search = registry.get('tool_search')!
    const value = (await search.execute!({ query: 'subagent' }, { agent })) as { matches: Array<{ name: string }> }
    for (const handler of handlers.get('tools/result') ?? []) {
      ;(handler as (exec: unknown, result: unknown) => void)(
        { agent, name: 'tool_search' },
        { isError: false, value },
      )
    }
    registry.delete('subagent')
    const names = await declaredNames()
    expect(names).not.toContain('subagent')
    expect(names).toContain('skill')
  })

  it('restores discovery from persisted session events on resume', async () => {
    const registry = new Map<string, FakeDefinition>()
    registry.set('skill', definition('skill', 'Load task-specific instructions.'))
    registry.set('subagent', definition('subagent', 'Delegate a self-contained task to a subagent.'))
    registry.set('ssh_exec', definition('ssh_exec', 'Run a POSIX sh script on a remote host over SSH.'))
    const { ctx, handlers } = makeContext(registry)
    apply(ctx as never, { threshold: 2, alwaysVisible: ['skill'] })
    // Persisted log shape: tool results are text blocks with the presentation
    // meta carried at the event data level.
    const agent = makeAgent(registry)
    ;(agent.session as { snapshotEvents: () => unknown[] }).snapshotEvents = () => [
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call_1', name: 'tool_search', arguments: '{"query":"subagent"}' },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'call_1' },
            content: [{
              type: 'text',
              text: JSON.stringify({
                protocol: 'dsh-tool-search/v1',
                query: 'subagent',
                matches: [{ name: 'subagent' }],
              }),
            }],
            isError: false,
          },
          meta: { protocol: 'dsh-tool-search/v1', allDiscoveredTools: ['subagent'] },
        },
      },
    ]
    const assemble = handlers.get('system-prompt/assemble')![0]!
    const assembly = await (assemble as (...a: unknown[]) => Promise<{ tools: Array<{ name: string }> }>)(
      { sections: [], tools: [] },
      { agent },
      async () => ({
        sections: [],
        tools: [...registry.values()].map(def => ({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        })),
      }),
    )
    const names = assembly.tools.map(tool => tool.name)
    expect(names).toContain('subagent')
    expect(names).not.toContain('ssh_exec')
  })
})
