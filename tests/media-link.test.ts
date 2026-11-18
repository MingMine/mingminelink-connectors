import { describe, expect, it } from "vitest";
import { createMediaLink, MEDIA_TTL_SECONDS } from "../mock/streamax/media";

describe("媒体地址有效期计算", () => {
  const now = new Date("2026-11-19T00:00:00.000Z");

  it("直播地址 10 秒有效", () => {
    const link = createMediaLink("live", "TEST-SESSION-LIVE-0001", now);
    const url = new URL(link.url);

    expect(MEDIA_TTL_SECONDS.live).toBe(10);
    expect(link.expiresInSeconds).toBe(10);
    expect(link.expiresAt).toBe("2026-11-19T00:00:10.000Z");
    expect(url.hostname).toBe("media.example.invalid");
    expect(url.pathname).toBe("/live/TEST-SESSION-LIVE-0001.flv");
    expect(Number(url.searchParams.get("expires"))).toBe(Math.floor(now.getTime() / 1000) + 10);
  });

  it("回放地址 20 秒有效", () => {
    const link = createMediaLink("playback", "TEST-SESSION-PLAYBACK-0001", now);
    const url = new URL(link.url);

    expect(MEDIA_TTL_SECONDS.playback).toBe(20);
    expect(link.expiresInSeconds).toBe(20);
    expect(link.expiresAt).toBe("2026-11-19T00:00:20.000Z");
    expect(url.pathname).toBe("/playback/TEST-SESSION-PLAYBACK-0001.flv");
    expect(Number(url.searchParams.get("expires"))).toBe(Math.floor(now.getTime() / 1000) + 20);
  });

  it("证据链接 24 小时有效", () => {
    const link = createMediaLink("evidence", "TEST-EVIDENCE-0001", now);
    const url = new URL(link.url);

    expect(MEDIA_TTL_SECONDS.evidence).toBe(24 * 60 * 60);
    expect(link.expiresInSeconds).toBe(24 * 60 * 60);
    expect(link.expiresAt).toBe("2026-11-20T00:00:00.000Z");
    expect(url.pathname).toBe("/evidence/TEST-EVIDENCE-0001.mp4");
  });

  it("支持指定媒体格式后缀", () => {
    const link = createMediaLink("live", "TEST-SESSION-HLS", now, "m3u8");
    expect(new URL(link.url).pathname).toBe("/live/TEST-SESSION-HLS.m3u8");
  });
});
