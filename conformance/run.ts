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
import { MOCK_ACCOUNT, MOCK_SECRET, MOCK_TOKEN } from "../mock/streamax/data";
import { StreamaxClient, type StreamaxResponse } from "./streamax-client";

/** 外部鉴权参数；缺省时仅回环地址允许回退 mock token。 */
export interface ConformanceAuthOptions {
  token?: string;
  sign?: string;
  tenantId?: string;
}

export interface ConformanceOptions {
  provider: string;
  baseUrl: string;
  auth?: ConformanceAuthOptions;
  /** RFC3339 起始时间；缺省为结束时间前 24 小时。 */
  startTime?: string;
  endTime?: string;
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
  mode: "pre-research-mock" | "pre-research-real";
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

/** 鉴权模式：外部 token、Sign（sign + tenantId）、或本地 mock 回退。 */
export type ConformanceAuthMode = "token" | "sign" | "mock";

export interface ResolvedAuth {
  mode: ConformanceAuthMode;
  token?: string;
  sign?: string;
  tenantId?: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * 解析鉴权方式。
 *
 * 优先级：token → sign + tenantId → 仅回环地址回退 mock token；
 * 非回环地址缺少鉴权参数时抛错，避免“只换 base-url”误连真实环境。
 */
export function resolveAuth(baseUrl: string, auth: ConformanceAuthOptions = {}): ResolvedAuth {
  const token = auth.token?.trim() ?? "";
  if (token !== "") {
    return { mode: "token", token };
  }

  const sign = auth.sign?.trim() ?? "";
  const tenantId = auth.tenantId?.trim() ?? "";
  if (sign !== "" && tenantId !== "") {
    return { mode: "sign", sign, tenantId };
  }
  if (sign !== "" || tenantId !== "") {
    throw new Error("Sign 鉴权需要同时提供 --sign 与 --tenant-id（或 STREAMAX_SIGN / STREAMAX_TENANT_ID）。");
  }

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`非法的 base-url：${baseUrl}`);
  }

  if (isLoopbackHost(hostname)) {
    return { mode: "mock", token: MOCK_TOKEN };
  }

  throw new Error(
    "缺少鉴权参数：请提供 --token，或 --sign 与 --tenant-id（也可用环境变量 " +
      "STREAMAX_TOKEN / STREAMAX_SIGN / STREAMAX_TENANT_ID）；仅 localhost/127.0.0.1 允许回退 mock token。",
  );
}

/** RFC3339：必须包含日期、时间与时区（Z 或 ±HH:MM）。 */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 解析显式 RFC3339 时间；格式或数值非法时抛错。 */
function parseRfc3339(value: string, flag: string): number {
  if (!RFC3339_PATTERN.test(value)) {
    throw new Error(
      `非法的 ${flag}：${value}（必须是含时间与时区的 RFC3339，如 2026-11-18T08:00:00Z）`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`非法的 ${flag}：${value}`);
  }
  return ms;
}

/** 解析告警与回放查询时间窗；默认最近 24 小时，显式参数必须是 RFC3339。 */
export function resolveTimeWindow(
  startTime?: string,
  endTime?: string,
): { start: string; end: string } {
  const endMs = endTime === undefined ? Date.now() : parseRfc3339(endTime, "--end-time");
  const startMs = startTime === undefined ? endMs - 24 * 60 * 60 * 1000 : parseRfc3339(startTime, "--start-time");
  if (startMs >= endMs) {
    throw new Error("--start-time 必须早于 --end-time");
  }
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

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

/** 校验媒体地址有效期；真实环境未携带有效期信息时只校验地址存在。 */
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

  // 规格响应只返回 url；mock 在 URL 上带 expires 参数，真实环境可能不带。
  let expiresAtUnix: number | undefined;
  try {
    const parsed = new URL(url);
    const rawExpires = parsed.searchParams.get("expires");
    if (rawExpires !== null && /^\d+$/.test(rawExpires)) {
      expiresAtUnix = Number(rawExpires);
    }
  } catch {
    // 非绝对地址时跳过有效期计算。
  }

  if (expiresAtUnix === undefined) {
    return "响应仅包含 url，未携带 expires 参数，跳过有效期计算";
  }

  const remaining = expiresAtUnix - Date.now() / 1000;
  assert(
    remaining > expectedSeconds - 10,
    `${label}有效期异常：剩余 ${remaining.toFixed(0)} 秒，期望约 ${expectedSeconds} 秒`,
  );
  assert(
    remaining <= expectedSeconds + 1,
    `${label}有效期异常：剩余 ${remaining.toFixed(0)} 秒，期望约 ${expectedSeconds} 秒`,
  );
  return `有效期约 ${expectedSeconds} 秒`;
}

/**
 * 执行全部预研用例。
 *
 * 不调用 process.exit，便于测试直接复用；退出码由 CLI 主函数根据 summary 设置。
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const startedAt = new Date().toISOString();
  const auth = resolveAuth(options.baseUrl, options.auth);
  // 默认最近 24 小时，避免写死日期导致 mock 数据过期后自测失效。
  const timeWindow = resolveTimeWindow(options.startTime, options.endTime);
  const startParam = encodeURIComponent(timeWindow.start);
  const endParam = encodeURIComponent(timeWindow.end);
  const client = new StreamaxClient(options.baseUrl, auth);
  const checks: CheckResult[] = [];

  const ctx: {
    token: string;
    devices: DeviceSummary[];
    channel: number;
    liveSession: string;
    alarmId: string;
  } = {
    // mock 模式在换取 token 用例中回填；token/sign 模式由客户端鉴权配置负责。
    token: auth.mode === "token" ? auth.token ?? "" : "",
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
    init: { method?: "GET" | "POST"; body?: unknown; token?: string; sign?: string; tenantId?: string } = {},
  ): Promise<StreamaxResponse> => {
    const requestId = `conf-${checkId}-${++sequence}`;
    lastRequestId = requestId;
    const response = await client.request(path, {
      method: init.method,
      body: init.body,
      token: init.token ?? ctx.token,
      sign: init.sign,
      tenantId: init.tenantId,
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

  await run("auth.token", "鉴权：换取或验证 Token", async () => {
    if (auth.mode === "mock") {
      const response = await call("auth.token", "/openapi/auth", {
        method: "POST",
        // 固定合成账号与 secret，仅用于本地 mock；真实环境不经过此分支。
        body: { identifyCode: MOCK_ACCOUNT, secret: MOCK_SECRET },
        token: "",
      });
      expectOk(response, "换取 Token");
      const data = asRecord(asRecord(response.body)?.data);
      const token = data?.token;
      assert(typeof token === "string" && token !== "", "响应缺少 token 字段");
      ctx.token = token;
      return "Token 获取成功（合成值）";
    }

    // 真实环境不假设能直接换取 token，用一次受保护请求验证鉴权头被接受。
    const response = await call("auth.token", "/openapi/v2/devices?page=1&pageSize=1");
    expectOk(response, auth.mode === "token" ? "Token 鉴权" : "Sign 鉴权");
    return auth.mode === "token" ? "外部 Token 可用" : "外部 Sign 鉴权可用";
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
      `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}/live-links?channels=${ctx.channel}&streamingProtocol=FLV`,
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
    // 回放与告警复用同一查询时间窗，避免写死日期。
    const response = await call(
      "playback.links",
      `/openapi/v2/devices/${encodeURIComponent(device.uniqueId)}/playback-links?channels=${ctx.channel}&startTime=${startParam}&endTime=${endParam}&storeType=MAIN_STORAGE&streamingProtocol=FLV`,
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
    const first = await call(
      "alarms.list",
      `/openapi/v2/alarms?page=1&pageSize=1&startTime=${startParam}&endTime=${endParam}`,
    );
    expectOk(first, "告警列表");
    const firstRoot = asRecord(first.body);
    const firstPage = asArray(firstRoot?.data);
    assert(firstPage.length === 1, `pageSize=1 应返回 1 条，实际 ${firstPage.length} 条`);
    assert(Number(firstRoot?.page) === 1, `page 字段应为 1，实际 ${String(firstRoot?.page)}`);
    assert(Number(firstRoot?.pageSize) === 1, `pageSize 字段应为 1，实际 ${String(firstRoot?.pageSize)}`);

    const all = await call(
      "alarms.list",
      `/openapi/v2/alarms?page=1&pageSize=50&startTime=${startParam}&endTime=${endParam}`,
    );
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
      `/openapi/v2/alarms/evidence-link?alarmId=${encodeURIComponent(ctx.alarmId)}&hasAudio=1&mediaProtocol=HTTP_FLV&streamType=MAJOR`,
    );
    expectOk(response, "证据链接");
    const data = asRecord(asRecord(response.body)?.data);
    assert(data !== undefined, "证据链接响应缺少 data");
    const ttl = verifyLinkTtl(data, 24 * 60 * 60, "证据链接");
    return `告警 ${ctx.alarmId}，${ttl}`;
  });

  await run("sessions.close", "会话：关闭", async () => {
    assert(ctx.liveSession !== "", "缺少直播会话，无法关闭会话");
    const response = await call("sessions.close", "/openapi/v2/devices/session-close", {
      method: "POST",
      // CloseVideoV2ReqDTO 只要求 session。
      body: { session: ctx.liveSession },
    });
    expectOk(response, "会话关闭");
    const root = asRecord(response.body);
    const successFlag = root?.success === true;
    const codeIsOk = Number(root?.code) === 200;
    assert(successFlag || codeIsOk, "会话关闭未返回成功标记");
    return `已关闭会话 ${ctx.liveSession}`;
  });

  await run("auth.bad-token", "错误：非法鉴权", async () => {
    // 按鉴权模式构造非法凭证：token 模式发非法 token，Sign 模式发非法 _sign/_tenantid。
    const badAuth =
      auth.mode === "sign"
        ? { sign: "TEST-INVALID-SIGN", tenantId: "TEST-INVALID-TENANT" }
        : { token: "TEST-INVALID-TOKEN" };
    const response = await call("auth.bad-token", "/openapi/v2/devices?page=1&pageSize=1", badAuth);
    assert(response.envelope.isError, "错误鉴权未被拒绝");
    assert(response.status === 401, `错误鉴权 HTTP 状态应为 401，实际 ${response.status}`);
    assert(
      String(response.envelope.code) === "3806",
      `错误码应为 3806，实际 ${String(response.envelope.code)}`,
    );
    return "错误鉴权被拒绝（HTTP 401，code=3806）";
  });

  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.length - passed;

  return {
    schemaVersion: 1,
    provider: options.provider,
    baseUrl: options.baseUrl,
    mode: auth.mode === "mock" ? "pre-research-mock" : "pre-research-real",
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
  token?: string;
  sign?: string;
  tenantId?: string;
  startTime?: string;
  endTime?: string;
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
    } else if (key === "--token") {
      options.token = takeValue();
    } else if (key === "--sign") {
      options.sign = takeValue();
    } else if (key === "--tenant-id") {
      options.tenantId = takeValue();
    } else if (key === "--start-time") {
      options.startTime = takeValue();
    } else if (key === "--end-time") {
      options.endTime = takeValue();
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
      "  npm run conformance -- --provider streamax --base-url http://127.0.0.1:18080 [鉴权参数] [时间窗参数]",
      "",
      "参数：",
      "  --provider     接入方名称，当前预研版仅支持 streamax",
      "  --base-url     服务根地址（不含 /openapi 后缀），mock 默认 http://127.0.0.1:18080",
      "  --token        访问 token，作为 token 请求头发送（或环境变量 STREAMAX_TOKEN）",
      "  --sign         Sign 签名，与 --tenant-id 一起作为 _sign 请求头发送（或 STREAMAX_SIGN）",
      "  --tenant-id    租户号，作为 _tenantid 请求头发送（或 STREAMAX_TENANT_ID）",
      "  --start-time   告警与回放查询起始时间（RFC3339），默认最近 24 小时",
      "  --end-time     告警与回放查询结束时间（RFC3339），默认当前时间",
      "  --report       可选，额外写入 JSON 报告文件",
      "",
      "鉴权说明：有 token 用 token 头；否则用 sign + tenant-id 的 _sign/_tenantid 头；",
      "两者都没有时仅 localhost/127.0.0.1 回退 mock token，其他地址直接报错退出。",
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

  const auth: ConformanceAuthOptions = {
    token: options.token ?? process.env.STREAMAX_TOKEN,
    sign: options.sign ?? process.env.STREAMAX_SIGN,
    tenantId: options.tenantId ?? process.env.STREAMAX_TENANT_ID,
  };

  const report = await runConformance({
    provider: options.provider,
    baseUrl: options.baseUrl,
    auth,
    startTime: options.startTime,
    endTime: options.endTime,
  });

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
