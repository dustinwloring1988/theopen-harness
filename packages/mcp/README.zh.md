# MCP — 模型上下文协议

[English](README.md) | 中文

将 harness 与 MCP 生态系统桥接的包。

| 包 | 职责 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | MCP 客户端桥接，将外部服务器工具注册到 `ctx.tools`，并可在启用时把服务器 Prompts 作为 skill provider 候选发布到 `ctx.skills` |
