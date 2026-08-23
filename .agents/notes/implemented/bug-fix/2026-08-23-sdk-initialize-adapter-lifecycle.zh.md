# Agent Note: SDK initialize replaces its adapter and refuses shutdown overlaps

Status: implemented

[English](2026-08-23-sdk-initialize-adapter-lifecycle.md) | 中文

## 问题

JSON-RPC 的 `initialize` 方法在每次遇到无负责方的 provider 时都会挂载 DeepSeek 回退适配器，并覆盖唯一存储的 fiber 引用，因此第二次握手会让第一次挂载继续运行且再也无法触及：`shutdown` 只会 dispose 最新的 fiber。与 `performShutdown` 重叠的 `initialize` 还可能在拆除清理捕获清单之后挂载新 fiber，使关闭报告完成后仍残留存活的服务与订阅。通过重新初始化来重连的自动化宿主会在每个周期累积泄漏的适配器。

## 决策

重复初始化是受支持的行为，并且始终最多保留一个存活的由服务器挂载的适配器。并发的 `initialize` 调用按到达顺序在同一个已结算的尾部上排队，因此两次调用不会交叉写入字段或挂载。每个排队运行在工作前检查 shutting-down 标志，并以与关闭后 prompt 相同的错误拒绝。存储的 fiber 会记录它所服务的 provider：当请求的 provider 没有已注册适配器时，运行会先 dispose 已存储的 fiber 再挂载替换者；当运行选择了另一个已注册的 provider 时，即使没有替换挂载，也会 dispose 已存储的回退 fiber。dispose 通过同一个辅助方法完成，它在 await 之前先登记这次尝试：成功则释放属主关系，失败则保留已存储的 fiber，让 `shutdown` 可以重试并上报，同时拒绝仍会到达该 initialize 调用方。运行会在挂载 await 之后通过一个辅助方法重读该标志，因为挂载中途开始的 shutdown 尚未存储新 fiber，此时新挂载会在拒绝传播之前自行 dispose。`performShutdown` 会在获取拆除清单之前，等待入口处捕获的初始化尾部以及任何已登记的 dispose 尝试，因此其完成会跟随所有已接受的握手，而不是与某次握手赛跑。

## 已考虑的替代方案

**拒绝一切第二次 initialize。** 坚持旧的不支持重新初始化的立场，会破坏以新握手为唯一重连路径的自动化宿主，而协议又没有逐会话关闭可以替代。

**收集所有挂载过的 fiber 并在 shutdown 时统一清理。** 让被替换的挂载存活到 shutdown，会把泄漏窗口保留在长生命周期进程内部，而且仍需要 shutdown 侧的重试循环来处理拆除期间挂载的 fiber；改为先 dispose 再替换则只有一个属主和一个存活 fiber。

**让 shutdown 的完成与初始化保持独立。** 只依赖入口检查加挂载后自行 dispose，会让 shutdown 在某次挂载或被替换适配器的 dispose 尚未结算时就完成，客户端观察到关闭成功后仍残留存活适配器；等待捕获的尾部可以把完全停稳保留在调用方本就在等待的操作之内。

## 验证

包测试固定了该生命周期：两次顺序 initialize 会 dispose 第一个挂载，并为 shutdown 恰好留下一个 fiber；重叠的 initialize 在第一个挂载之后串行；与 shutdown 重叠的 initialize 会拒绝并 dispose 自己的挂载；shutdown 在已接受握手的挂载或被替换 dispose 未结算时保持未完成；失败的被替换 dispose 保留属主关系，由 shutdown 重试并上报；切换到另一个已注册 provider 时会释放过时的回退适配器而不挂载替换者；shutdown 之后的 initialize 不再挂载即被拒绝；真实 harness 运行显示重复 initialize 加 shutdown 之后上下文中不再有 DeepSeek provider。

## 后果

以重新初始化实现的重连不再累积适配器；只要每次 dispose 都成功，即使存在并发握手，shutdown 完成也意味着没有任何存活的由服务器挂载的 fiber。失败的 dispose 会把已存储的 fiber 保留下来交给 `shutdown` 重试，如果重试同样失败，fiber 可能仍然存活，而 `shutdown` 会报告该错误。缓慢的 initialize 现在会延迟后续调用和 shutdown 完成而不是与之交错；输给 shutdown 的握手只表现为该请求上被拒绝的 promise，外围传输会把它映射为普通的 JSON-RPC 错误响应。
