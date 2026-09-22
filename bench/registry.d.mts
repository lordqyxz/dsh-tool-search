import type { ToolSchemaView } from '../src/types.js'

export interface BenchTool extends ToolSchemaView {
  readonly nameQuery: string
  readonly capQuery: string
}

export const MAX_REGISTRY: number
export function buildRegistry(count?: number): BenchTool[]
