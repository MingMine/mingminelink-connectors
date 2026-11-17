# 协议规范（spec）

本目录存放 MingMineLink Connectors 的对外连接契约。

## 当前状态

骨架阶段，协议正文尚未定稿。

V0.1 范围（草案，待 RFC）：

- 核心资源：`mine` → `videoSource` → `channel` → `playbackSession`；
- 扩展资源：`vehicle`、`analysisJob`、`analysisResult`、`snapshot`、`track`、`alarm`；
- 能力面：MCP 工具清单与版本锁定策略；
- 数据面：OpenAPI 3.1 契约与错误信封；
- 事件面：CloudEvents 1.0 事件目录；
- 媒体面：播放地址与短时凭证格式；
- 接入方映射：`providers/<name>/manifest.yaml` 规范。

## 计划目录

```text
spec/
├─ CHANGELOG.md
├─ rfcs/                 RFC 提案与结论
├─ extensions/           经批准的扩展登记
├─ mcp/                  MCP 工具 schema
├─ openapi/              OpenAPI 3.1 契约
├─ events/               CloudEvents 事件目录
└─ errors/               错误码表
```

在协议 V0.1 批准前，本目录不新增未登记的文件。

## 版本策略

- 协议版本与仓库版本同步，语义化版本；
- 只增不删不改语义；
- 破坏性变更必须走 RFC，全部接入方确认后发布 Major。
