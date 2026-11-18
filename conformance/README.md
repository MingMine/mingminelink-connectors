# 一致性测试（conformance）

接入方实现连接契约后，用同一套测试验证是否符合规范。

## 目标

一条命令完成验证：

```bash
npm run conformance -- --provider example --base-url https://provider.example.com
```

输出：

- 必过项：鉴权、资源查询、分页、错误码、事件签名；
- 可选项：按 `manifest.yaml` 的 `capabilities` 跳过未声明能力；
- 报告：JSON + 可读摘要，附失败项与请求 ID。

## 计划覆盖

| 类别 | 用例 |
| --- | --- |
| 身份 | 令牌获取、过期、audience 校验 |
| 资源 | 视频源列表、通道列表、详情、不存在 |
| 分页 | 默认条数、上限、游标翻页 |
| 错误 | 400 / 401 / 403 / 404 / 409 / 429 / 5xx |
| 媒体 | 播放地址短时有效、过期拒绝 |
| 事件 | 签名校验、时间戳、重放拒绝 |
| MCP | 工具清单、参数校验、返回结构 |

## 当前状态

骨架阶段，测试套件尚未实现。实现进度见对应 Issue。

## 预研版（锐明）

> 定位：预研验证，不是 V0.1 协议一致性套件，不改变 `spec/` 的协议状态与字段冻结结论。

锐明租户凭证到位前，先用本地 mock 模拟 Mining Platform API 2.7.3-P3 的关键链路，验证“接入流程 + 自测脚本”是否跑通。mock 默认使用固定 token；对接真实环境必须提供 `--token` 或 `--sign`/`--tenant-id`，**不是只替换 `--base-url`**。

### 启动 mock

```bash
npm install
npm run mock
# 默认监听 http://127.0.0.1:18080
```

mock 覆盖端点：公钥、鉴权、设备列表、设备详情、直播地址、回放地址、告警列表、证据链接、会话关闭。

合成数据约定：

| 项目 | 合成值 |
| --- | --- |
| 固定 token | `TEST-MOCK-TOKEN` |
| 换 token 账号 / secret | `TEST-ACCOUNT` / `TEST-MOCK-SECRET` |
| 租户号 | `100001` |
| 设备号 | `TEST00000001`、`TEST00000002`、`TEST00000003` |
| 车辆号 | `TEST-VEHICLE-0001` 等 |
| 媒体域名 | `media.example.invalid` |
| 直播 / 回放地址有效期 | 10 秒 / 20 秒 |
| 证据链接有效期 | 24 小时 |

所有数据均为合成值，不得替换为真实账号、密码、Token 或设备号。

### 运行预研自测

```bash
npm run conformance -- --provider streamax --base-url http://127.0.0.1:18080
```

可选参数：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--token` | `STREAMAX_TOKEN` | 访问 token，作为 `token` 请求头发送 |
| `--sign` | `STREAMAX_SIGN` | Sign 签名，与 `--tenant-id` 一起作为 `_sign` 请求头发送 |
| `--tenant-id` | `STREAMAX_TENANT_ID` | 租户号，作为 `_tenantid` 请求头发送 |
| `--start-time` | - | 告警查询起始时间（RFC3339），默认结束时间前 24 小时 |
| `--end-time` | - | 告警查询结束时间（RFC3339），默认当前时间 |
| `--report` | - | 额外写出 JSON 报告文件 |

鉴权选择顺序：

1. 提供 `--token` / `STREAMAX_TOKEN` 时，使用 `token` 头；
2. 未提供 token，但提供 `--sign` 与 `--tenant-id` 时，使用 `_sign` 与 `_tenantid` 头；
3. 两者都没有时，仅当 `--base-url` 是 `localhost` / `127.0.0.1` 才回退到 mock token；其他地址直接报错退出，提示需要鉴权参数。

时间窗默认最近 24 小时（RFC3339），不要写死日期；mock 合成告警按当前时间生成，确保默认时间窗可命中。

脚本会输出可读摘要与 JSON 报告；失败项包含请求 ID 与原因；存在失败或服务不可达时退出码非零。

当前覆盖用例：

| 用例 | 验证内容 |
| --- | --- |
| `auth.public-key` | 公钥端点可访问、字段存在 |
| `auth.token` | 合成凭证换取 token |
| `devices.list` | 设备列表、`page` / `pageSize` 生效 |
| `devices.detail` | 设备详情与 `uniqueId` 一致 |
| `devices.channels` | 逗号分隔 `channels` 解析为通道数组 |
| `live.links` | 直播地址与 10 秒有效期 |
| `playback.links` | 回放地址与 20 秒有效期 |
| `alarms.list` | 告警列表与分页 |
| `alarms.evidence-link` | 证据链接与 24 小时有效期 |
| `sessions.close` | 关闭直播会话 |
| `auth.bad-token` | 非法 token 返回 `code=3806` |

查询参数按锐明 2.7.3-P3 规格：直播使用 `channels` + `streamingProtocol`；回放额外要求 `startTime`、`endTime`、`storeType`（`MAIN_STORAGE` / `SUB_STORAGE`）；告警必填 `startTime`、`endTime`，设备过滤用 `uniqueIds`；证据链接必填 `hasAudio`、`mediaProtocol`、`streamType`；会话关闭 body 只传 `session`。

### 切换到真实环境

1. 替换 `--base-url` 为锐明网关根地址（不含 `/openapi` 后缀）；
2. **同时**提供鉴权参数：`--token`，或 `--sign` 与 `--tenant-id`（也可用对应环境变量）；仅换 `--base-url` 会因缺少鉴权参数直接报错退出；
3. 真实环境不假设客户端能换取 token：`auth.token` 用例改为调用一次受保护接口，验证鉴权头被接受；
4. 真实环境直播/回放响应只有 `url`；脚本会尝试从 URL 的 `expires` 参数推算有效期，没有该参数时只校验地址存在；
5. 告警时间窗默认最近 24 小时，可用 `--start-time` / `--end-time` 覆盖；
6. 锐明当前阻塞点为开放接口权限与租户凭证，详见 `providers/streamax/` 的 S1 预对接资料。

mock 数据与自测结果只能说明脚本与接入流程可用，不能作为锐明真实环境结论。
