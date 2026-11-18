# 锐明技术（Streamax）接入说明

锐明技术是首批接入方之一，形态为车载视频与车辆调度平台。本文档是预对接阶段的映射说明与信息清单，不是协议正文。

## 1. 版本基线

| 项目 | 结论 |
| --- | --- |
| 文档站 | `http://43.138.220.149:28081/` |
| 规格版本 | V2.7.3-P3(current)，规格文件 `/API/json/swagger_273-P3.json` |
| 规格规模 | 48 个路径、62 个操作、14 个标签、142 个数据模型 |
| UAT 网关 | `https://uat-saas-8.streamax.com/openapi` |
| 鉴权 | Sign（`_sign` + `_tenantid`，推荐）；Token（`token`，文档已标 deprecated） |
| 时间格式 | RFC 3339，例如 `2023-01-10T17:24:53Z` |
| 分页 | `page` + `pageSize`，响应含 `data`、`page`、`pageSize`、`requestId` |

## 2. 能力映射

| Connectors V0.1 | 锐明 2.7.3-P3 | 覆盖度 | 说明 |
| --- | --- | --- | --- |
| mine | `tenantId` | 可覆盖 | 锐明以租户隔离数据 |
| vehicle | `vehicleId`，`GET /v2/vehicles` | 可覆盖 | 车辆与设备一对一绑定 |
| videoSource | `uniqueId`，`GET /v2/devices` | 可覆盖 | 设备是视频源的载体 |
| channel | `channels` | 需适配 | 锐明用逗号分隔字符串，需要转数组 |
| playbackSession | `session` | 可覆盖 | 用于 `POST /v2/devices/session-close` 停止播放 |
| live | `GET /v2/devices/{uniqueId}/live-links` | 可覆盖 | FLV / HLS / RTMP / RTSP，一次性地址，10 秒有效 |
| playback | `GET /v2/devices/{uniqueId}/playback-links` | 可覆盖 | 一次性地址，20 秒有效；需传 `storeType` |
| snapshot | `POST /v2/devices/{uniqueId}/snapshot` | 可覆盖 | 对应 V0.1 扩展资源 snapshot |
| alarm | `GET /v2/alarms`、`/v2/alarms/evidence-link`、`/v2/alarms/file-download` | 可覆盖 | 证据文件异步下载，下载 URL 24 小时有效 |
| track | GPS Webhook、`POST /v2/gps/mileage` | 需适配 | 只有实时 GPS 推送与里程查询，没有历史轨迹查询 |
| analysis | 无对应能力 | 不支持 | 锐明不提供 AI 分析任务 |
| video clips | `POST /v2/devices/{uniqueId}/video-download` | V0.1 未登记 | 后续扩展 |
| blackbox | `GET /v2/parse-blackbox` | V0.1 未登记 | 后续扩展 |
| fuel | `GET /v2/fuels` | V0.1 未登记 | 后续扩展 |
| driver / face | `/v2/drivers`、`/v2/drivers/{driverId}/face-pictures` | V0.1 未登记 | 后续扩展 |
| device maintenance | `/v2/devices/maintenance/*` | V0.1 未登记 | 运维类，超出 V0.1 范围 |

映射结论：锐明的核心视频链路（设备 → 通道 → 直播 / 回放 → 告警证据）可以在不修改视频源抽象的前提下完成映射；`track` 需要降级为“实时 GPS 推送”，`analysis` 不在锐明能力范围内。

## 3. 周一对接所需信息清单

以下内容建议在对接会上逐项确认，锐明只需要提供信息与权限，不需要编写代码。

### 3.1 租户与鉴权

- [ ] `tenantId`：数字型租户 ID
- [ ] `tenantSecret`：租户密钥
- [ ] `appId`：Mining 应用默认 `10001`，确认是否一致
- [ ] 鉴权方式：确认使用 Sign（推荐）还是 Token
- [ ] 调用频率限制、并发限制与配额

### 3.2 权限与网络

- [ ] 开通 OpenAPI 权限（当前账号调用返回 `207001 User has no permission`）
- [ ] 将我们的出口 IP 加入网关白名单
- [ ] 确认 UAT 地址为 `https://uat-saas-8.streamax.com/openapi`
- [ ] 生产环境地址与切换方式

### 3.3 测试资产

- [ ] 1 台在线设备的 `uniqueId`
- [ ] 该设备可用的 `channel` 列表
- [ ] 一个可回放的时间段（`startTime` / `endTime`）
- [ ] 至少 1 条可用报警的 `alarmId`（用于证据链路验证）

### 3.4 事件回调

- [ ] 是否支持公网 HTTPS 回调地址
- [ ] `X-Webhook-Signature` 的签名示例（HMAC-SHA256 + tenantSecret）
- [ ] 失败重试策略与重试次数
- [ ] 推送频率确认（文档为 1000 条或 3 秒）

### 3.5 版本与文档

- [ ] 正式对接以 V2.7.3-P3 为准，还是等待 `/v3`
- [ ] API Overview 中的 `/v3/playback-links`、`/v2/trailers`、`/v2/devices/video-clean` 是否已可用
- [ ] 文档首页指向 `/API/V3.15.0(beta)`，但版本选择器中没有该版本，请确认口径

## 4. 已发现的差异与风险

| 编号 | 差异 | 影响 | 建议 |
| --- | --- | --- | --- |
| R1 | 文档首页指向 V3.15.0(beta)，版本选择器最新为 V2.7.3-P3 | 版本口径不一致 | 以对接会书面确认的版本为准 |
| R2 | API Overview 列出 `/v3`、`trailers`、`video-clean` 等端点，2.7.3 规格中不存在 | 按 Overview 开发会踩空 | 以 Swagger 规格为准，Overview 仅作导航 |
| R3 | 错误信封不统一：规格定义 `{code,message,requestId}`，实际出现 `{code,message,sid,success,data}` | 适配层需要兼容多套错误结构 | 统一转换为 Connectors 错误信封 |
| R4 | Sign 与 Token 两套鉴权并存，Token 已标 deprecated | 新接入不应依赖废弃方案 | 生产使用 Sign；Token 仅用于会前连通性验证 |
| R5 | 直播地址 10 秒有效、回放地址 20 秒有效，且一次性 | 客户端不能缓存地址 | 播放前实时申请，失败重试；不要落库 |
| R6 | Webhook 签名使用 `X-Webhook-Signature`（HMAC-SHA256 + tenantSecret） | 与 CloudEvents 默认签名方式不同 | 在事件面适配层做签名校验转换 |
| R7 | 平台账号能登录但不具备 OpenAPI 权限 | 会前无法完成真实数据联调 | 会议第一项确认权限开通与白名单 |

## 5. 实测记录（2026-11-19）

| 检查项 | 结果 |
| --- | --- |
| 文档站可访问 | 通过，HTTP 200 |
| Swagger 规格解析 | 通过，V2.7.3-P3，48 路径 / 62 操作 / 14 标签 / 142 模型 |
| UAT 平台登录 | 通过，需人工完成滑块验证 |
| 平台数据可见性 | 可见 16 个车组；地图在自动化环境提示“地图不可用”，疑似环境限制 |
| 开放网关连通 | 通过，`GET /openapi/auth/public-key` 返回 RSA 公钥 |
| 账号换取 Token | 通过，`code=200`，有效期约 1 天 |
| 设备 / 车辆 / 车组查询 | 失败，HTTP 400，`code=207001 User has no permission` |
| 平台 UI 查找 tenantSecret | 未找到；仅见掩码后的白名单 Key 与租户编码 `MSCLOUD` |

结论：网关与鉴权链路可用，当前阻塞点是开放接口权限与租户凭证，不是接口本身不可用。

## 6. 不支持与暂不声明能力

- **不支持**：AI 视频分析任务（analysis）、历史轨迹查询（track 仅实时 GPS）。
- **V0.1 暂不声明**：视频剪辑、黑匣子解析、油耗、司机人脸、设备运维、挂车、流量统计、人因风险事件、酒精检测、IButton。
- 上述能力如需纳入，按 RFC 流程新增，不在 manifest 中私下拉偏。

## 7. 示例数据

`examples/` 目录下为合成数据，仅用于说明响应结构：

- `devices.json`：设备列表
- `live-links.json`：直播地址
- `playback-links.json`：回放地址
- `alarms.json`：报警列表
- `webhook-alarm.json`：报警推送与签名占位

所有设备号、租户号、地址均为虚构值，不含真实凭据。

## 8. 待确认

- 锐明是否接受以 manifest 映射配置的方式接入，而不是要求我们按他们的 SDK 开发；
- Sign 鉴权的 `appKey` 与 `tenantSecret` 关系，文档中“appKey 与 tenantSecret 保持一致”需要实例确认；
- 一次性播放地址在弱网下的重试策略与并发会话上限。
