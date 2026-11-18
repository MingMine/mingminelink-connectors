/**
 * 锐明 2.7.3-P3 → Connectors 视频源适配层（spike 原型）。
 *
 * 设计约束：
 * 1. HTTP 与错误信封判断复用 conformance/streamax-client.ts，不重复实现；
 * 2. 只吸收锐明差异（channels 逗号字符串、短时媒体地址、会话关闭等），
 *    不在此处引入业务规则或持久化；
 * 3. 类型与行为都是草案，待 V0.1 RFC 批准后才能转为正式实现。
 */

import { StreamaxClient, type StreamaxResponse } from "../../conformance/streamax-client";
import {
  CONNECTORS_ERROR_CODE,
  ConnectorsError,
  invalidResponse,
  normalizeConnectorsError,
  unsupportedCapability,
} from "./errors";
import type {
  Alarm,
  Channel,
  LiveSession,
  PlaybackSession,
  VideoSource,
} from "./types";

/** 锐明文档约定：直播地址 10 秒有效。 */
export const LIVE_LINK_TTL_SECONDS = 10;
/** 锐明文档约定：回放地址 20 秒有效。 */
export const PLAYBACK_LINK_TTL_SECONDS = 20;

type JsonRecord = Record<string, unknown>;

/** 锐明支持的直播协议。 */
export type StreamaxLiveProtocol = "FLV" | "HLS" | "RTMP" | "RTSP";

/** 适配层初始化参数。 */
export interface StreamaxAdapterOptions {
  /** 锐明网关根地址（不含 /openapi 后缀），与 conformance 保持一致。 */
  baseUrl: string;
  /** Token 由调用方通过 Sign 或 Token 流程获取；适配层不落库、不打印。 */
  token: string;
  /** 单次请求超时，默认由底层客户端决定（5000ms）。 */
  timeoutMs?: number;
  /** 请求 ID 前缀，便于在 mock 与真实环境定位问题。 */
  requestIdPrefix?: string;
}

/** 锐明能力开关；track / analysis 固定为 false。 */
export interface StreamaxCapabilities {
  live: boolean;
  playback: boolean;
  track: boolean;
  alarm: boolean;
  analysis: boolean;
}

export interface ListVideoSourcesOptions {
  page?: number;
  pageSize?: number;
  /** 锐明 uniqueIds 过滤，多个值用逗号拼接。 */
  uniqueIds?: string[];
  /** 锐明 fleetIds 过滤，多个值用逗号拼接。 */
  fleetIds?: string[];
}

export interface VideoSourcePage {
  items: VideoSource[];
  page: number;
  pageSize: number;
  total: number;
  requestId: string;
}

export interface ListAlarmsOptions {
  page?: number;
  pageSize?: number;
  /** 按视频源过滤；锐明侧对应 uniqueId。 */
  videoSourceId?: string;
}

export interface AlarmPage {
  items: Alarm[];
  page: number;
  pageSize: number;
  total: number;
  requestId: string;
}

export interface CreateLiveSessionOptions {
  videoSourceId: string;
  channelId: number;
  /** 默认 FLV；锐明同时支持 HLS / RTMP / RTSP。 */
  protocol?: StreamaxLiveProtocol;
}

export interface CreatePlaybackSessionOptions {
  videoSourceId: string;
  channelId: number;
  /** RFC 3339。 */
  startTime: string;
  /** RFC 3339，必须晚于 startTime。 */
  endTime: string;
  /** 0 主存储，1 灾备存储。 */
  storeType: 0 | 1;
}

export interface CloseSessionOptions {
  videoSourceId: string;
  sessionId: string;
}

export interface CloseSessionResult {
  closed: boolean;
  requestId: string;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function requireRecord(value: unknown, label: string, requestId: string): JsonRecord {
  const record = asRecord(value);
  if (record === undefined) {
    throw invalidResponse(`${label}不是对象`, requestId);
  }
  return record;
}

function requireString(record: JsonRecord, key: string, label: string, requestId: string): string {
  const value = stringValue(record[key]);
  if (value === undefined) {
    throw invalidResponse(`${label}缺少 ${key}`, requestId);
  }
  return value;
}

/**
 * 解析锐明 channels：兼容 "1,2" 与 [1,2] 两种形态，忽略非法值与重复值。
 *
 * 锐明 2.7.3-P3 的文档与实测都以逗号字符串为主，数组形态用于防御未来变更。
 */
export function parseStreamaxChannels(value: unknown): number[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const channels: number[] = [];
  for (const item of raw) {
    const parsed = numberValue(typeof item === "string" ? item.trim() : item);
    if (parsed !== undefined && Number.isInteger(parsed) && parsed > 0 && !channels.includes(parsed)) {
      channels.push(parsed);
    }
  }
  return channels;
}

/** 设备映射为视频源。 */
function mapVideoSource(raw: JsonRecord, requestId: string): VideoSource {
  const id = requireString(raw, "uniqueId", "设备", requestId);
  return {
    id,
    fleetId: stringValue(raw.fleetId) ?? "",
    online: stringValue(raw.onlineState) === "ONLINE",
    dormant: stringValue(raw.dormantState) === "ASLEEP",
    channels: parseStreamaxChannels(raw.channels).map((channelId) => ({
      id: channelId,
      videoSourceId: id,
    })),
    deviceType: stringValue(raw.deviceType) ?? "",
  };
}

/** 告警映射；alarmType 与 processStatus 暂保留锐明原始语义。 */
function mapAlarm(raw: JsonRecord, requestId: string): Alarm {
  return {
    alarmId: requireString(raw, "alarmId", "告警", requestId),
    videoSourceId: requireString(raw, "uniqueId", "告警", requestId),
    vehicleId: stringValue(raw.vehicleId) ?? "",
    vehicleNumber: stringValue(raw.vehicleNumber) ?? "",
    alarmType: numberValue(raw.alarmType) ?? 0,
    startTime: stringValue(raw.startTime) ?? "",
    endTime: stringValue(raw.endTime) ?? "",
    processStatus: stringValue(raw.processStatus) ?? "",
    realFlag: numberValue(raw.realFlag) ?? 0,
  };
}

/**
 * 解析媒体有效期。
 *
 * 真实环境可能不返回 expiresAt / expiresInSeconds（见 conformance 的兼容处理），
 * 此时按锐明文档 TTL 计算，避免上层拿到空有效期后误缓存地址。
 */
function resolveExpiry(
  raw: JsonRecord,
  expectedSeconds: number,
): { expiresAt: string; expiresInSeconds: number } {
  const providedTtl = numberValue(raw.expiresInSeconds);
  const expiresInSeconds = providedTtl !== undefined && providedTtl > 0 ? providedTtl : expectedSeconds;
  const expiresAt =
    stringValue(raw.expiresAt) ?? new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  return { expiresAt, expiresInSeconds };
}

/** 从媒体地址数组中找到指定通道；找不到时回退第一项。 */
function selectLink(
  body: JsonRecord,
  channelId: number,
  label: string,
  requestId: string,
): JsonRecord {
  const links = asArray(body.data)
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== undefined);
  const matched = links.find((item) => numberValue(item.channel) === channelId) ?? links[0];
  if (matched === undefined) {
    throw invalidResponse(`${label}响应缺少媒体地址`, requestId);
  }
  return matched;
}

/** 锐明适配层。 */
export class StreamaxAdapter {
  /** 能力开关：track / analysis 不在锐明能力范围内。 */
  readonly capabilities: StreamaxCapabilities = {
    live: true,
    playback: true,
    track: false,
    alarm: true,
    analysis: false,
  };

  private readonly client: StreamaxClient;
  private readonly token: string;
  private readonly timeoutMs: number | undefined;
  private readonly requestIdPrefix: string;
  private sequence = 0;

  constructor(options: StreamaxAdapterOptions) {
    this.client = new StreamaxClient(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.requestIdPrefix = options.requestIdPrefix ?? "adapter";
  }

  /** 设备列表 → 视频源列表。 */
  async listVideoSources(options: ListVideoSourcesOptions = {}): Promise<VideoSourcePage> {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      pageSize: String(options.pageSize ?? 20),
    });
    if (options.uniqueIds !== undefined && options.uniqueIds.length > 0) {
      params.set("uniqueIds", options.uniqueIds.join(","));
    }
    if (options.fleetIds !== undefined && options.fleetIds.length > 0) {
      params.set("fleetIds", options.fleetIds.join(","));
    }

    const { body, requestId } = await this.request(`/openapi/v2/devices?${params.toString()}`);
    const items = asArray(body.data).map((item) =>
      mapVideoSource(requireRecord(item, "设备列表项", requestId), requestId),
    );

    return {
      items,
      page: numberValue(body.page) ?? (options.page ?? 1),
      pageSize: numberValue(body.pageSize) ?? (options.pageSize ?? 20),
      total: numberValue(body.total) ?? items.length,
      requestId,
    };
  }

  /** 设备详情 → 视频源详情。 */
  async getVideoSource(videoSourceId: string): Promise<VideoSource> {
    const { body, requestId } = await this.request(
      `/openapi/v2/devices/${encodeURIComponent(videoSourceId)}`,
    );
    return mapVideoSource(requireRecord(body.data, "设备详情", requestId), requestId);
  }

  /** 通道列表；复用设备详情，不额外调用端点。 */
  async listChannels(videoSourceId: string): Promise<Channel[]> {
    const source = await this.getVideoSource(videoSourceId);
    return source.channels;
  }

  /** 申请直播地址；地址一次性、10 秒有效，不得缓存。 */
  async createLiveSession(options: CreateLiveSessionOptions): Promise<LiveSession> {
    const protocol = options.protocol ?? "FLV";
    const params = new URLSearchParams({
      channel: String(options.channelId),
      protocol,
    });
    const { body, requestId } = await this.request(
      `/openapi/v2/devices/${encodeURIComponent(options.videoSourceId)}/live-links?${params.toString()}`,
    );
    const link = selectLink(body, options.channelId, "直播地址", requestId);
    const expiry = resolveExpiry(link, LIVE_LINK_TTL_SECONDS);

    return {
      sessionId: requireString(link, "session", "直播地址", requestId),
      videoSourceId: options.videoSourceId,
      channelId: numberValue(link.channel) ?? options.channelId,
      protocol: stringValue(link.protocol) ?? protocol,
      url: requireString(link, "url", "直播地址", requestId),
      ...expiry,
    };
  }

  /** 申请回放地址；地址一次性、20 秒有效，storeType 必传。 */
  async createPlaybackSession(
    options: CreatePlaybackSessionOptions,
  ): Promise<PlaybackSession> {
    const params = new URLSearchParams({
      channel: String(options.channelId),
      startTime: options.startTime,
      endTime: options.endTime,
      storeType: String(options.storeType),
    });
    const { body, requestId } = await this.request(
      `/openapi/v2/devices/${encodeURIComponent(options.videoSourceId)}/playback-links?${params.toString()}`,
    );
    const link = selectLink(body, options.channelId, "回放地址", requestId);
    const expiry = resolveExpiry(link, PLAYBACK_LINK_TTL_SECONDS);

    return {
      sessionId: requireString(link, "session", "回放地址", requestId),
      videoSourceId: options.videoSourceId,
      channelId: numberValue(link.channel) ?? options.channelId,
      url: requireString(link, "url", "回放地址", requestId),
      startTime: stringValue(link.startTime) ?? options.startTime,
      endTime: stringValue(link.endTime) ?? options.endTime,
      storeType: numberValue(link.storeType) ?? options.storeType,
      ...expiry,
    };
  }

  /** 告警列表；按视频源过滤时映射为锐明 uniqueId。 */
  async listAlarms(options: ListAlarmsOptions = {}): Promise<AlarmPage> {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      pageSize: String(options.pageSize ?? 20),
    });
    if (options.videoSourceId !== undefined && options.videoSourceId !== "") {
      params.set("uniqueId", options.videoSourceId);
    }

    const { body, requestId } = await this.request(`/openapi/v2/alarms?${params.toString()}`);
    const items = asArray(body.data).map((item) =>
      mapAlarm(requireRecord(item, "告警列表项", requestId), requestId),
    );

    return {
      items,
      page: numberValue(body.page) ?? (options.page ?? 1),
      pageSize: numberValue(body.pageSize) ?? (options.pageSize ?? 20),
      total: numberValue(body.total) ?? items.length,
      requestId,
    };
  }

  /** 关闭直播或回放会话；锐明通过 session 停止播放。 */
  async closeSession(options: CloseSessionOptions): Promise<CloseSessionResult> {
    const { body, requestId } = await this.request("/openapi/v2/devices/session-close", {
      method: "POST",
      body: { uniqueId: options.videoSourceId, session: options.sessionId },
    });
    const data = asRecord(body.data);
    return { closed: data?.closed === true, requestId };
  }

  /**
   * 历史轨迹查询。
   *
   * 锐明只提供实时 GPS 推送与里程查询，没有历史轨迹；spike 阶段直接抛不支持，
   * 防止上层按 V0.1 track 能力误用。
   */
  async getTrack(): Promise<never> {
    throw unsupportedCapability("track", this.nextRequestId());
  }

  /**
   * AI 分析任务创建。
   *
   * 锐明不提供 AI 视频分析能力；spike 阶段直接抛不支持。
   */
  async createAnalysisJob(): Promise<never> {
    throw unsupportedCapability("analysis", this.nextRequestId());
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `${this.requestIdPrefix}-${this.sequence}`;
  }

  /**
   * 统一请求入口：网络失败、业务错误、响应结构错误都收敛为 ConnectorsError。
   */
  private async request(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<{ body: JsonRecord; requestId: string }> {
    const requestId = this.nextRequestId();
    let response: StreamaxResponse;
    try {
      response = await this.client.request(path, {
        method: init.method,
        body: init.body,
        token: this.token,
        requestId,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      throw new ConnectorsError({
        code: CONNECTORS_ERROR_CODE.network,
        message: `请求锐明失败：${error instanceof Error ? error.message : String(error)}`,
        requestId,
      });
    }

    if (response.envelope.isError) {
      throw normalizeConnectorsError(response.body, response.status, response.requestId);
    }

    const body = asRecord(response.body);
    if (body === undefined) {
      throw invalidResponse("响应体不是 JSON 对象", response.requestId);
    }
    return { body, requestId: response.requestId };
  }
}
