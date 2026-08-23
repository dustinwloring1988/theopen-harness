# Agent Note: Issue policy 从用户账号仓库读取 Project 数据

Status: implemented

[English](2026-08-23-issue-policy-user-owned-project-data.md) | 中文

## Problem

Issue policy 与 lifecycle 脚本假设仓库属于组织。它们从 `issue-field-values` REST 端点读取 Priority，而该端点只对启用了 issue fields 功能的组织存在；Project 查询也走 GraphQL 的 `organization(login:)` 根字段。在个人仓库 dustinwloring1988/theopen-harness 上这两个调用都会失败：任何正文引用了 Issue 的 pull request 都会让 Issue policy 检查在 404 处崩溃，得不到任何校验结果。引用解析还把所有 API 错误当作致命错误，因此引用一个不存在的 Issue 编号会让整个检查中止，而不是报告该问题。

## Decision

`policy.mjs` 在每个进程中通过 `GET /repos/{owner}/{repo}`（`owner.type`）解析一次 owner 类型，并据此选择 Projects v2 容器：用户账号用 `user(login:)`，组织用 `organization(login:)`；`repository(owner:)` 对两者都接受。Status 与 Priority 只从 project item 的 `fieldValueByName` 选择中读取，Priority 使用配置的 `priorityField` 名称；组织专属的 REST 端点被完全移除。`api()` 把 HTTP 状态附加到错误上，引用解析只容忍 404：无法解析的编号不会进入已解析映射，由 `validatePullRequest` 报出标准的 `#N 不是同仓库 Issue` 校验错误。其余失败继续大声报错。

## Alternatives considered

**先调 REST 端点，404 后回退到 GraphQL。** 不采用，因为该端点与 project item 已携带的单选值重复，保留它会给每次快照增加一次请求和一条回退分支，而这些数据一次 GraphQL 查询就能提供。

**同时选择两个 GraphQL 根并取非空者。** 不采用，因为二者之间的选择仍然要先知道 owner 类型；既然已经知道类型，插值容器关键字可以保持单一查询结构，而不是两个根各自重复一份 selection。

**把引用解析的所有错误都当作不可读。** 不采用，因为网络或权限故障会以误导性的 `#N 不是同仓库 Issue` 校验错误呈现，而不是让 workflow 大声失败；只有 404 能证明目标确实无法解析。

## Verification

`pnpm run test:issue-management` 通过，其中新增测试固定了未解析的引用编号会产生 `#N 不是同仓库 Issue` 校验错误；`node --check policy.mjs` 通过。user 容器与 owner 类型解析路径由仓库自身的 Issue policy 与 lifecycle workflow 实际运行。

## Consequences

Issue policy 与 lifecycle 检查在这个个人仓库上可用，组织部署的行为保持不变。Priority 现在反映 Project board 的单选值而非已退役的 issue-fields 功能，每个被引用 Issue 少一次额外 REST 调用、共享一次 GraphQL 调用。依赖 issue-field 值偏离 Project 值的部署不再受支持。
