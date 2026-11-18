/**
 * 锐明（Streamax）预研版一致性自测。
 *
 * 用法：
 *   npm run conformance -- --provider streamax --base-url http://127.0.0.1:18080
 *
 * 说明：本脚本用于验证“接入流程 + 自测脚本”是否跑通，不代表锐明真实环境结论，
 * 也不是 V0.1 协议一致性套件的替代品。
 */

import { writeFile } from "node:fs/promises";
import { StreamaxClient, type StreamaxResponse } from "./streamax-client";

export interface ConformanceOptions {
  provider: string;
  baseUrl: string;
}

export interface CheckResult {
  id: string;
  name: string;
  status: "passed" | "failed";
  requestId: string;
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface ConformanceReport {
  schemaVersion: 1;
  provider: string;
  baseUrl: string;
  mode: "pre-research-mock";
  startedAt: string;
  finishedAt: string;
  summary: { total: number; passed: number; failed: number };
  checks: CheckResult[];
  notice: string;
}

/** 预研版当前只支持锐明。 */
const SUPPORTED_PROVIDERS = new Set(["streamax"]);

const PRE_RESEARCH_NOTICE =
  "预研版结果仅用于验证接入流程与自测脚本，不代表锐明真实环境或协议一致性结论。";

type JsonRecord = Record<string, unknown>;

interface DeviceSummary {
  uniqueId: string;
  channels: number[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `：${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function stringifyBody(body: unknown): string {
  if (body === undefined) {
    return "空响应";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 断言响应不是错误信封。 */
function expectOk(response: StreamaxResponse, label: string): void {
  if (!response.envelope.isError) {
    return;
  }
  const code = response.envelope.code === undefined ? "无错误码" : `code=${String(response.envelope.code)}`;
  throw new Error(
    `${label}失败：HTTP ${response.status}，${code}，${response.envelope.message}；响应=${stringifyBody(response.body)}`,
  );
}

/** 锐明 channels 兼容字符串与数组两种形态。 */
function parseChannels(value: unknown): number[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0);
  }
  return [];
}

/** 校验媒体地址有效期；真实环境未返回有效期字段时只校验地址存在。 */
function verifyLinkTtl(link: JsonRecord, expectedSeconds: number, label: string): string {
  const url = link.url;
  assert(typeof url === "string" && url !== "", `${label}响应缺少 url`);

  const rawTtl = link.expiresInSeconds;
  if (rawTtl !== undefined && rawTtl !== null) {
    const ttl = Number(rawTtl);
    assert(Number.isFinite(ttl), `${label} expiresInSeconds 不是数字`);
    assert(ttl === expectedSeconds, `${label}有效期应为 ${expectedSeconds} 秒，实际 ${ttl} 秒`);
    return `有效期 ${ttl} 秒`;
  }
  return "服务未返回 expiresInSeconds，仅校验地址存在（锐明文档：直播 10 秒、回放 20 秒）";
}

/**
 * 执行全部预研用例。
 *
 * 不调用 process.exit，便于测试直接复用；退出码由 CLI 主函数根据 summary 设置。
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const startedAt = new Date().toISOString();
  const client = new StreamaxClient(options.baseUrl);
  const checks: CheckResult[] = [];

  const ctx: {
    token: string;
    devices: DeviceSummary[];
    channel: number;
    liveSession: string;
    alarmId: string;
  } = {
    token: "",
    devices: [],
    channel: 0,
    liveSession: "",
    alarmId: "",
  };

  let sequence = 0;
  let lastRequestId = "";

  /** 发请求并记录请求 ID（优先使用服务端回传的 requestId）。 */
  const call = async (
    checkId: string,
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
  ): Promise<StreamaxResponse> => {
    const requestId = `conf-${checkId}-${++sequence}`;
    lastRequestId = requestId;
    const response = await client.request(path, {
      method: init.method,
      body: init.body,
      token: init.token ?? ctx.token,
      requestId,
    });
    lastRequestId = response.requestId;
    return response;
  };

  /** 单用例执行与结果收集。 */
  const run = async (id: string, name: string, fn: () => Promise<string>): Promise<void> => {
    lastRequestId = "";
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({
        id,
        name,
        status: "passed",
        requestId: lastRequestId,
        durationMs: Date.now() - started,
        detail,
      });
    } catch (error) {
      checks.push({
        id,
        name,
        status: "failed",
        requestId: lastRequestId === "" ? `conf-${id}-no-request` : lastRequestId,
        durationMs: Date.now() - started,
        error: errorMessage(error),
      });
    }
  };

  await run("auth.public-key", "鉴权：获取 RSA 公钥", async () => {
    const response = await call("auth.public-key", "/openapi/auth/public-key");
    expectOk(response, "获取公钥");
    const data = asRecord(asRecord(response.body)?.data);
    const publicKey = data?.publicKey;
    assert(
      typeof publicKey === "string" && publicKey.includes("PUBLIC KEY"),
      "响应缺少 publicKey 字段",
    );
    return "公钥字段存在";
  });

  await run("auth.token", "鉴权：换取 Token", async () => {
    const response = await call("auth.token", "/openapi/auth", {
      method: "POST",
      // 合成凭证，仅用于 mock；真实环境使用锐明 Sign 或 Token。
      body: { appId: "10001", tenantId: "100001", tenantSecret: "TEST-MOCK-SECRET" },
      token: "",
    });
    expectOk(response, "换取 Token");
    const data = asRecord(asRecord(response.body)?.data);
    const token = data?.token;
    assert(typeof token === "string" && token !== "", "响应缺少 token 字段");
    ctx.token = token;
    return "Token 获取成功（合成值）";
  });

  await run("devices.list", "设备：列表与分页", async () => {
    const first = await call("devices.list", "/openapi/v2/devices?page=1&pageSize=1");
    expectOk(first, "设备列表");
    const firstRoot = asRecord(first.body);
    const firstPage = asArray(firstRoot?.data);
    assert(firstPage.length === 1, `pageSize=1 应返回 1 条，实际 ${firstPage.length} 条`);
    assert(Number(firstRoot?.page) === 1, `page 字段应为 1，实际 ${String(firstRoot?.page)}`);
    assert(Number(firstRoot?.pageSize) === 1, `pageSize 字段应为 1，实际 ${String(firstRoot?.pageSize)}`);

    const all = await call("devices.list", "/openapi/v2/devices?page=1&pageSize=50");
    expectOk(all, "设备列表");
    const devices = asArray(asRecord(all.body)?.data)
      .map((item) => asRecord(item))
      .filter((item): item is JsonRecord => item !== undefined);
    assert(devices.length > 0, "设备列表为空");

    ctx.devices = devices
      .map((device) => ({ uniqueId: String(device.uniqueId ?? ""), channels: parseChannels(device.channels) }))
      .filter((device) => device.uniqueId !== "");
    assert(ctx.devices.length > 0, "设备列表缺少 uniqueId");

    return `分页生效，共 ${ctx.devices.length} 台设备`;
  });

  await run("devices.detail", "设备：详情", async () => {
    const device = ctx.devices[0];
    assert(device !== undefined, "缺少设备，无法执行详情检查");
    const response = await call("devices.detail", `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}`);
    expectOk(response, "设备详情");
    const data = asRecord(asRecord(response.body)?.data);
    assert(
      data?.uniqueId === device.uniqueId,
      `uniqueId 不匹配：期望 ${device.uniqueId}，实际 ${String(data?.uniqueId)}`,
    );
    return `设备 ${device.uniqueId}`;
  });

  await run("devices.channels", "设备：通道解析", async () => {
    const device = ctx.devices[0];
    assert(device !== undefined, "缺少设备，无法执行通道解析");
    const response = await call(
      "devices.channels",
      `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}`,
    );
    expectOk(response, "设备详情");
    const data = asRecord(asRecord(response.body)?.data);
    const channels = parseChannels(data?.channels);
    assert(channels.length > 0, "channels 字段为空或格式无法解析");
    const [firstChannel] = channels;
    assert(firstChannel !== undefined, "channels 解析结果为空");
    ctx.channel = firstChannel;
    return `解析出 ${channels.length} 个通道（${channels.join(",")}）`;
  });

  await run("live.links", "媒体：直播地址", async () => {
    const device = ctx.devices[0];
    assert(device !== undefined, "缺少设备，无法申请直播地址");
    assert(ctx.channel > 0, "缺少通道号，无法申请直播地址");
    const response = await call(
      "live.links",
      `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}/live-links?channel=${ctx.channel}&protocol=FLV`,
    );
    expectOk(response, "直播地址");
    const links = asArray(asRecord(response.body)?.data)
      .map((item) => asRecord(item))
      .filter((item): item is JsonRecord => item !== undefined);
    assert(links.length > 0, "直播地址列表为空");
    const link = links[0];
    assert(link !== undefined, "直播地址列表第一项为空");
    const ttl = verifyLinkTtl(link, 10, "直播地址");
    const session = link.session;
    assert(typeof session === "string" && session !== "", "直播地址缺少 session");
    ctx.liveSession = session;
    return `通道 ${String(link.channel ?? ctx.channel)}，${ttl}`;
  });

  await run("playback.links", "媒体：回放地址", async () => {
    const device = ctx.devices[0];
    assert(device !== undefined, "缺少设备，无法申请回放地址");
    assert(ctx.channel > 0, "缺少通道号，无法申请回放地址");
    const startTime = encodeURIComponent("2026-11-18T08:00:00Z");
    const endTime = encodeURIComponent("2026-11-18T08:05:00Z");
    const response = await call(
      "playback.links",
      `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}/playback-links?channel=${ctx.channel}&startTime=${startTime}&endTime=${endTime}&storeType=0`,
    );
    expectOk(response, "回放地址");
    const links = asArray(asRecord(response.body)?.data)
      .map((item) => asRecord(item))
      .filter((item): item is JsonRecord => item !== undefined);
    assert(links.length > 0, "回放地址列表为空");
    const link = links[0];
    assert(link !== undefined, "回放地址列表第一项为空");
    const ttl = verifyLinkTtl(link, 20, "回放地址");
    assert(typeof link.session === "string" && link.session !== "", "回放地址缺少 session");
    return `通道 ${String(link.channel ?? ctx.channel)}，${ttl}`;
  });

  await run("alarms.list", "告警：列表与分页", async () => {
    const first = await call("alarms.list", "/openapi/v2/alarms?page=1&pageSize=1");
    expectOk(first, "告警列表");
    const firstRoot = asRecord(first.body);
    const firstPage = asArray(firstRoot?.data);
    assert(firstPage.length === 1, `pageSize=1 应返回 1 条，实际 ${firstPage.length} 条`);
    assert(Number(firstRoot?.page) === 1, `page 字段应为 1，实际 ${String(firstRoot?.page)}`);
    assert(Number(firstRoot?.pageSize) === 1, `pageSize 字段应为 1，实际 ${String(firstRoot?.pageSize)}`);

    const all = await call("alarms.list", "/openapi/v2/alarms?page=1&pageSize=50");
    expectOk(all, "告警列表");
    const alarms = asArray(asRecord(all.body)?.data)
      .map((item) => asRecord(item))
      .filter((item): item is JsonRecord => item !== undefined);
    assert(alarms.length > 0, "告警列表为空");
    const alarm = alarms[0];
    assert(alarm !== undefined, "告警列表第一项为空");
    const alarmId = alarm.alarmId;
    assert(typeof alarmId === "string" && alarmId !== "", "告警缺少 alarmId");
    ctx.alarmId = alarmId;
    return `分页生效，共 ${alarms.length} 条告警`;
  });

  await run("alarms.evidence-link", "告警：证据链接", async () => {
    assert(ctx.alarmId !== "", "缺少 alarmId，无法申请证据链接");
    const response = await call(
      "alarms.evidence-link",
      `/openapi/v2/alarms/evidence-link?alarmId=${encodeURIComponent(ctx.alarmId)}`,
    );
    expectOk(response, "证据链接");
    const data = asRecord(asRecord(response.body)?.data);
    assert(data !== undefined, "证据链接响应缺少 data");
    const ttl = verifyLinkTtl(data, 24 * 60 * 60, "证据链接");
    return `告警 ${ctx.alarmId}，${ttl}`;
  });

  await run("sessions.close", "会话：关闭", async () => {
    const device = ctx.devices[0];
    assert(device !== undefined, "缺少设备，无法关闭会话");
    assert(ctx.liveSession !== "", "缺少直播会话，无法关闭会话");
    const response = await call("sessions.close", "/openapi/v2/devices/session-close", {
      method: "POST",
      body: { uniqueId: device.uniqueId, session: ctx.liveSession, type: "live" },
    });
    expectOk(response, "会话关闭");
    const root = asRecord(response.body);
    const successFlag = root?.success === true;
    const codeIsOk = Number(root?.code) === 200;
    assert(successFlag || codeIsOk, "会话关闭未返回成功标记");
    return `已关闭会话 ${ctx.liveSession}`;
  });

  await run("auth.bad-token", "错误：非法 token", async () => {
    const response = await call("auth.bad-token", "/openapi/v2/devices?page=1&pageSize=1", {
      token: "TEST-INVALID-TOKEN",
    });
    assert(response.envelope.isError, "错误 token 未被拒绝");
    assert(
      String(response.envelope.code) === "3806",
      `错误码应为 3806，实际 ${String(response.envelope.code)}`,
    );
    return "错误 token 被拒绝（code=3806）";
  });

  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.length - passed;

  return {
    schemaVersion: 1,
    provider: options.provider,
    baseUrl: options.baseUrl,
    mode: "pre-research-mock",
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: { total: checks.length, passed, failed },
    checks,
    notice: PRE_RESEARCH_NOTICE,
  };
}

/** 可读摘要。 */
export function formatSummary(report: ConformanceReport): string {
  const lines: string[] = [
    "锐明 mock 一致性自测（预研版）",
    `Provider：${report.provider}`,
    `Base URL：${report.baseUrl}`,
    "----------------------------------------",
  ];

  for (const check of report.checks) {
    if (check.status === "passed") {
      const detail = check.detail === undefined ? "" : ` - ${check.detail}`;
      lines.push(`[通过] ${check.name}（${check.requestId}）${detail}`);
    } else {
      lines.push(`[失败] ${check.name}（请求 ID：${check.requestId}）原因：${check.error ?? "未知错误"}`);
    }
  }

  lines.push("----------------------------------------");
  lines.push(`总计 ${report.summary.total} 项：通过 ${report.summary.passed}，失败 ${report.summary.failed}`);
  lines.push(`注意：${report.notice}`);
  return lines.join("\n");
}

interface CliOptions {
  provider?: string;
  baseUrl?: string;
  reportPath?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const key = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;

    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index += 1;
      return argv[index];
    };

    if (key === "--provider") {
      options.provider = takeValue();
    } else if (key === "--base-url") {
      options.baseUrl = takeValue();
    } else if (key === "--report") {
      options.reportPath = takeValue();
    } else if (key === "--help" || key === "-h") {
      options.help = true;
    }
  }
  return options;
}

function printUsage(): void {
  console.log(
    [
      "用法：",
      "  npm run conformance -- --provider streamax --base-url http://127.0.0.1:18080 [--report ./conformance-report.json]",
      "",
      "参数：",
      "  --provider   接入方名称，当前预研版仅支持 streamax",
      "  --base-url   服务根地址（不含 /openapi 后缀），mock 默认 http://127.0.0.1:18080",
      "  --report     可选，额外写入 JSON 报告文件",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    printUsage();
    return;
  }

  if (options.provider === undefined || options.baseUrl === undefined) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!SUPPORTED_PROVIDERS.has(options.provider)) {
    console.error(`暂不支持 provider=${options.provider}；当前预研版仅支持 streamax。`);
    process.exitCode = 1;
    return;
  }

  const report = await runConformance({ provider: options.provider, baseUrl: options.baseUrl });

  console.log(formatSummary(report));

  if (options.reportPath !== undefined) {
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`JSON 报告已写入：${options.reportPath}`);
  }

  console.log("\n--- JSON 报告 ---");
  console.log(JSON.stringify(report, null, 2));

  process.exitCode = report.summary.failed > 0 ? 1 : 0;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`一致性自测执行失败：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
