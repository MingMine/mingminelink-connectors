import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_TOKEN } from "../mock/streamax/data";
import { createMockServer } from "../mock/streamax/server";
import {
  ConnectorsError,
  StreamaxAdapter,
  normalizeConnectorsError,
  parseStreamaxChannels,
} from "../spike/streamax-adapter";

let server: Server;
let baseUrl: string;
let adapter: StreamaxAdapter;

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  adapter = new StreamaxAdapter({ baseUrl, token: MOCK_TOKEN, requestIdPrefix: "spike-test" });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/** 捕获并断言 ConnectorsError。 */
async function captureError(fn: () => Promise<unknown>): Promise<ConnectorsError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorsError);
    return error as ConnectorsError;
  }
  throw new Error("预期抛出 ConnectorsError，但调用成功");
}

describe("视频源与通道映射", () => {
  it("设备列表映射为视频源，channels 字符串转为数组", async () => {
    const page = await adapter.listVideoSources({ page: 1, pageSize: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(2);
    expect(page.total).toBe(3);
    expect(page.requestId).toMatch(/^spike-test-/);

    const first = page.items[0];
    expect(first).toMatchObject({
      id: "TEST00000001",
      fleetId: "TEST-FLEET-0001",
      online: true,
      dormant: false,
      deviceType: "TEST-DEVICE",
    });
    expect(first?.channels.map((channel) => channel.id)).toEqual([1, 2]);
    expect(first?.channels.every((channel) => channel.videoSourceId === "TEST00000001")).toBe(true);
  });

  it("uniqueIds 过滤生效", async () => {
    const page = await adapter.listVideoSources({ uniqueIds: ["TEST00000002"] });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("TEST00000002");
    expect(page.items[0]?.online).toBe(false);
    expect(page.items[0]?.dormant).toBe(true);
  });

  it("通道解析兼容逗号字符串与数组，并忽略非法值", () => {
    expect(parseStreamaxChannels("1,2,2,x,0,-1,3")).toEqual([1, 2, 3]);
    expect(parseStreamaxChannels([1, "2", 2, -1])).toEqual([1, 2]);
    expect(parseStreamaxChannels(undefined)).toEqual([]);
  });

  it("视频源详情与通道列表共用设备详情", async () => {
    const source = await adapter.getVideoSource("TEST00000003");
    expect(source.channels.map((channel) => channel.id)).toEqual([1, 2, 3]);

    const channels = await adapter.listChannels("TEST00000002");
    expect(channels).toEqual([{ id: 1, videoSourceId: "TEST00000002" }]);
  });
});

describe("直播与回放会话", () => {
  it("直播地址映射为 10 秒有效的会话", async () => {
    const live = await adapter.createLiveSession({
      videoSourceId: "TEST00000001",
      channelId: 1,
    });

    expect(live.sessionId).toMatch(/^TEST-LIVE-TEST00000001-CH1-/);
    expect(live.url).toContain("media.example.invalid");
    expect(live.expiresInSeconds).toBe(10);
    expect(live.channelId).toBe(1);
    expect(live.protocol).toBe("FLV");
    expect(Date.parse(live.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("回放地址映射为 20 秒有效的会话", async () => {
    const playback = await adapter.createPlaybackSession({
      videoSourceId: "TEST00000001",
      channelId: 2,
      startTime: "2026-11-18T08:00:00Z",
      endTime: "2026-11-18T08:05:00Z",
      storeType: 0,
    });

    expect(playback.sessionId).toMatch(/^TEST-PLAYBACK-TEST00000001-CH2-/);
    expect(playback.expiresInSeconds).toBe(20);
    expect(playback.channelId).toBe(2);
    expect(playback.startTime).toBe("2026-11-18T08:00:00Z");
    expect(playback.endTime).toBe("2026-11-18T08:05:00Z");
    expect(playback.storeType).toBe(0);
  });

  it("关闭会话返回 closed 标记", async () => {
    const result = await adapter.closeSession({
      videoSourceId: "TEST00000001",
      sessionId: "TEST-SESSION-0001",
    });

    expect(result.closed).toBe(true);
    expect(result.requestId).toMatch(/^spike-test-/);
  });
});

describe("告警映射", () => {
  it("告警列表保留锐明原始语义并支持分页", async () => {
    const page = await adapter.listAlarms({ page: 1, pageSize: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.items[0]).toMatchObject({
      alarmId: "TEST-ALARM-0001",
      videoSourceId: "TEST00000001",
      vehicleNumber: "TEST-VEHICLE-01",
      alarmType: 56002,
      processStatus: "UNPROCESSED",
      realFlag: 1,
    });
  });

  it("按视频源过滤告警", async () => {
    const page = await adapter.listAlarms({ videoSourceId: "TEST00000002" });

    expect(page.items.map((alarm) => alarm.alarmId)).toEqual(["TEST-ALARM-0002"]);
  });
});

describe("错误信封转换", () => {
  it("3806 非法用户转为 {code,message,requestId}", async () => {
    const badAdapter = new StreamaxAdapter({
      baseUrl,
      token: "TEST-INVALID-TOKEN",
      requestIdPrefix: "spike-bad",
    });

    const error = await captureError(() => badAdapter.listVideoSources());

    expect(error.code).toBe(3806);
    expect(error.message).toBe("illegal user");
    expect(error.requestId).toBe("spike-bad-1");
    expect(error.httpStatus).toBe(401);
    expect(error.toJSON()).toEqual({
      code: 3806,
      message: "illegal user",
      requestId: "spike-bad-1",
    });
  });

  it("207001 无权限即使 HTTP 200 也转为错误", () => {
    const error = normalizeConnectorsError(
      { code: 207001, message: "User has no permission" },
      200,
      "req-207001",
    );

    expect(error.code).toBe(207001);
    expect(error.message).toBe("User has no permission");
    expect(error.requestId).toBe("req-207001");
    expect(error.httpStatus).toBe(200);
  });

  it("业务错误码原样透传，请求 ID 可定位", async () => {
    const error = await captureError(() =>
      adapter.createLiveSession({ videoSourceId: "TEST00000001", channelId: 9 }),
    );

    expect(error.code).toBe(4041);
    expect(error.requestId).toMatch(/^spike-test-/);
  });

  it("设备不存在返回 4040", async () => {
    const error = await captureError(() => adapter.getVideoSource("TEST-NOT-EXIST"));

    expect(error.code).toBe(4040);
    expect(error.requestId).toMatch(/^spike-test-/);
  });
});

describe("不支持能力", () => {
  it("track 与 analysis 在能力开关中为 false", () => {
    expect(adapter.capabilities).toEqual({
      live: true,
      playback: true,
      track: false,
      alarm: true,
      analysis: false,
    });
  });

  it("调用 track 能力直接抛出 UNSUPPORTED_CAPABILITY", async () => {
    const error = await captureError(() => adapter.getTrack());

    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.message).toContain("track");
  });

  it("调用 analysis 能力直接抛出 UNSUPPORTED_CAPABILITY", async () => {
    const error = await captureError(() => adapter.createAnalysisJob());

    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.message).toContain("analysis");
  });
});
