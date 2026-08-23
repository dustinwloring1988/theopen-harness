# Agent Note：文档审计修复——清单门禁、规范术语表、真实快速开始

Status: implemented

[English](2026-08-23-documentation-audit-remediation.md) | 中文

## 问题

一次文档审计（#67）发现了四组缺口。手工维护的清单在没有任何门禁的情况下发生了漂移：根目录 `AGENTS.md` 记录的两个包组名称已不存在，且遗漏了十六个包组和 `apps/`；[`packages/README.md`](../../../../packages/README.zh.md) 的表格遗漏了生成模块图早已列出的两个组。用户文档重定向到一个只在网站上可解析的 quickstart 路由，GitHub 读者会走进死胡同。术语表只有三条入站链接，而三份文档却在行内重复定义它的术语。Cordis 入门的分发模式表遗漏了 vendor 中的第五种模式（`bail`，见 `vendor/cordis/src/events.ts`）。快照录制命令只有 POSIX 环境变量前缀形式，在本仓库的开发平台 PowerShell 上原样执行必然失败。测试策略承载了规则却没有操作演练。

## 决策

- **清单门禁**：[`verify-package-inventory`](../../../../scripts/verify-package-inventory.ts) 加入 `doc-sync`，把两份手工维护的清单与磁盘上的 `packages/*/` 做差集比对，沿用生成目录已有的一致性约束。
- **入口路径**：`docs/user/guide/index.md` 成为真实的 `quickstart.md`，承载前置条件（Node 版本下限）、两种运行路径、密钥放置和 SDK 指引；网站 manifest 把同一来源投影到相同的 `guide/quickstart` 路由，因此重定向目标在仓库内真实存在。
- **规范术语**：术语表是术语定义的唯一归属；`architecture.md`、生成的 capability-seams 引言（经 `gen-doc-graphs.ts`）和 primer 链接到它，而不是各自复述定义充当权威。primer 补上缺失的 `bail` 模式，并新增 scope 与 realm 的桥接段落，解释 `isolate` realm 要求。
- **流程归属**：从套件到表面的路由、场景表、本地过滤运行和录制／评审步骤移入实操手册 `writing-tests-and-snapshots-for-a-seam.md`；`testing.md` 保留策略，并提供双 shell 的命令形式。

## 已考虑的替代方案

- **从磁盘生成两份清单**——否决：布局清单承载判断（角色描述、分组方式），生成器无法产出；用差集门禁保持判断诚实，而不把它冻结成目录。
- **保留 quickstart 作为仅网站别名**并改写重定向——否决：GitHub 是主要阅读面之一，只有真实文件能修复它。
- **让子系统页面继续链接各 seam 设计 Agent Note**——有意保留：单个 seam 的设计笔记仍是细节归属；只有术语级定义收归术语表。

## 后果

清单漂移会变红而不是悄悄累积；新增包组必须在同一变更中更新两份清单和自己的 README（`runtime-diagnostics/` 在此补齐了组 README）。预算上限因新增的清单行和桥接内容上调：`AGENTS.md`（2200）、`packages/README.md`（1080）、`cordis-primer.md`（760）。验证：`pnpm run doc-sync` 全绿，包括新门禁先在植入陈旧行与删除行的情形下证明变红、再证明恢复绿色。
