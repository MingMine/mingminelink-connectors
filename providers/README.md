# 接入方映射（providers）

每个接入方一个目录，目录内只放映射配置与说明，不放业务代码。

```text
providers/
└─ <provider-name>/
   ├─ manifest.yaml
   ├─ README.md
   └─ examples/
```

## manifest.yaml 最小结构

```yaml
provider: example
displayName: 示例平台
protocolVersion: "0.1"
baseUrl: https://provider.example.com

auth:
  type: oauth2        # oauth2 | apiKey | mtls
  tokenUrl: https://provider.example.com/oauth/token

mapping:
  mineId: orgId
  vehicleId: deviceId
  channelId: channelNo

capabilities:
  live: true
  playback: true
  track: true
  alarm: true
  analysis: false
```

## 原则

1. 接入方只提供 API 文档、测试凭证与映射配置，不要求开发 MCP server；
2. 生产凭据不入库，只提交占位符；
3. 映射无法覆盖的能力，在 README 中登记为"不支持"，不得私下拉偏；
4. 新增接入方需先在 Issues 登记，再提交 PR。

## 首批接入方

| 目录 | 接入方 | 形态 | 状态 |
| --- | --- | --- | --- |
| `streamax/` | 锐明技术 | 车载视频与车辆调度平台 | 待登记 |
| `modal-intelligence/` | 模态智动 | 矿山 AI 视频分析平台 | 待登记 |
| `city-video/` | 市级视频平台 | 国标视频监控平台 | 待登记 |

目录名与接入方正式名称的对应关系，以 Issues 中的登记结论为准。
