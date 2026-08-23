# Agent Note: Python SDK atomic runtime spawn and bounded shutdown

Status: implemented

[English](2026-08-23-sdk-start-spawn-race-and-bounded-shutdown.md) | 中文

## Problem

`HarnessClient.start()` 在实例锁之外读取 `self._proc`，因此两个并发调用可能同时通过已启动守卫，各自启动一个运行时子进程，第二次赋值会把第一个进程连同其 profile 一起变成孤儿。另外，`close()` 把 `shutdown_timeout_seconds=None` 原样传入 JSON-RPC 关闭请求和 `Popen.wait()`，而 `None` 在两处都表示无限等待：一个卡死的运行时会让 `close()` 永远阻塞，包括经 `__exit__` 触发的路径，上下文管理器体内的异常可能演变为不可中断的挂起。

## Decision

`start()` 把完整的检查与启动放在实例锁内执行，并在锁内为 `self._proc` 赋值，因此一个客户端最多拥有一个运行时子进程。

`close()` 从钳制到 [0, 30] 秒区间的 `shutdown_timeout_seconds` 推导出一个单调时钟截止时间——`None` 选择该上限而非无限等待——把这份预算分配给关闭请求与 terminate 后的等待，然后从 `terminate()` 升级到 `kill()`，并附带固定的五秒回收等待。30 秒上限是固定的活性不变量，而不是可配置的调节项：即使运行时无视关闭握手和终止信号，`close()` 也必须返回，同一上限同样保护 `__exit__`。

## Verification

pytest 套件以 fake 运行时对端驱动验证：八个经屏障同步的 `start()` 调用只记录到一个启动进程 id；在把上限补丁调小后，面对忽略 SIGTERM 且在 shutdown 中睡眠的对端，`shutdown_timeout_seconds=None` 的 `close()` 也能迅速返回；一个 fake Popen 记录升级路径确实到达 `kill()`，且未选择预算与已配置预算两种情况下等待值都是钳制后的非 `None` 数值。

## Alternatives considered

**在每个调用点独立钳制（`min(configured or cap, cap)`）。** 更简单，但请求与进程等待可能各自耗尽完整预算，最坏拆除时间翻倍；共享一个截止时间能把 close 总时长控制在一个预算加回收等待之内。

**允许调用方配置上限。** 不予采纳，因为保证是 `close()` 总会返回；把上界做成可配置会经由 `__exit__` 重新引入无界阻塞。

**只把锁扩大到守卫读取。** 不予采纳，因为竞态窗口只是移到赋值处；检查与启动必须处于同一个临界区才能串行化重复启动。

## Consequences

卡死的运行时现在最多耗费约 35 秒拆除时间，而不再挂起调用方；超过 30 秒的合作式关闭不再可表达。并发的 `start()` 调用方会在一次进程启动后串行排队，付出单次进程启动延迟，而不是泄漏重复运行时。
