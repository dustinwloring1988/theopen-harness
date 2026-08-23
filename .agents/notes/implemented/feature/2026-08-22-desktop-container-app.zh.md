# Agent Note: 桌面容器应用 —— 单一 Electron 窗口承载派生的 Web 后端

Status: implemented

[English](2026-08-22-desktop-container-app.md) | 中文

## 问题

此前使用该 agent 只有两条路径：在终端手动启动 `toh web` 服务再开浏览器标签页，或使用 headless 一次性 CLI。想要"这个应用"的用户必须打开终端、启动服务、记下端口、再把浏览器指向它；关闭浏览器后服务仍在运行，也没有任何一个窗口完整承载产品。

## 决策

`apps/desktop`（`@buckeyestudio/toh-desktop`）是一个 Electron 容器，其主进程拥有完整技术栈：挑选一个空闲的 127.0.0.1 端口，以 `--profile web --port <端口> --no-open` 启动 `apps/cli` 构建出的 `lib/bin.js`，等待该端口响应 HTTP，再在单一窗口中加载它。关闭窗口会终止后端整个进程树（Windows 上 `taskkill /T`，其余平台 `SIGTERM`）。通过单实例锁，再次启动只会聚焦已有窗口，而不会针对另一个数据目录启动第二个后端。跨源导航会被拒绝，新窗口请求转交默认浏览器。

两个启动属性是关键约束：

- **子进程使用 PATH 中的原生 `node` 运行，绝不用 Electron-as-Node。** 供应商化的 Loader 通过 `node-addon-require-builtin` 触及 Node 内部 ESM 机制；在 Electron 内嵌的 Node 运行时下，profile 启动无法解析内置插件。原生 Node 可以正常启动同一组合。
- **就绪判断是对派生服务的 HTTP 探测，而不是其标准输出的 URL 行。** 当 GUI 子进程使用 libuv 创建的 stdio 管道时，曾观察到 CLI 的模块解析被破坏（内置插件导入回退到以 vendor Loader 自身位置为 referrer）；继承式流则可正常启动。探测也让启动与后端的 `printUrl` 组合解耦，否则那会成为隐藏的启动依赖。

## 备选方案

- **Tauri** —— 否决：它会为纯 Node 仓库引入 Rust 工具链与 sidecar 进程打包，而后端运行时本就需要 Node；Electron 保持单一语言和单一进程模型。
- **用原生 IPC 取代一切 HTTP 服务**（前端走 `file://` 加载，`ctx.apiProxy` 经 Electron IPC 由 client transport hooks 承载）—— 延后：它需要改造 `toh-client-connection` 的信任围栏与 boot kernel 各接缝，而当前并无此需求，且回环传输已具备同源围栏。若未来出现禁用套接字的部署形态，该接缝已被文档化为可用。
- **读取标准输出 URL 行作为就绪信号**（浏览器跳转自身使用的信号）—— 因上述管道式 stdio 故障否决；且静默 `printUrl` 的组合会让启动无声挂起。
- **后端子进程使用 `ELECTRON_RUN_AS_NODE=1`** —— 否决：无论 stdio 形态如何，Electron 内嵌 Node 下启动均失败，原因即 Loader 对内部机制的依赖。

## 后果

- 单窗口成为产品入口：启动桌面应用即随之启动与停止 harness，GUI 用户不再需要 URL 行加终端的流程。
- 工作区新增 `electron` 构建脚本白名单条目（`pnpm-workspace.yaml`），其 postinstall 会下载 Electron 运行时二进制；CI 安装时间相应增加。
- 应用从已构建的检出目录运行，需要 PATH 中有 `node` 以及 harness 自身所需的各工具；打包为带捆绑运行时的安装器仍是后续工作（当前限制见 [README](../../../../apps/desktop/README.zh.md)）。
- 作为应用而非插件包，`apps/desktop` 不提供 Cordis 服务，因此不注册 package invariant；其行为由 backend handle 的单元测试（就绪 URL 匹配、退出拒绝、进程树终止）以及真实检出启动验证。
