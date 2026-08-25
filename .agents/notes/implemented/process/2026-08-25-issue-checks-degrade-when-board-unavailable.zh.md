# Agent Note：Board 自动化不可用时 Issue 检查降级

Status: implemented

[English](2026-08-25-issue-checks-degrade-when-board-unavailable.md) | 中文

## Problem

Issue lifecycle 与 Issue policy 两个 workflow 会出现在每个 Pull Request 的检查列表里，而三处部署缺口让它们全部变红，与被审查的代码无关：

- Dependabot 触发的运行读不到仓库 Secrets，`actions/create-github-app-token` 因 `private-key` 为空而拒绝。
- GitHub App 凭据已配置、但未安装到仓库时，token 铸造在安装查询处返回 404。
- Issue policy 的 GraphQL 读取需要 Projects v2 权限。Workflow 的显式权限清单漏掉了 `repository-projects`，而 Project 缺失或标题不匹配会抛出 `Could not resolve to a ProjectV2`；只要 PR 正文引用了任一真实 Issue，检查就会崩溃。

结果是每个 PR 挂着多个失败检查，起因是仓库配置而非改动本身。

## Decision

两个检查只在验证本身失败时变红；所有 Board 依赖一律降级为跳过。

Issue lifecycle 对 `dependabot[bot]` actor 关闭 token 铸造，把 token 步骤标记为 `continue-on-error`——App 未安装或配置错误只损失一次 Board 更新，不再拖垮检查——并以铸出的非空 token 作为处理步骤的门槛。

Issue policy 显式声明 `repository-projects: read`，使其 token 在 Board 存在时可以读到它。[policy.mjs](../../../../.github/issue-management/policy.mjs) 用 `tryProjectContext` 包装 Project 读取，把 Project 缺失或标题不匹配、could-not-resolve 响应、以及 Projects scope 缺失统一归类为 `{available: false}`。Board 不可达时挂起依赖 Status 与 Priority 的 Issue 规则而不是让每次审计失败；lifecycle 的状态写入在没有可达 Board 时直接跳过。标题、标签、Type、正文与引用规则继续生效。

## Verification

[Issue-management 测试](../../../../.github/issue-management/policy.test.mjs)固定了「Board 不可用时 Issue 不产生错误、但标题与标签规则仍拒绝违规」，以及快照默认视为已纳入 Board。[Workflow 测试](../../../../scripts/ci-workflow.spec.ts)固定 Dependabot 门槛、`continue-on-error`、处理步骤的 token 输出门槛，以及 `repository-projects` 授权。

## Alternatives considered

**在 App 安装且 Project 创建之前移除两个 workflow。** 检查退化为灰色跳过，PR 标签规则停止执行，用静默换掉了一个可用的门禁。

**删除 `TOH_ISSUE_APP_CLIENT_ID` 变量。** 今天能变绿，但日后重新安装 App 时同样的失败会回来，除非有人记得这层耦合；workflow 现在对两种状态都成立。

**基础设施缺失时大声失败。** 每个 PR 一个红检查确实是发现问题的方式，但它阻塞合并的原因是代码无法修复的仓库配置。

## Consequences

App 已安装、Project 存在、权限已授予时，行为不变。在此之前，PR 标签与引用验证照常运行，Issue 的 Status 与 Priority 审计保持沉默，Board 状态流转跳过；无法完整校验的 Issue 不发审计评论。token 步骤配置错误会在绿色 Job 内留下一个失败步骤和运行摘要上的注解，让缺口保持可见而不阻塞任何人。
