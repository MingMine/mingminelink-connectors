# 锐明适配层 TypeScript 原型（S3 spike）

> 定位：验证“锐明 Mining Platform API 2.7.3-P3 → Connectors 视频源模型”的映射可行性，并评估转正式实现的工作量。
> 本目录是 spike 产物，不修改 `spec/`、不冻结字段、不合并 `main`。所有类型与错误码均为**草案，待 RFC**。

## 1. 目录内容

```text
spike/streamax-adapter/
├─ types.ts      草案类型：VideoSource / Channel / LiveSession / PlaybackSession / Alarm / ConnectorsError
├─ errors.ts     统一错误信封与错误构造函数
├─ adapter.ts    StreamaxAdapter 与锐明差异处理
├─ index.ts      出口
└─ README.md     本文件
```

HTTP 调用与多套响应信封判断直接复用 [`conformance/streamax-client.ts`](../../conformance/streamax-client.ts)，适配层不重复实现请求、超时与错误识别逻辑。

## 2. 映射决策

| Connectors（草案） | 锐明 2.7.3-P3 | 适配方式 |
| --- | --- | --- |
| `VideoSource.id` | `device.uniqueId` | 直接映射 |
| `VideoSource.fleetId` | `device.fleetId` | 直接映射；缺失时为空字符串 |
| `VideoSource.online` | `onlineState === "ONLINE"` | 布尔化 |
| `VideoSource.dormant` | `dormantState === "DORMANT"` | 布尔化；枚举为 AWAKE / DORMANT / UNKNOWN |
| `VideoSource.channels` | `device.channels` | 逗号字符串拆数组，去重、过滤非法值 |
| `Channel.id` | `channels` 中的通道号 | 数字通道号 |
| `LiveSession` | `GET /v2/devices/{uniqueId}/live-links?channels=&streamingProtocol=` | 一次性地址，默认有效期 10 秒 |
| `PlaybackSession` | `GET /v2/devices/{uniqueId}/playback-links?channels=&startTime=&endTime=&storeType=&streamingProtocol=` | 一次性地址，默认有效期 20 秒；`storeType` 为字符串枚举 `MAIN_STORAGE` / `SUB_STORAGE` |
| `closeSession` | `POST /v2/devices/session-close` | 请求体只传 `{ session }` |
| `Alarm` | `GET /v2/alarms?startTime=&endTime=&uniqueIds=` | `startTime` / `endTime` 必填，字段暂保留锐明原始语义 |
| `getTrack` | 无历史轨迹接口 | 固定抛 `UNSUPPORTED_CAPABILITY` |
| `createAnalysisJob` | 无 AI 分析能力 | 固定抛 `UNSUPPORTED_CAPABILITY` |

鉴权不在适配层实现：Token 由调用方通过锐明 Sign 或 Token 流程获取后注入，适配层不落库、不打印。`baseUrl` 不含 `/openapi` 后缀，与 `conformance/run.ts` 一致。

### 2.1 错误信封

锐明存在 `{code,message,requestId}`、`{code,message,sid,success,data}`、`{error:{code,message}}` 三种形态（风险 R3）。适配层统一输出：

```ts
{ code: string | number; message: string; requestId: string }
```

- 锐明业务码原样保留，例如 `3806`（非法用户）、`207001`（无权限）、`4041`（通道不存在）；
- 判断逻辑复用 `inspectEnvelope`，HTTP 200 但业务码非 200 也会转为错误；
- 适配层自身错误使用字符串码：`UNSUPPORTED_CAPABILITY`、`NETWORK_ERROR`、`INVALID_RESPONSE`；
- 所有错误都带 `requestId`，与上游 `requestId` / `sid` 对齐。

### 2.2 锐明差异处理

| 差异 | 处理 |
| --- | --- |
| `channels` 是逗号分隔字符串 | `parseStreamaxChannels` 兼容字符串与数组，输出数字通道数组；请求参数名同样为 `channels` |
| 媒体接口参数名 | 直播 / 回放统一使用 `channels` 与 `streamingProtocol`，不使用旧参数 `channel` / `protocol` |
| 直播地址 10 秒有效 | 常量 `LIVE_LINK_TTL_SECONDS = 10`；响应未返回有效期时按文档计算 `expiresAt` |
| 回放地址 20 秒有效 | 常量 `PLAYBACK_LINK_TTL_SECONDS = 20`；同上 |
| 地址一次性，不可缓存 | 类型注释与 README 明确禁止落库/缓存，播放前实时申请 |
| 会话需要显式关闭 | `closeSession` 调用 `session-close`，请求体只传 `{ session }`，返回 `closed` 标记 |
| 回放必须传 `storeType` | `createPlaybackSession` 强制要求字符串枚举 `MAIN_STORAGE` / `SUB_STORAGE` |
| 告警必须传时间范围 | `listAlarms` 要求 RFC 3339 的 `startTime` / `endTime`，按设备过滤使用 `uniqueIds` |
| 无历史轨迹 | `getTrack` 抛 `UNSUPPORTED_CAPABILITY` |
| 无 AI 分析 | `createAnalysisJob` 抛 `UNSUPPORTED_CAPABILITY` |

## 3. 与 V0.1 草案的差异点

以下差异需要在 RFC 中确认，spike 不做单方面决定：

1. **视频源标识**：草案未冻结 `videoSource.id` 的取值规则，本原型取 `device.uniqueId`；车辆与视频源是绑定关系，但设备响应中没有 `vehicleId`，暂未映射。
2. **通道模型**：锐明没有独立通道对象，只有通道号。`Channel` 目前只有 `id` 与 `videoSourceId`，没有名称、状态、能力等字段。
3. **在线/休眠语义**：`onlineState === "ONLINE"`、`dormantState === "DORMANT"`；规格枚举为 AWAKE / DORMANT / UNKNOWN，未定义完整映射表。
4. **媒体有效期**：S2 mock 已按规格只返回 `channel` / `session` / `url`，不再返回 `expiresAt` / `expiresInSeconds`；适配层按文档 TTL 兜底计算，TTL 是否进入 V0.1 契约仍需 RFC 确认。
5. **`storeType`**：锐明回放必传，且为字符串枚举 `MAIN_STORAGE` / `SUB_STORAGE`；V0.1 草案未登记该字段，正式实现前需要在 RFC 中明确是保留为适配层参数还是进入公共契约。
6. **告警字段与参数**：`startTime` / `endTime` 必填，设备过滤参数为 `uniqueIds`；`alarmType`、`processStatus`、`realFlag` 暂为锐明原始语义，尚未映射为 Connectors 枚举；证据链接、证据文件下载未纳入本次原型。
7. **track 降级**：锐明只有实时 GPS 推送与里程查询，没有历史轨迹；V0.1 的 `track` 能力需要明确降级策略，而不是在适配层伪造。
8. **analysis**：锐明不提供 AI 分析，`analysisJob` / `analysisResult` 在锐明接入中应始终标记为不支持。
9. **错误码表**：原型保留锐明业务码；V0.1 错误码表尚未定稿，正式实现需要做一次映射并保持可追溯。
10. **未纳入范围**：snapshot、视频剪辑、黑匣子、油耗、司机人脸、设备运维、挂车等能力不在本 spike 与 V0.1 范围内。

## 4. 后续转正式实现的工作量拆解

按 S / M / L 三档评估，不含时间估算。

### S（小）

- 类型命名与字段按 RFC 结论对齐，补齐注释与废弃说明；
- 把字符串错误码（`UNSUPPORTED_CAPABILITY` 等）并入 V0.1 错误码表；
- 补充单元测试边界：空 `channels`、重复通道、缺失 `expiresAt`、非 JSON 响应；
- 将 `spike/` 代码迁移到正式目录并更新 `tsconfig`；
- README 与 conformance 文档补充适配层调用示例。

### M（中）

- 实现锐明 Sign 鉴权（`_sign` + `_tenantid`）与 Token 刷新、失效重试；
- 告警枚举映射：`alarmType`、`processStatus`、`realFlag` 到 Connectors 枚举，并保留原始值；
- 补齐告警证据链接与文件下载，明确 24 小时有效期的处理；
- 会话生命周期：并发上限、弱网重试、关闭失败补偿；
- 把适配层接入 `conformance/run.ts`，用同一套用例验证适配层而非裸 HTTP；
- 在 `providers/streamax/manifest.yaml` 中登记能力与映射，保持与实现一致。

### L（大）

- 事件面适配：把锐明 Webhook 转为 CloudEvents 1.0，实现 `X-Webhook-Signature` 校验、去重、重试与重放防护；
- track 降级方案落地：实时 GPS 推送接入，历史轨迹能力的边界与替代方案；
- 多租户与生产环境切换：租户隔离、白名单、配额、监控与告警；
- 以适配层为底座暴露 MCP 工具，并完成 V0.1 能力面的一致性测试；
- 全量错误码映射、契约兼容性测试与回归基线。

## 5. 验证方式

```bash
npm.cmd run build
npm.cmd test
```

适配层测试使用 `mock/streamax` 的合成数据，覆盖视频源列表、通道解析、直播会话、回放会话、告警、错误信封与不支持能力。手工冒烟可先启动 `npm.cmd run mock`，再用临时脚本实例化 `StreamaxAdapter` 调用；临时脚本不入库。

所有设备号、租户号、Token 与媒体域名均为合成值，不含真实凭证与真实设备数据。
