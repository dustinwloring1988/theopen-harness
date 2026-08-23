# web-storage-sqlite

English | [中文](README.zh.md)

An opt-in Web overlay that routes the [Workspace registry](../../packages/workspace/workspace/README.md)'s durable records to the [SQLite storage backend](../../packages/storage/storage-sqlite/README.md) instead of the shipped JSON files. Run:

```sh
toh web --patch examples/web-storage-sqlite/cordis.yml
```

The overlay inserts a `storage-sqlite` row whose database lives at `~/.toh/storages/workspace.sqlite3` (`TOH_HOME` relocates it) and patches `storage-domain` with `routes: { workspace: sqlite }`, so only the `workspace` domain changes medium; every other domain keeps the JSON default. Per-key updates become single SQLite row writes instead of whole-unit file republications — the shape for high-churn or large domains.

Records created while the overlay was active are not visible without it, and records created without it do not migrate in: routing is configuration, and the pre-release stance rejects cross-medium migration. Pointing `routes` back at `json` (or removing the overlay) returns to the original records.
