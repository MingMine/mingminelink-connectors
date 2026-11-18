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

锐明租户凭证到位前，先用本地 mock 模拟 Mining Platform API 2.7.3-P3 的关键链路，验证“接入流程 + 自测脚本”是否跑通。拿到凭证后只替换 `--base-url`，不修改测试结构。

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

可选 `--report ./conformance-report.json` 额外写出 JSON 报告。脚本会输出可读摘要与 JSON 报告；失败项包含请求 ID 与原因；存在失败或服务不可达时退出码非零。

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

### 切换到真实环境

1. 替换 `--base-url` 为锐明网关根地址（不含 `/openapi` 后缀）；
2. 使用锐明 Sign 鉴权获取 token，预研脚本不携带任何真实凭据，也不实现 Sign 签名；
3. 真实环境响应可能不返回 `expiresInSeconds`，此时脚本只校验地址存在，有效期以锐明文档与联调结论为准；
4. 锐明当前阻塞点为开放接口权限与租户凭证，详见 `providers/streamax/` 的 S1 预对接资料。

mock 数据与自测结果只能说明脚本与接入流程可用，不能作为锐明真实环境结论。
