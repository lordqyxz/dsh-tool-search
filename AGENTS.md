# Agent instructions

Guidance for coding agents working in this repository.

## Overview

dsh-tool-search is a DeepSeek Harness (DSH) plugin providing vendor-style deferred tool loading. A resident system-prompt section lists every deferred tool with a one-line purpose; the tool_search tool returns full parameter schemas on demand; discovered tools are called directly, guarded by a monotonic require-discovery check.

## Layout

| Path | Purpose |
| --- | --- |
| src/index.ts | Plugin entry: config resolution, tool registration, resident prompt section, guard, lifecycle events |
| src/catalog.ts | Catalog construction, wildcard matching, BM25-style search with CJK bigram tokens |
| src/defaults.ts | Default config values and always-visible patterns |
| src/types.ts | Shared public types |
| tests/ | Vitest unit suites |

## Commands

Supported host core baseline: 0.1.6-alpha.2. Core peers are pinned; do not broaden without a compatibility run. Dependency duplication across release lines breaks cordis Context augmentation under skipLibCheck:false — pin overrides in pnpm-workspace.yaml.

    pnpm install          # pnpm 11, Node 22.19+ or 24+
    pnpm run typecheck    # tsc --noEmit
    pnpm run lint         # oxlint src tests
    pnpm run test         # vitest run
    pnpm run build        # tsc -> lib/
    pnpm run check        # typecheck + lint + test + build

## Invariants

1. Registrations are effects: every contribution goes through ctx.effect() / ctx.on() and is reversible on unload.
2. Discovery state is reconstructable from the session log (presentation meta on tool_search results); resume restores it.
3. Deferred tools execute through the full DSH pipeline; the guard only denies, never allows around policy.
4. The resident catalog section is a pure function of the tool registry; unchanged registries produce identical bytes.
5. Threshold below the deferrable count disables all deferral behavior; the plugin must stay inert, not partially active.

## Content policy

- Never mention AI assistant identities, AI vendors, or model or product names of AI systems in code, comments, documentation, commit messages, or any other project text. Describe capabilities and protocols generically (for example vendor-style deferred tool loading) instead of naming a provider.
- No attribution footers or co-author trailers on commits.
