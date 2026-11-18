/**
 * 锐明技术（Streamax）Mining Platform API 2.7.3-P3 合成 mock 服务。
 *
 * 说明：
 * 1. 本服务只模拟预研所需的关键端点，不是锐明平台的完整实现；
 * 2. 所有数据均为合成数据，设备号、租户号、媒体域名均为虚构值；
 * 3. 鉴权端点严格校验固定 mock 账号与 secret；其余端点只校验固定 mock token，
 *    不实现锐明 Sign 签名方案。
 *
 * 默认启动：node dist/mock/streamax/server.js（127.0.0.1:18080）
 */

import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  MOCK_ACCOUNT,
  MOCK_ALARMS,
  MOCK_APP_ID,
  MOCK_DEVICES,
  MOCK_PUBLIC_KEY,
  MOCK_SECRET,
  MOCK_TENANT_ID,
  MOCK_TOKEN,
  type MockDevice,
} from "./data";
import { createMediaLink } from "./media";

const DEFAULT_PORT = 18080;
const DEFAULT_HOST = "127.0.0.1";
const MAX_PAGE_SIZE = 100;

/** 锐明 2.7.3-P3 媒体协议枚举。 */
const STREAMING_PROTOCOLS: Record<string, string> = {
  FLV: "flv",
  HLS: "m3u8",
  RTMP: "rtmp",
  RTSP: "rtsp",
};
/** 锐明 2.7.3-P3 存储类型枚举。 */
const STORE_TYPES = new Set(["MAIN_STORAGE", "SUB_STORAGE"]);
/** 锐明 2.7.3-P3 证据链接媒体协议枚举。 */
const EVIDENCE_MEDIA_PROTOCOLS = new Set(["HTTP_FLV", "HLS"]);
/** 锐明 2.7.3-P3 证据流类型枚举。 */
const EVIDENCE_STREAM_TYPES = new Set(["MAJOR", "MINOR"]);

type JsonRecord = Record<string, unknown>;

/** 安全地把 unknown 收窄为普通对象。 */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** 读取请求头中的单个字符串值。 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

/** 兼容锐明的 token 头与 Bearer 头，便于预研脚本切换。 */
function readToken(req: IncomingMessage): string | undefined {
  const token = headerValue(req, "token");
  if (typeof token === "string" && token.trim() !== "") {
    return token.trim();
  }
  const authorization = headerValue(req, "authorization");
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return undefined;
}

type BodyReadResult = { ok: true; value: unknown } | { ok: false };

/** 读取 JSON 请求体；空请求体视为 undefined，非法 JSON 视为失败。 */
async function readJsonBody(req: IncomingMessage): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** 统一 JSON 响应输出。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 错误信封：与锐明实际响应保持最小一致，便于接入层转换。 */
function errorBody(requestId: string, code: number, message: string): JsonRecord {
  return { code, message, success: false, requestId };
}

/** 解析正整数参数；缺省使用默认值，非法返回 undefined。 */
function parsePositiveInt(raw: string | null, fallback: number): number | undefined {
  if (raw === null || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return value >= 1 ? value : undefined;
}

/** 拆分逗号分隔参数。 */
function splitCsv(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 设备通道号数组，锐明的 channels 是逗号分隔字符串。 */
function deviceChannels(device: MockDevice): number[] {
  return splitCsv(device.channels)
    .map((item) => Number(item))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/** 读取必填 query 参数；缺失或空白返回 undefined。 */
function readRequiredParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

/** 根据 channels 参数筛选通道；请求了不存在的通道返回 undefined。 */
function selectChannels(device: MockDevice, raw: string | null): number[] | undefined {
  const available = deviceChannels(device);
  if (raw === null || raw.trim() === "") {
    return available;
  }
  const requested = splitCsv(raw).map((item) => Number(item));
  if (requested.length === 0) {
    return undefined;
  }
  if (requested.some((item) => !Number.isInteger(item) || !available.includes(item))) {
    return undefined;
  }
  return requested;
}

function findDevice(uniqueId: string): MockDevice | undefined {
  return MOCK_DEVICES.find((device) => device.uniqueId === uniqueId);
}

/** GET /openapi/auth/public-key */
function handlePublicKey(res: ServerResponse, requestId: string): void {
  sendJson(res, 200, {
    requestId,
    code: 200,
    success: true,
    message: "success",
    data: {
      publicKey: MOCK_PUBLIC_KEY,
      algorithm: "RSA",
      keyFormat: "PEM",
    },
  });
}

/** POST /openapi/auth */
async function handleAuth(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid json body"));
    return;
  }

  const payload = asRecord(body.value);
  const tenantRaw = payload?.tenantId;
  const tenantId =
    typeof tenantRaw === "number" ? String(tenantRaw) : typeof tenantRaw === "string" ? tenantRaw : "";
  const appRaw = payload?.appId;
  const appId = typeof appRaw === "number" ? String(appRaw) : typeof appRaw === "string" ? appRaw : "";
  const identifyCodeRaw = payload?.identifyCode;
  const identifyCode = typeof identifyCodeRaw === "string" ? identifyCodeRaw : "";
  const secretRaw = payload?.secret;
  const secret = typeof secretRaw === "string" ? secretRaw : "";

  // 严格校验固定 mock 账号与 secret；任何不匹配都按非法用户处理。
  if (identifyCode !== MOCK_ACCOUNT || secret !== MOCK_SECRET) {
    sendJson(res, 401, errorBody(requestId, 3806, "illegal user"));
    return;
  }

  sendJson(res, 200, {
    requestId,
    code: 200,
    success: true,
    message: "success",
    data: {
      token: MOCK_TOKEN,
      tokenType: "token",
      expiresIn: 86400,
      tenantId: tenantId === "" ? MOCK_TENANT_ID : tenantId,
      appId: appId === "" ? MOCK_APP_ID : appId,
    },
  });
}

/** GET /openapi/v2/devices */
function handleDeviceList(url: URL, res: ServerResponse, requestId: string): void {
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20);
  if (page === undefined || pageSize === undefined || pageSize > MAX_PAGE_SIZE) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid pagination parameters"));
    return;
  }

  const uniqueIds = splitCsv(url.searchParams.get("uniqueIds"));
  const fleetIds = splitCsv(url.searchParams.get("fleetIds"));
  const filtered = MOCK_DEVICES.filter((device) => {
    const matchUniqueId = uniqueIds.length === 0 || uniqueIds.includes(device.uniqueId);
    const matchFleetId = fleetIds.length === 0 || fleetIds.includes(device.fleetId);
    return matchUniqueId && matchFleetId;
  });

  const offset = (page - 1) * pageSize;
  // 2.7.3-P3 PageResponse 只有 data、page、pageSize、requestId，不返回 total。
  sendJson(res, 200, {
    requestId,
    data: filtered.slice(offset, offset + pageSize).map((device) => ({ ...device })),
    page,
    pageSize,
  });
}

/** GET /openapi/v2/devices/{uniqueId} */
function handleDeviceDetail(uniqueId: string, res: ServerResponse, requestId: string): void {
  const device = findDevice(uniqueId);
  if (device === undefined) {
    sendJson(res, 404, errorBody(requestId, 4040, "device not found"));
    return;
  }
  sendJson(res, 200, { requestId, data: { ...device } });
}

/** GET /openapi/v2/devices/{uniqueId}/live-links */
function handleLiveLinks(uniqueId: string, url: URL, res: ServerResponse, requestId: string): void {
  const device = findDevice(uniqueId);
  if (device === undefined) {
    sendJson(res, 404, errorBody(requestId, 4040, "device not found"));
    return;
  }

  // 锐明 2.7.3-P3：channels 与 streamingProtocol 均为必填。
  const rawChannels = readRequiredParam(url, "channels");
  if (rawChannels === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: channels"));
    return;
  }
  const streamingProtocol = readRequiredParam(url, "streamingProtocol");
  if (streamingProtocol === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamingProtocol"));
    return;
  }
  const format = STREAMING_PROTOCOLS[streamingProtocol];
  if (format === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamingProtocol"));
    return;
  }

  const channels = selectChannels(device, rawChannels);
  if (channels === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: channels"));
    return;
  }

  // 规格响应项只有 channel、session、url。
  const data = channels.map((channel) => {
    const session = `TEST-LIVE-${device.uniqueId}-CH${channel}-${randomUUID().slice(0, 8)}`;
    const link = createMediaLink("live", session, new Date(), format);
    return { channel, session, url: link.url };
  });

  sendJson(res, 200, { requestId, data });
}

/** GET /openapi/v2/devices/{uniqueId}/playback-links */
function handlePlaybackLinks(uniqueId: string, url: URL, res: ServerResponse, requestId: string): void {
  const device = findDevice(uniqueId);
  if (device === undefined) {
    sendJson(res, 404, errorBody(requestId, 4040, "device not found"));
    return;
  }

  // 锐明 2.7.3-P3：channels、startTime、endTime、storeType、streamingProtocol 均为必填。
  const rawChannels = readRequiredParam(url, "channels");
  if (rawChannels === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: channels"));
    return;
  }
  const startTime = readRequiredParam(url, "startTime");
  if (startTime === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: startTime"));
    return;
  }
  const endTime = readRequiredParam(url, "endTime");
  if (endTime === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: endTime"));
    return;
  }
  const storeType = readRequiredParam(url, "storeType");
  if (storeType === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: storeType"));
    return;
  }
  const streamingProtocol = readRequiredParam(url, "streamingProtocol");
  if (streamingProtocol === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamingProtocol"));
    return;
  }

  if (!STORE_TYPES.has(storeType)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: storeType"));
    return;
  }
  const format = STREAMING_PROTOCOLS[streamingProtocol];
  if (format === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamingProtocol"));
    return;
  }

  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (Number.isNaN(startMs)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: startTime"));
    return;
  }
  if (Number.isNaN(endMs)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: endTime"));
    return;
  }
  if (startMs >= endMs) {
    sendJson(res, 400, errorBody(requestId, 3800, "endTime must be later than startTime"));
    return;
  }

  const channels = selectChannels(device, rawChannels);
  if (channels === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: channels"));
    return;
  }

  // 规格响应项只有 channel、session、url。
  const data = channels.map((channel) => {
    const session = `TEST-PLAYBACK-${device.uniqueId}-CH${channel}-${randomUUID().slice(0, 8)}`;
    const link = createMediaLink("playback", session, new Date(), format);
    return { channel, session, url: link.url };
  });

  sendJson(res, 200, { requestId, data });
}

/** GET /openapi/v2/alarms */
function handleAlarmList(url: URL, res: ServerResponse, requestId: string): void {
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20);
  if (page === undefined || pageSize === undefined || pageSize > MAX_PAGE_SIZE) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid pagination parameters"));
    return;
  }

  // 锐明 2.7.3-P3：startTime、endTime 必填；设备过滤参数名为 uniqueIds。
  const startTime = readRequiredParam(url, "startTime");
  if (startTime === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: startTime"));
    return;
  }
  const endTime = readRequiredParam(url, "endTime");
  if (endTime === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: endTime"));
    return;
  }

  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (Number.isNaN(startMs)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: startTime"));
    return;
  }
  if (Number.isNaN(endMs)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: endTime"));
    return;
  }
  if (startMs >= endMs) {
    sendJson(res, 400, errorBody(requestId, 3800, "endTime must be later than startTime"));
    return;
  }

  const uniqueIds = splitCsv(url.searchParams.get("uniqueIds"));
  const filtered = MOCK_ALARMS.filter((alarm) => {
    const alarmStart = Date.parse(alarm.startTime);
    const inRange = alarmStart >= startMs && alarmStart <= endMs;
    const matchUniqueId = uniqueIds.length === 0 || uniqueIds.includes(alarm.uniqueId);
    return inRange && matchUniqueId;
  });
  const offset = (page - 1) * pageSize;

  // 2.7.3-P3 PageResponse 只有 data、page、pageSize、requestId，不返回 total。
  sendJson(res, 200, {
    requestId,
    data: filtered.slice(offset, offset + pageSize).map((alarm) => ({ ...alarm })),
    page,
    pageSize,
  });
}

/** GET /openapi/v2/alarms/evidence-link */
function handleEvidenceLink(url: URL, res: ServerResponse, requestId: string): void {
  // 锐明 2.7.3-P3：alarmId、hasAudio、mediaProtocol、streamType 均为必填。
  const alarmId = readRequiredParam(url, "alarmId");
  if (alarmId === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: alarmId"));
    return;
  }
  const hasAudio = readRequiredParam(url, "hasAudio");
  if (hasAudio === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: hasAudio"));
    return;
  }
  const mediaProtocol = readRequiredParam(url, "mediaProtocol");
  if (mediaProtocol === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: mediaProtocol"));
    return;
  }
  const streamType = readRequiredParam(url, "streamType");
  if (streamType === undefined) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamType"));
    return;
  }

  if (hasAudio !== "0" && hasAudio !== "1") {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: hasAudio"));
    return;
  }
  if (!EVIDENCE_MEDIA_PROTOCOLS.has(mediaProtocol)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: mediaProtocol"));
    return;
  }
  if (!EVIDENCE_STREAM_TYPES.has(streamType)) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: streamType"));
    return;
  }

  const alarm = MOCK_ALARMS.find((item) => item.alarmId === alarmId);
  if (alarm === undefined) {
    sendJson(res, 404, errorBody(requestId, 4042, "alarm not found"));
    return;
  }

  const link = createMediaLink("evidence", `TEST-EVIDENCE-${alarm.alarmId}`, new Date(), "mp4");
  sendJson(res, 200, {
    requestId,
    data: {
      alarmId: alarm.alarmId,
      uniqueId: alarm.uniqueId,
      ...link,
    },
  });
}

/** POST /openapi/v2/devices/session-close */
async function handleSessionClose(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid json body"));
    return;
  }

  // 锐明 2.7.3-P3 CloseVideoV2ReqDTO 只要求 session。
  const payload = asRecord(body.value);
  const session = typeof payload?.session === "string" ? payload.session : "";

  if (session === "") {
    sendJson(res, 400, errorBody(requestId, 3800, "invalid parameter: session"));
    return;
  }

  sendJson(res, 200, {
    requestId,
    code: 200,
    success: true,
    message: "success",
    data: {
      session,
      closed: true,
    },
  });
}

/** 路由分发。 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  // 公共端点：无需 token。
  if (method === "GET" && path === "/openapi/auth/public-key") {
    handlePublicKey(res, requestId);
    return;
  }
  if (method === "POST" && path === "/openapi/auth") {
    await handleAuth(req, res, requestId);
    return;
  }

  // 其余端点统一校验 token。
  if (readToken(req) !== MOCK_TOKEN) {
    sendJson(res, 401, errorBody(requestId, 3806, "illegal user"));
    return;
  }

  if (method === "POST" && path === "/openapi/v2/devices/session-close") {
    await handleSessionClose(req, res, requestId);
    return;
  }
  if (method === "GET" && path === "/openapi/v2/devices") {
    handleDeviceList(url, res, requestId);
    return;
  }

  const liveMatch = /^\/openapi\/v2\/devices\/([^/]+)\/live-links$/.exec(path);
  if (method === "GET" && liveMatch !== null) {
    handleLiveLinks(decodeURIComponent(liveMatch[1] ?? ""), url, res, requestId);
    return;
  }

  const playbackMatch = /^\/openapi\/v2\/devices\/([^/]+)\/playback-links$/.exec(path);
  if (method === "GET" && playbackMatch !== null) {
    handlePlaybackLinks(decodeURIComponent(playbackMatch[1] ?? ""), url, res, requestId);
    return;
  }

  const detailMatch = /^\/openapi\/v2\/devices\/([^/]+)$/.exec(path);
  if (method === "GET" && detailMatch !== null) {
    handleDeviceDetail(decodeURIComponent(detailMatch[1] ?? ""), res, requestId);
    return;
  }

  if (method === "GET" && path === "/openapi/v2/alarms") {
    handleAlarmList(url, res, requestId);
    return;
  }
  if (method === "GET" && path === "/openapi/v2/alarms/evidence-link") {
    handleEvidenceLink(url, res, requestId);
    return;
  }

  sendJson(res, 404, errorBody(requestId, 4044, "endpoint not found"));
}

/** 创建 mock HTTP 服务（未监听端口，便于测试注入）。 */
export function createMockServer(): Server {
  let sequence = 0;

  return createHttpServer((req, res) => {
    const headerRequestId = headerValue(req, "x-request-id");
    const requestId =
      headerRequestId !== undefined && headerRequestId.trim() !== ""
        ? headerRequestId.trim()
        : `mock-${++sequence}`;
    res.setHeader("x-request-id", requestId);

    handleRequest(req, res, requestId).catch(() => {
      sendJson(res, 500, errorBody(requestId, 5000, "mock internal error"));
    });
  });
}

/** 启动并监听端口。 */
export function startMockServer(port: number = DEFAULT_PORT, host: string = DEFAULT_HOST): Server {
  const server = createMockServer();
  server.listen(port, host, () => {
    console.log(`[mock] 锐明 2.7.3-P3 合成 mock 已启动：http://${host}:${port}`);
    console.log(`[mock] 固定 token：${MOCK_TOKEN}（合成值，仅用于预研自测）`);
    console.log("[mock] 所有设备、告警与媒体地址均为合成数据，不代表锐明真实环境。");
  });
  return server;
}

/** 解析端口：优先 --port，其次 PORT 环境变量。 */
function resolvePort(argv: string[]): number {
  const inline = argv.find((arg) => arg.startsWith("--port="));
  const portIndex = argv.findIndex((arg) => arg === "--port" || arg === "-p");
  const raw = inline !== undefined ? inline.slice("--port=".length) : portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const candidate = raw ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[mock] 非法端口：${candidate}，回退到 ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

if (require.main === module) {
  const host = process.env.HOST ?? DEFAULT_HOST;
  const server = startMockServer(resolvePort(process.argv.slice(2)), host);
  const shutdown = (): void => {
    console.log("[mock] 正在关闭...");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
