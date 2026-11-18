/**
 * 锐明媒体地址模拟。
 *
 * 锐明 2.7.3-P3 的直播地址 10 秒有效、回放地址 20 秒有效、告警证据下载地址 24 小时有效。
 * 这里只生成一次性短时地址，URL 指向 example.invalid 合成域名，不含真实媒体服务。
 */

/** 各类媒体地址有效期（秒）。 */
export const MEDIA_TTL_SECONDS = {
  live: 10,
  playback: 20,
  evidence: 24 * 60 * 60,
} as const;

export type MediaLinkKind = keyof typeof MEDIA_TTL_SECONDS;

export interface MediaLink {
  url: string;
  /** RFC 3339 时间，便于客户端直接判断过期。 */
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * 生成合成媒体地址。
 *
 * @param kind 媒体类型，决定有效期与 URL 路径段
 * @param session 合成会话号
 * @param now 当前时间，测试可注入固定值
 * @param format 媒体格式后缀，默认直播/回放为 flv、证据为 mp4
 */
export function createMediaLink(
  kind: MediaLinkKind,
  session: string,
  now: Date = new Date(),
  format?: string,
): MediaLink {
  const ttl = MEDIA_TTL_SECONDS[kind];
  const expiresAtMs = now.getTime() + ttl * 1000;
  const expiresAtUnix = Math.floor(expiresAtMs / 1000);
  const extension = format ?? (kind === "evidence" ? "mp4" : "flv");
  const pathSegment = kind === "evidence" ? "evidence" : kind;
  const url = `https://media.example.invalid/${pathSegment}/${encodeURIComponent(session)}.${extension}?expires=${expiresAtUnix}`;

  return {
    url,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: ttl,
  };
}
