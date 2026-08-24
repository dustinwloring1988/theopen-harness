# Agent Note: Python SDK atomic runtime spawn and bounded shutdown

Status: implemented

[English](2026-08-23-sdk-start-spawn-race-and-bounded-shutdown.md) | 中文

## Problem

`HarnessClient.start()` 在实例锁之外读取 `self._proc`，因此两个并发调用可能同时通过已启动守卫，各自启动一个运行时子进程，第二次赋值会把第一个进程连同其 profile 一起变成孤儿。另外，`close()` 把 `shutdown_timeout_seconds=None` 原样传入 JSON-RPC 关闭请求和 `Popen.wait()`，而 `None` 在两处都表示无限等待：一个卡死的运行时会让 `close()` 永远阻塞，包括经 `__exit__` 触发的路径，上下文管理器体内的异常可能演变为不可中断的挂起。对修复本身的审查又暴露了三个活性缺口：`close()` 在任何与 `start()` 共享的锁之外读取进程所有权，可能在启动仍在进行时返回并把完成的运行时变成无主孤儿；关闭请求的 stdin 写入位于关闭预算之外，被其他请求持有的 `_write_lock` 卡住或写满 stdin 管道的写入会让终止永远延后；NaN 配置的超时能原样穿过 min/max 钳制，产生永不失效的截止时间。

## Decision

`start()` 把完整的检查与启动放在实例锁内执行，并在锁内为 `self._proc` 赋值，因此一个客户端最多拥有一个运行时子进程。生命周期转换另外经由一把专用的生命周期锁串行化：`start()` 在整个启动期间持有它，`close()` 在整个进程所有权拆除期间持有它；实例锁继续只守护短暂的共享状态访问，因此 `request()` 不会与拆除争用，并发的 `close()` 不会把进行中的启动看成不存在的进程，`close()` 返回之后也不会再存入新的运行时。

`close()` 从钳制到 [0, 30] 秒区间的 `shutdown_timeout_seconds` 推导出一个单调时钟截止时间——`None` 与 NaN 都选择该上限而非无限等待；NaN 无法靠钳制恢复，因为一切与它的比较都为假——把这份预算分配给关闭请求与 terminate 后的等待，然后从 `terminate()` 升级到 `kill()`，并附带固定的五秒回收等待。关闭请求在一个工作线程上发送，并按同一截止时间限时 join，因此被其他请求的 `_write_lock` 卡住或写满 stdin 管道的写入最多只消耗剩余预算，随后即进入终止流程。当回收等待超时，`close()` 会保留该 `Popen` 引用，让重试的 `close()` 能完成回收，同时阻止 `start()` 在前一个运行时可能仍存在时启动第二个运行时。30 秒上限是固定的活性不变量，而不是可配置的调节项：即使运行时无视关闭握手和终止信号，`close()` 也必须返回，同一上限同样保护 `__exit__`。

## Verification

pytest 套件以 fake 运行时对端驱动验证：八个经屏障同步的 `start()` 调用只记录到一个启动进程 id；在把上限补丁调小后，面对忽略 SIGTERM 且在 shutdown 中睡眠的对端，`shutdown_timeout_seconds=None` 的 `close()` 也能迅速返回；一个 fake Popen 记录升级路径确实到达 `kill()`，且未选择预算与已配置预算两种情况下等待值都是钳制后的非 `None` 数值；一个始终不回收的 fake Popen 确认 `close()` 保留所有权，而 `start()` 拒绝启动。其余用例覆盖评审发现：在启动中途停住的 fake Popen 让并发的 `close()` 等到启动完成后再执行拆除；被持有的 `_write_lock` 卡住的关闭发送仍能让 `close()` 在预算内返回并到达 terminate/kill；参数化的钳制表把 None、NaN、负数和超过上限的值映射进 [0, 30] 秒区间；NaN 配置的 `close()` 面对卡死对端会升级到 kill 且等待值受上限约束。

## Alternatives considered

**在每个调用点独立钳制（`min(configured or cap, cap)`）。** 更简单，但请求与进程等待可能各自耗尽完整预算，最坏拆除时间翻倍；共享一个截止时间能把 close 总时长控制在一个预算加回收等待之内。

**先检查写锁是否空闲再内联发送关闭请求。** 不予采纳：即使 `_write_lock` 无争用，写满 stdin 管道时的 flush 也会越过截止时间阻塞；只有对整个发送限时才能同时覆盖写争用与背压。

**允许调用方配置上限。** 不予采纳，因为保证是 `close()` 总会返回；把上界做成可配置会经由 `__exit__` 重新引入无界阻塞。

**只把锁扩大到守卫读取。** 不予采纳，因为竞态窗口只是移到赋值处；检查与启动必须处于同一个临界区才能串行化重复启动。

## Consequences

卡死的运行时最多耗费约 35 秒拆除时间，而不是挂起调用方：无论 stdin 写入或配置如何，关闭等待都被限制在 30 秒加五秒回收等待以内。并发的 `start()` 与 `close()` 调用方会在一次生命周期转换后串行排队，付出单次进程启动延迟，而不是泄漏重复运行时或拆掉一个尚未完成启动的进程。
