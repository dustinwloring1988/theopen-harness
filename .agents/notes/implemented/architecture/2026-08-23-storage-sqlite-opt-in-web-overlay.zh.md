# Agent Note: storage-sqlite composes as an opt-in Web storage overlay

Status: implemented

[English](2026-08-23-storage-sqlite-opt-in-web-overlay.md) | 中文

## 问题

`@buckeyestudio/toh-storage-sqlite` 实现完整、契约测试齐备，却没有任何组合点：没有 workspace 清单消费它，出厂 Web 组合把所有域都路由给 `toh-storage-json`，runtime-closure 清单里也没有它。它自己的测试套件是唯一使用者，这让 knip 看不见缺口，同时违反了 packages 规则中“每个抽象必须有当前所有者与需求”的要求（[领域 KV 存储设计](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)早已指明它的预期角色：高 churn 或大规模域的路由目标）。

## 决策

该后端以可选示例 overlay 的方式组合，而非进入出厂默认：

- [`examples/web-storage-sqlite/cordis.yml`](../../../../examples/web-storage-sqlite/cordis.yml) 插入一行 `storage-sqlite`（数据库位于 `$TOH_HOME/storages/workspace.sqlite3`），并给 `storage-domain` 打上 `routes: { workspace: sqlite }` 补丁；用 `toh web --patch` 启动。只有 `workspace` 域更换介质。
- 该 overlay 经由 `apps/cli` 的依赖面解析（`@buckeyestudio/toh-storage-sqlite` 已加入其 dependencies），与 `web-schedule` 是同一条解析路径。
- `apps/cli/tests/web-storage-sqlite-overlay.e2e.ts` 无 key 地启动出厂 Web 组合加该 overlay，断言两个后端并列注册，且 workspace 记录以持久行落在被路由的数据库文件里。

出厂默认在所有域上保持 `json`：没有任何 bundle patch 改动，既有部署的启动行为不变。

## 已考虑的备选方案

- **移入 `packages/experimental/` 暂存** — 拒绝：per-domain `routes` 配置使真实组合只差一行配置、零代码改动；暂存等于用一个可用的消费者换来的却是 tsconfig 聚合与生成图谱的全套目录扰动。
- **组合进出厂 web-app bundle** — 拒绝：当前没有生产域需要在规模下做行级点更新，且产品规则要求 opt-in 不得进入出厂默认。
- **新增卫生门禁，要求每个非 experimental 插件至少出现在一个 bundle/example/runtime-closure 清单** — 作为后续工作延后；本 PR 只关闭这一具体缺口，不引入新门禁。

## 后果

- 该后端有了当前所有者（有文档的 overlay）和明确需求（高 churn 域路由至此），在不触碰默认行为的前提下满足所有权规则。
- 既有部署切换到 overlay 不会迁移原有 JSON 记录；预发布立场拒绝跨介质迁移，overlay README 已声明这一点。
- knip 依旧无法发现这类组合缺口（包自身的测试即算作消费者）；上文延后的卫生门禁选项才是机械捕获此类缺口的位置。
