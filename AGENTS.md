# AGENTS.md

本文件是编码智能体（Trae、Claude Code、Codex、Cursor 等）进入本仓库的入口。

## 1. 先读什么

按顺序阅读：

1. `README.md` —— 仓库定位、边界、协议分层、协作原则；
2. `CONTRIBUTING.md` —— PR 权限、RFC 流程、变更分级、禁止事项；
3. `spec/README.md` —— 协议当前状态与 V0.1 范围；
4. `providers/README.md` —— 接入方映射配置规范；
5. `conformance/README.md` —— 一致性测试的运行方式。

## 2. 当前阶段

仓库处于**骨架阶段**：协议正文尚未定稿，参考实现与模拟服务尚未交付。

在协议 V0.1 经 RFC 批准前，不要实现未登记的契约、字段或工具。

## 3. 硬约束

1. 不自创协议。能力面用 MCP，数据面用 OpenAPI 3.1，事件面用 CloudEvents 1.0，媒体面用 GB/T 28181 或 HLS/WebRTC。
2. 不改 MingMineLink 内核。本仓库不包含、不引用 DSH、Core 数据库结构或内部服务实现。
3. 不放真实数据。所有示例、mock、测试数据必须是合成数据，凭证必须是明显的假值。
4. 不引入私有扩展。确需扩展时，先提 RFC，并在 `spec/extensions/` 登记。
5. 不改契约语义。字段改名、可空性变化、枚举删除都属于 Major 变更，必须走 RFC。

## 4. 验证方式

协议与实现就绪后，提交前至少执行：

```bash
npm run lint
npm run test
npm run conformance
```

当前阶段尚无脚本，相关命令在对应 Issue 交付后补充。

## 5. 提交规范

- 使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`chore:`；
- 提交信息末尾附 DCO 签名：`Signed-off-by: Name <email>`；
- 一次提交只做一件事，不混合协议变更与实现变更。

## 6. 遇到不确定

在 Issues 提问，不要在 PR 中自行决定契约语义。Issue 结论是本仓库唯一事实源。
