# web-storage-sqlite

[English](README.md) | 中文

一个可选的 Web overlay，把 [Workspace 注册表](../../packages/workspace/workspace/README.zh.md) 的持久记录路由到 [SQLite 存储后端](../../packages/storage/storage-sqlite/README.zh.md)，而不是出厂的 JSON 文件。运行：

```sh
toh web --patch examples/web-storage-sqlite/cordis.yml
```

该 overlay 插入一行 `storage-sqlite`，数据库位于 `~/.toh/storages/workspace.sqlite3`（`TOH_HOME` 可重定位），并给 `storage-domain` 打上 `routes: { workspace: sqlite }` 补丁——因此只有 `workspace` 域更换介质，其余域仍走 JSON 默认路由。逐 key 更新从整个 unit 文件重发布变为单条 SQLite 行写入——这正是高 churn 或大规模域所需的形态。

overlay 生效期间创建的记录在移除 overlay 后不可见，未启用期间创建的记录也不会迁入：路由即配置，预发布立场拒绝跨介质迁移。把 `routes` 改回 `json`（或去掉 overlay）即可回到原有记录。
