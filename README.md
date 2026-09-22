# dsh-tool-search

Vendor-style deferred tool loading for DeepSeek Harness. Mirrors the deferred-loading model of provider-hosted tool search: every deferrable tool contributes only its name and purpose to the stable request surface, the discovery tool returns full parameter schemas on demand, and discovered tools are called directly through the ordinary Harness execution pipeline.

## 简介（中文）

dsh-tool-search 是一个 DeepSeek Harness（DSH）插件，为工具注册表提供厂商风格的**延迟加载（deferred tool loading）**能力。

它解决的问题：当宿主注册的工具数量很多时，把所有工具的完整参数 Schema 常驻在请求里会占用大量上下文。本插件的做法是：

- **常驻目录区** — 系统提示词中每个可延迟工具只保留一行「名称 + 截断用途」，注册表不变时字节数完全稳定。
- **搜索展开 Schema** — 注册一个 `tool_search` 发现工具，用精确名加权 + 紧凑 BM25 风格打分（支持 CJK 二元分词）对工具排序，只返回最相关工具的完整参数 Schema。
- **发现后直接调用** — 没有调度器转发。已发现的工具按精确名称直接调用，走完整的宿主执行管线（校验、审批、守卫、超时、结果策略）；单调递增的守卫会拒绝未发现工具的直接调用，并提示自愈路径（先搜索）。
- **按工具发现** — 一次搜索只解锁返回的工具名，不解锁整个工具族。
- **阈值惰性** — 可延迟工具数低于配置阈值时插件完全惰性，所有工具保持全量可见。
- **可恢复** — 发现状态基于事件溯源：搜索结果在 presentation meta 中携带累积发现列表，重建的 agent 状态可从会话日志恢复。

## Semantics

- **Resident catalog section.** The system prompt lists every deferred tool as one line: name plus a truncated purpose. Bytes stay stable while the tool registry is unchanged; a registry change rebuilds the section.
- **Search expands schemas.** The registered search tool ranks individual tools with exact-name bonuses plus a compact BM25-style score over names, descriptions, and parameter text, and returns full parameter schemas for the top matches. CJK queries tokenize through character bigrams.
- **Direct calls after discovery.** There is no dispatcher. A discovered tool is called by its exact name and re-enters the full pipeline (validation, approval, guards, timeouts, result policy). A monotonic guard denies direct calls to deferred tools that have not been discovered and names the self-healing next step.
- **Per-tool discovery.** One search unlocks exactly the returned tool names, never a family.
- **Threshold.** Below the configured threshold of deferrable tools the plugin is inert: all tools stay fully visible and the search tool reports that nothing is deferred.
- **Resume.** Discovery state is event-sourced: the search result carries a cumulative discovered list in presentation meta, and a rebuilt agent state restores it from the session log.

The reserved run_code transport stays exempt from deferral and the guard.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| toolName | tool_search | Registered discovery tool name |
| alwaysVisible | skill, ask_user_question, report, submit_*, structured_output* | Wildcard patterns whose full schemas stay directly visible (deferrable: never) |
| threshold | 15 | Deferred loading activates at or above this many deferrable tools |
| maxResults | 5 | Maximum full definitions returned by one search |
| requireDiscovery | true | Deny direct calls to undiscovered deferred tools |
| charactersPerToken | 4 | Schema characters per estimated token |
| descriptionChars | 110 | Per-tool purpose cap in the resident catalog section |
| deferToolGuidance | true | Strip per-tool guidance prompt sections of the stable prompt |

alwaysVisible is a replacement list: keep the defaults when extending it.

## Efficiency / 效率对比

方法：120 个合成工具（12 领域 × 10 操作）的真实 JSON Schema，全部指标由 `buildCatalog` / `searchTools` 实测，非估算。基线 = 全量 Schema 常驻；对比 = 目录区常驻 + 按需搜索。

| Tools | 基线 tok/请求 | 插件 tok/请求 | 常驻节省 | 单次搜索 tok | 回本搜索次数 | Top-1（名称） | R@5（同义改写） | 搜索延迟 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 15 | 1849 | 596 | 67.8% | 755 | 1 | 100% | 100% | 108 µs |
| 30 | 3706 | 1025 | 72.3% | 756 | 1 | 100% | 100% | 213 µs |
| 60 | 7347 | 1820 | 75.2% | 756 | 1 | 100% | 100% | 454 µs |
| 120 | 14632 | 3417 | 76.6% | 756 | 1 | 100% | 100% | 986 µs |

- **1 次搜索即回本**：省下的常驻开销一次搜索就覆盖其自身成本，此后每次请求持续净省。
- **质量**：精确名称查询全部排第一；不含名称词的同义改写查询 100% 命中 Top-5。
- 回归守护：`tests/efficiency.spec.ts` 锁定节省率 ≥70%、回本 ≤2 次、命中率 ≥95%。
- 复现：`pnpm run bench`（代码见 [bench/](bench/)）。

## Development

```bash
pnpm install          # pnpm 11, Node 22.19+ or 24+
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # oxlint src tests
pnpm run test         # vitest run
pnpm run bench        # build + efficiency benchmark
pnpm run build        # tsc -> lib/
pnpm run check        # typecheck + lint + test + build
```

## Limitations

- Ranking is lexical; vocabulary gaps (repository vs project, remember vs save) can misrank. The resident catalog section keeps every name and purpose visible so the model can search again with exact words.
- Descriptions are inputs to ranking; tools with empty or generic descriptions rank poorly.

## License

[MIT](LICENSE)

## Tags

`deepseek-harness` · `dsh` · `cordis` · `tool-search` · `deferred-loading` · `tool-deferral` · `context-optimization` · `token-optimization` · `system-prompt` · `plugin` · `typescript`
