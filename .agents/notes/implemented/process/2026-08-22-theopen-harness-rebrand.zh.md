# Agent Note: 将 DeepSeek Harness 更名为 TheOpen Harness

Status: implemented

[English](2026-08-22-theopen-harness-rebrand.md) | 中文

## 问题

项目在支持多个 LLM provider 的同时，处处带有 DeepSeek 产品品牌：npm scope `@deepseek-ai`、`dsh` CLI／bin 前缀、约 250 个 `DSH_*` 环境变量、`~/.dsh` 主目录、Python 分发包名，以及数以千计的散文提法。这个名字描述的是最初的模型供应商，而不是产品本身，也妨碍了这个 harness 在 DeepSeek provider 只是众多选项之一时拥有一个中立的家。

## 决策

以一次原子变更更名为 TheOpen Harness。映射关系：

- 产品名 "DeepSeek Harness" → "TheOpen Harness"；仓库 slug → `dustinwloring1988/theopen-harness`。
- npm scope `@deepseek-ai/*` → `@buckeyestudio/*`；包前缀 `dsh-*` → `toh-*`；第一方 manifest 声明 `"author": "buckeyestudio"`（vendored 包保留上游作者署名）。
- CLI bin 与根脚本 `dsh` → `toh`；环境变量前缀 `DSH_*` → `TOH_*`；主目录 `~/.dsh` → `~/.toh`；发布族 id 为 `toh`。
- Python 分发包为 `theopen-harness-sdk` / `theopen-harness-runtime-bin`，导入模块为 `theopen_harness` / `theopen_harness_runtime`，线路身份为 `theopen-harness-sdk-runtime`。

DeepSeek provider 保留原有命名：`@buckeyestudio/toh-llm-deepseek`、`web-search-deepseek`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 与 DeepSeek 模型 id 一律不变。已归档的 Agent Note 保持冻结，包括其原始的 `dsh-*` 文件名。

## 已考虑的替代方案

保留 DeepSeek 品牌被否决，因为它命名的是供应商而非产品，一旦其他 provider 成为一等公民就会产生误导。兼容垫片（双环境变量前缀、旧包别名）在预发布立场下被否决：不存在外部使用者，而每个垫片都会变成需要测试与文档化的永久表面。只改显示名而保留 `dsh`／`DSH_` 标识符被否决为最坏的拆分——代码、文档与注册表名会对产品叫什么各执一词。

## 影响

预发布立场吸收了这些破坏：既有的 `~/.dsh` 数据、`DSH_*` 环境与已安装的 `@deepseek-ai/*` tarball 不做迁移。在发布工作流运行之前，必须先存在 `@buckeyestudio` npm 组织与对应 PyPI 包名。线路字段 `serverInfo.name` 已从此前的协议稳定拼写改变；任何固定使用旧值的客户端必须同步更新。
