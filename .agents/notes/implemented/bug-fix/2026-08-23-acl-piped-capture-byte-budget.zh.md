# Agent Note: AclSandbox 管道捕获字节预算

Status: implemented

[English](2026-08-23-acl-piped-capture-byte-budget.md) | 中文

## 问题

`AclSandbox.spawn({ stdio: 'pipe' })` 把被隔离子进程的 stdout 和 stderr 排空到无界的内存缓冲里：`drainPipe` 拼接每一个轮询到的数据块，全程没有任何大小限制。`AclSandbox` 是本包的公共 API，因此任何直接使用者都会继承一项无界的宿主内存承诺——多话或失控的子进程会让宿主进程一直增长直到 OOM。交付的组合掩盖了这个缺陷，因为 `LocalSandboxProvider.confine()` 只返回 argv、执行器通过有界的 subprocess seam 收集输出，而 runner 本身以 `stdio: 'inherit'` 启动；仓库中其他所有 spawner 都强制字节预算（subprocess seam 的 `OutputCollector`、E2B 输出读取器）。

## 决策

`drainPipe` 接收一个必填的保留字节上限并保留有界的尾部：一旦到达的字节超过 `maxBytes`，就丢弃整个头部数据块（或裁剪单个超限数据块的头部），直到恰好剩下最近的 `maxBytes`——即 subprocess seam 的 `OutputCollector` tail-keep 形态，采纳它的理由是其记录在案的依据：错误和最终结果集中在命令输出的末尾。无论子进程如何分块或产出多少字节，保留量都不会超过上限，且管道句柄在每条路径上仍然关闭。

`AclSandboxSpawnOptions` 新增 `maxOutputBytes`：单流预算，分别独立作用于 stdout 与 stderr，与 subprocess seam 的按流收集器一致。默认值为 64_000（`DEFAULT_MAX_OUTPUT_BYTES`），即仓库标准的单流输出预算（`toh-bash-local`/`toh-pwsh-local` 的 `maxOutputBytes` 配置）。`spawn()` 把默认值作为显式步骤解析，并在 spawn 之前拒绝非正数或非有限数值——NaN 或 Infinity 预算会静默禁用尾部裁剪，因此配置错误在边界处响亮失败。`stdio: 'inherit'` 忽略该选项：字节直接透传，没有任何缓冲。

## 验证

`tests/drain-bound.spec.ts` 钉住排空层的 tail-keep（低于上限的输出跨轮询保持完整、两条头部丢弃路径都得到按字节精确的最后 `maxBytes` 窗口、单个超限数据块被裁剪为尾部），并在 win32 宿主上驱动真实的被隔离子进程：一个在小显式上限下超量产出的子进程和一个使用默认预算的子进程。`tests/index-failure-paths.spec.ts` 的桩测试台钉住 spawn 侧解析：显式上限作用于两个流、省略选项时应用默认值，以及在任何 spawn 之前响亮拒绝非法值。

## 已考虑的替代方案

**把管道路径改走 subprocess seam 的 `OutputCollector`。** 否决：该收集器还拥有本包并不消费的溢出文件与增量全流读取能力，而把 `toh-subprocess-local` 引入 koffi 后端的沙盒包，等于为一个「裁剪再拼接」的循环增加工作区依赖。在不引入溢出机制的前提下镜像尾部语义即可获得同样的上界。

**到达上限就停止排空或终止子进程。** 否决：退出码必须保持权威、收集必须运行到 EOF，因此收集器应保留诊断尾部而不是在中途放弃。

**保留完整内容，仅用文档说明风险。** 否决：报告的缺陷正是无界缓冲本身；写进文档无法约束宿主内存。

## 后果

直接使用 `AclSandbox` 的调用方默认获得内存有界的管道捕获；需要更多历史的调用方显式调高 `maxOutputBytes` 并接受相应的内存上界。超出预算的输出会从返回的 Buffer 中丢失（丢弃头部），这与 subprocess seam 无溢出文件时的诊断尾部行为一致；本包刻意不提供溢出文件模式，因此被丢弃的头部无法通过此 API 找回。
