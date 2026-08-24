# Agent Note: 会话搜索排名的单一来源

Status: implemented

[English](2026-08-23-session-search-rank-single-source.md) | 中文

## Problem

会话搜索的排名约定此前存在于两处，仅靠注释保持同步。SQLite 后端把排名键写死在三处 SQL 排序中——每会话最强事件窗口、跨会话分页顺序和事件分页顺序；浏览器开发 fixture 则用同样的五个键手写了 `compareSearchCandidates`。每个位置的注释都写着“update both together”，但任何一侧改动时都不会有任何东西失败：事件排序早已在结构上偏离会话排序（省略了 session-id 决胜键），也没有任何测试比较两个实现。

## Decision

[`@buckeyestudio/toh-session-query/ranking`](../../../../packages/session-query/session-query/src/ranking.ts) 现在拥有有序排名键定义。`SESSION_SEARCH_RANK_KEYS` 以数据形式一次性声明跨会话顺序（列名、候选字段、方向）；`SESSION_SEARCH_EVENT_RANK_KEYS` 从它派生，去掉在事件范围和每会话窗口内恒定的 session-id 键，因此共享同一 session id 的任意两行在两份列表下的相对顺序由构造保证一致。`sessionSearchRankOrderSql()` 生成 ORDER BY 主体，`compareSessionSearchCandidates()` 用同一份列表比较候选。

SQLite 后端把生成的片段插入全部三处排序，SQL 文本逐字节保持不变。fixture 的每会话最强事件改用事件列表排序，跨会话结果改用会话列表排序，替换了手写比较器。由于该模块零导入且不持有状态，客户端 bundle 纯度预设只把 `/ranking` 子路径接纳为可内联的安全线层，`toh-session-query` 其余部分仍是被拒绝的泄漏；`packages/client/connection` 以 peer 加 dev 声明该包。放置位置遵循能力接缝布局：排名顺序是 Service Definition 包拥有的搜索约定的一部分，两个消费方无需新包或依赖环即可导入。

## Alternatives considered

- **新建零依赖包**（`toh-session-query-ranking`）。落败原因：在现有 Service Definition 包上增加子路径导出即可获得同等的导入隔离和唯一定义 home，免去整套新包注册流程，且该接缝本就拥有搜索结果排序。
- **保留镜像、用字符串测试钉住。** 断言生成的 ORDER BY 文本能冻结 SQL 拼写，但比较器仍可能错误实现同样的键；两份定义依然存在。
- **仅靠注释同步（现状）。** 本 issue 已否定：注释未能让三处 SQL 排序与一个 JS 比较器保持一致。

## Consequences

- SQL 排序与 fixture 排序再也无法从任一实现静默漂移：两者派生自同一份列表，修改列表会同侧影响双方。
- `session-query-sqlite/tests/ranking-conformance.spec.ts` 的一致性套件用覆盖每个决胜层级的语料库驱动真实引擎，断言返回分页与比较器推导的顺序完全相等；对 SQL 方向做本地翻转的变异检查曾使该套件失败，随后已还原翻转。
- `packages/client/connection` 与 `@buckeyestudio/toh-session-query` 建立 peer 加 dev 关系；生成的模块图记录该边，`scripts/client-bundle-purity.spec.ts` 审计只有 ranking 子模块可被内联。

## Related

SQLite 归属与 tokenizer 决策仍由[已实现搜索记录](../feature/2026-07-10-sqlite-session-query-provider.zh.md)负责。
