# `@buckeyestudio/toh-desktop`

[English](README.md) | 中文

桌面容器应用：用一个 Electron 窗口承载 Harness Web GUI。其主进程挑选一个空闲回环端口，在其上启动构建好的 `toh web` 后端，等待该端口响应 HTTP，再在窗口中加载它；关闭窗口即停止整个后端进程树。

## 运行

生产运行需要先完成构建产物。在仓库根目录执行：

```sh
pnpm run build
pnpm --filter @buckeyestudio/toh-desktop exec electron .
```

应用拒绝并发第二个实例：再次启动只会聚焦已有窗口，而不会启动第二个后端。

## 组成方式

| 模块 | 职责 |
|---|---|
| [`src/main.ts`](src/main.ts) | Electron 主进程：窗口生命周期、单实例锁、导航防护、致命错误对话框。 |
| [`src/backend.ts`](src/backend.ts) | 挑选空闲的 127.0.0.1 端口，以普通 Node（Loader 的模块解析需要原生 Node 语义）运行 `apps/cli` 构建出的 `lib/bin.js`，参数为 `--profile web --port <端口> --no-open`；通过轮询 HTTP 服务确认就绪，并在退出时负责进程树终止。 |

就绪判断是对后端服务的 HTTP 探测，而不是读取其标准输出：GUI 子进程的管道式标准输出会干扰 CLI 的模块解析，探测也让启动与后端的 `printUrl` 组合解耦。渲染层保留普通浏览器传输（对 `/api` 网关的回环 HTTP 加 SSE）；没有 preload 桥接，除 `toh web` 已绑定的 127.0.0.1 监听外也没有额外的监听面。跨源导航会被拒绝，新窗口请求转交默认浏览器。

## 已知限制与延后工作

- 尚无打包与分发（无安装器、无捆绑运行时）：应用从已构建的检出目录运行，需要 PATH 中有 `node` 来启动后端，并要求 Harness 所需的各工具可用。
