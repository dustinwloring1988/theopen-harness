# TheOpen Harness

[English](README.md) | 中文

TheOpen Harness（`toh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

TheOpen Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 Node.js 22.19+ 或 24+，然后运行：

```sh
npx @buckeyestudio/toh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见[快速开始](docs/user/guide/quickstart.zh.md)。

<a id="headless-one-shot"></a>

### 单次 headless 运行

在环境变量或 `.env` 中配置 `DEEPSEEK_API_KEY` 后：

```sh
npx @buckeyestudio/toh --profile headless "summarize this workspace"
```

它会在一个新建的持久会话中运行单个任务，打印最终 assistant 文本，然后退出——无需浏览器。

<a id="python-sdk"></a>

### Python SDK

[Python SDK](python/README.zh.md) 让你通过 `pip` 以编程方式驱动 harness；其内置运行时仅支持 Linux x64/arm64 和 macOS arm64。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/dustinwloring1988/theopen-harness.git
cd theopen-harness
pnpm install
pnpm run build
pnpm toh web
```

`pnpm run build` 会准备仓库产物。`pnpm toh web` 会直接使用这些已构建产物，不会重新构建。

<a id="desktop-app"></a>

### 桌面应用

```sh
pnpm toh desktop
```

桌面命令会围绕同一个 Web UI 打开一个 Electron 窗口：该窗口自行拉起并持有 loopback 端口上的 web 后端，因此关闭窗口即停止 Harness——无需单独的服务器或浏览器标签页。再次启动时只聚焦已有窗口，不会另起后端。应用需要已构建的检出（`pnpm run build`）以及 PATH 中的 `node`。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/dustinwloring1988/theopen-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`toh-plugin`](https://github.com/topics/toh-plugin) 话题，便于被发现。
- 欢迎加入 TheOpen Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="TheOpen Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="TheOpen Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="TheOpen Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
