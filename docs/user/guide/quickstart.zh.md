# 快速开始

[English](quickstart.md) | 中文

本指南带你从零完成第一个任务。Web UI 是交互式路径；headless CLI 运行单个任务后退出。

## 前置条件

- Node.js `^22.19 || >=24`（用 `node --version` 检查）
- 一个 [DeepSeek API 密钥](https://platform.deepseek.com/)（或任何 OpenAI 兼容端点）。命令从环境变量或工作目录下 gitignore 的 `.env` 读取密钥；Web UI 也可以在**设置 → 模型**中保存。
- 一个允许 agent 修改的隔离工作区目录

## 启动 Web UI

```sh
npx @buckeyestudio/toh web
```

该命令会在 `http://127.0.0.1:3080` 启动服务器并在浏览器中打开；传入 `--no-open` 可跳过打开浏览器。然后：

1. 在**设置 → 模型**中输入密钥并保存；其他提供方见[模型配置指南](./providers.zh.md)。
2. 点击**选择工作区**，添加你的项目目录并选中它——选中前输入框不可用。
3. 启动一个会话并发送：*Summarize this repository and identify its main packages.*

Agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划；当当前权限策略要求审批时，会先询问你。

## 或从源码运行

```sh
git clone https://github.com/dustinwloring1988/theopen-harness.git
cd theopen-harness
pnpm install
pnpm run build
pnpm toh web
```

## 单次 headless 运行

在源码检出中，把 `DEEPSEEK_API_KEY` 放入环境变量或仓库根目录 `.env` 后运行：

```sh
pnpm toh --profile headless "summarize this workspace"
```

它会创建并持久化一个新会话，打印最终 assistant 文本，然后退出。[其他 CLI 模式](../../../apps/cli/README.zh.md)包括桌面应用和 ACP 自动化服务器。

## 继续使用

- [Cordis 教程](../../cordis-tutorial/index.zh.md)——动手插件练习，无需 API 密钥
- [使用 Python SDK](./python-sdk.zh.md)——其内置运行时仅支持 Linux x64/arm64 和 macOS arm64，不支持 Windows
- [配置模型](./providers.zh.md)
- [开发插件](../develop/basic/index.zh.md)
