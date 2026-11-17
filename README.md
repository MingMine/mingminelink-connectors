# MingMineLink Connectors

外部平台接入 MingMineLink 的**唯一协议入口**。

一句话：**我们定义连接契约，接入方按契约提供能力，差异由适配层吸收。**

本仓库只做"连接"这一件事。业务规则、数据存储、页面交互、智能体内核均不在本仓库范围内。

## 1. 这个仓库解决什么问题

MingMineLink 需要接入多类外部平台：

| 类型 | 示例 | 典型能力 |
| --- | --- | --- |
| 车载视频与车辆调度平台 | 锐明技术 | 车辆、定位、车载通道、实时预览、历史回放 |
| 矿山 AI 视频分析平台 | 模态智动 | 视频源、分析任务、分析结果、抓拍 |
| 市级视频监控平台 | 海康 / 大华等国标平台 | 固定点位视频、回放、云台 |

每家平台都有自己的 API、SDK、鉴权方式和字段命名。逐个点对点对接会导致重复适配、反复沟通、联调成本失控。

本仓库提供一套**稳定的连接契约**，让任何一家的接入工作变成"填一份映射配置 + 跑一遍一致性测试"。

## 2. 我们不做什么

| 不做 | 归属 |
| --- | --- |
| 业务规则（时限、催办、状态机、处置流程） | MingMineLink Core |
| 数据存储、台账、证据链 | MingMineLink Core |
| 页面与交互 | MingMineLink 前端 |
| 智能体推理与编排 | MingMineLink AI 基础设施 |
| 替代接入方实现其平台能力 | 接入方自己 |

本仓库不含、也不会引入 MingMineLink 内核设计、内部数据模型或内部服务实现。

## 3. 协议分层

只使用现成标准，不自创协议。

| 层 | 标准 | 用途 | 边界 |
| --- | --- | --- | --- |
| 能力面 | MCP（锁定版本，见 spec/） | 智能体按需查询与调用 | 不传视频二进制、不做全量同步 |
| 数据面 | OpenAPI 3.1 + JSON Schema 2020-12 | 资源查询与写入 | 不做长连接推送 |
| 事件面 | CloudEvents 1.0 + Webhook | 告警、上下线、状态变更 | 不做大文件传输 |
| 媒体面 | GB/T 28181 或 HLS / WebRTC | 实时预览与历史回放 | 只交换地址与短时凭证 |
| 空间数据 | GeoJSON（RFC 7946） | 轨迹、点位 | —— |
| 身份 | OAuth 2.1 / OIDC | 授权与令牌 | 过渡期可用 API Key + mTLS |

核心资源抽象为**视频源**，车辆只是视频源的一种归属者：

```text
mine
 ├─ vehicle（可选归属）
 └─ videoSource
      ├─ channel
      ├─ playbackSession
      ├─ analysisJob → analysisResult
      └─ snapshot
```

## 4. 协作原则

### 4.1 讨论走 Issues

所有接入问题、字段疑问、联调阻塞、协议提案，一律在本仓库 Issues 留痕。不使用私聊、邮件或会议口头结论作为依据。

 Issues 是唯一事实源；结论必须回写到对应 Issue。

### 4.2 PR 权限收敛

- 每个接入团队指定**一名 PR 代表**，由该代表提交和回复 PR；
- 只有维护者（CODEOWNERS）拥有合并权限；
- 外部团队通过 Fork + PR 贡献，不直接 push 主分支；
- 具体规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 4.3 可调试服务

光有规范无法对接。本仓库提供可长期运行的模拟服务与参考实现：

- mock provider：模拟锐明、模态智动等平台的 API；
- 参考 MCP server：把 mock 数据暴露为 MCP 工具；
- 一致性测试：接入方实现后一条命令完成验证。

测试环境地址与启动方式在服务就绪后于本 README 与对应 Issue 中公布。

### 4.4 禁止性约束

以下行为一律禁止，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)：

1. 禁止提交真实业务数据（矿山台账、车辆轨迹、人员信息、视频截图）；
2. 禁止提交真实凭据、密钥、Token、内网地址、端口与账号；
3. 禁止在本仓库讨论或暴露 MingMineLink 内核实现（DSH、Core 数据库结构、内部服务）；
4. 禁止自创协议或私有扩展替代已有标准；
5. 禁止绕过 Issues 直接通过 PR 变更契约语义。

## 5. 版本与冻结

本仓库的协调成本最高，因此协议必须最稳定。

| 机制 | 规则 |
| --- | --- |
| 变更分级 | Patch 只改文档与示例；Minor 只允许新增可选字段、端点、事件；Major 才允许破坏性变更 |
| 兼容性承诺 | 只增不删不改语义；客户端必须容忍未知字段与未知枚举值 |
| 废弃窗口 | 废弃字段至少保留一个 Minor 周期，且不少于 6 个月 |
| 变更窗口 | 每季度一个 Minor 窗口；Major 每年最多一次；安全修复走紧急通道 |
| 变更入口 | `spec/rfcs/` + RFC 模板；需要至少两个接入方代表与维护者批准 |

**冻结的是线协议，不是内部实现。** 接入方与 MingMineLink 双方的内部实现均可重写，只要对外行为不变。

协议冻结后，由 MingMineLink Core 适配本仓库，而不是让本仓库迁就 Core 的内部模型。

## 6. 仓库结构

```text
README.md            本文件
AGENTS.md            给编码智能体的入口与硬约束
CONTRIBUTING.md      贡献流程、PR 权限、DCO、RFC
SECURITY.md          安全红线与漏洞上报
CODEOWNERS           维护者与合并权限
spec/                协议规范、OpenAPI、事件目录、错误码（V0.1 迭代中）
providers/           接入方映射配置（manifest）与说明
conformance/         一致性测试套件
```

## 7. 参与方式

1. 先读 [AGENTS.md](AGENTS.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)；
2. 在 Issues 中查找或创建对应议题；
3. 按 `providers/<name>/` 提交映射配置；
4. 跑通 `conformance` 后提交 PR，由团队 PR 代表发起；
5. 维护者合并后更新版本记录。

## 8. License

- 代码：[Apache-2.0](LICENSE)
- 规范文本：CC-BY-4.0

贡献采用 DCO（Developer Certificate of Origin），不使用 CLA。
