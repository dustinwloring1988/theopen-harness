# 运行时诊断

[English](README.md) | 中文

承载 Harness 横切运行时诊断设施的包。

| 包 | 职责 |
|---|---|
| [`invariants/`](invariants/README.zh.md) | 包自有运行时不变式检查的注册表服务（`ctx.invariants`）；每个工作区包都会发布一个 `./invariant` 配套插件 |
