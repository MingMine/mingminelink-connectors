/**
 * V0.1 视频源轻量类型（草案，待 RFC）。
 *
 * 注意：
 * 1. 本文件只服务于 S3 spike，用于验证“锐明 2.7.3-P3 → 视频源模型”的映射可行性；
 * 2. 字段尚未冻结，不得被 spec/ 或生产代码引用；
 * 3. 正式类型以 V0.1 RFC 批准的 OpenAPI / MCP schema 为准。
 */

/** 视频源：草案，待 RFC。锐明侧对应设备（device.uniqueId）。 */
export interface VideoSource {
  /** 视频源标识；锐明侧取 device.uniqueId。 */
  id: string;
  /** 车组标识；锐明侧取 fleetId，缺失时为空字符串。 */
  fleetId: string;
  /** 设备是否在线；锐明侧 onlineState === "ONLINE"。 */
  online: boolean;
  /** 设备是否休眠；锐明侧 dormantState === "ASLEEP"。 */
  dormant: boolean;
  /** 通道列表；由锐明 channels 逗号字符串拆分而来。 */
  channels: Channel[];
  /** 设备类型；锐明侧原样透传 deviceType。 */
  deviceType: string;
}

/** 通道：草案，待 RFC。锐明侧没有独立通道对象，只有通道号。 */
export interface Channel {
  /** 通道号；锐明侧为数字。 */
  id: number;
  /** 所属视频源。 */
  videoSourceId: string;
}

/** 直播会话：草案，待 RFC。锐明直播地址一次性、10 秒有效。 */
export interface LiveSession {
  /** 会话号；用于关闭会话，锐明侧取响应 session。 */
  sessionId: string;
  videoSourceId: string;
  channelId: number;
  /** 媒体协议；锐明侧支持 FLV / HLS / RTMP / RTSP。 */
  protocol: string;
  /** 一次性播放地址，不得落库或缓存。 */
  url: string;
  /** RFC 3339 过期时间；锐明真实环境可能不返回，适配层按文档 TTL 计算。 */
  expiresAt: string;
  /** 有效期秒数；直播默认 10 秒。 */
  expiresInSeconds: number;
}

/** 回放会话：草案，待 RFC。锐明回放地址一次性、20 秒有效。 */
export interface PlaybackSession {
  sessionId: string;
  videoSourceId: string;
  channelId: number;
  url: string;
  /** 回放开始时间，RFC 3339。 */
  startTime: string;
  /** 回放结束时间，RFC 3339。 */
  endTime: string;
  /** 存储类型；锐明侧 0 为主存储、1 为灾备存储。 */
  storeType: number;
  expiresAt: string;
  /** 有效期秒数；回放默认 20 秒。 */
  expiresInSeconds: number;
}

/** 告警：草案，待 RFC。字段目前为锐明原始语义。 */
export interface Alarm {
  alarmId: string;
  videoSourceId: string;
  vehicleId: string;
  vehicleNumber: string;
  /** 锐明告警类型编号，尚未映射为 Connectors 枚举。 */
  alarmType: number;
  /** 告警开始时间，RFC 3339。 */
  startTime: string;
  /** 告警结束时间，RFC 3339。 */
  endTime: string;
  /** 锐明处理状态原文，尚未映射为 Connectors 状态。 */
  processStatus: string;
  /** 是否实时告警；锐明侧 1/0。 */
  realFlag: number;
}

/** Connectors 统一错误信封：草案，待 RFC。 */
export interface ConnectorsErrorPayload {
  /** 锐明业务错误码原样保留；适配层自身错误使用字符串码。 */
  code: string | number;
  message: string;
  requestId: string;
}
