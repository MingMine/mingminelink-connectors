import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_ACCOUNT, MOCK_SECRET, MOCK_TOKEN } from "../mock/streamax/data";
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

let stubServer: Server;
let stubBaseUrl: string;
let stubAdapter: StreamaxAdapter;

interface CapturedRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

let captured: CapturedRequest | undefined;

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  adapter = new StreamaxAdapter({ baseUrl, token: MOCK_TOKEN, requestIdPrefix: "spike-test" });

  // 记录请求参数并返回可控响应，用于验证适配层实际发出的参数名与请求体。
  stubServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw === "" ? undefined : JSON.parse(raw);
    }
    captured = {
      method: req.method ?? "GET",
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body:
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined,
    };

    const send = (payload: unknown): void => {
      const text = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    };

    if (url.pathname === "/openapi/v2/devices/TEST-DORMANT-0001") {
      send({
        requestId: "stub-device",
        data: {
          uniqueId: "TEST-DORMANT-0001",
          fleetId: "TEST-FLEET",
          onlineState: "ONLINE",
          dormantState: "DORMANT",
          channels: "1",
          deviceType: "TEST-DEVICE",
        },
      });
      return;
    }
    // 旧枚举 ASLEEP 属非规格值，用于验证适配层不会误判为休眠。
    if (url.pathname === "/openapi/v2/devices/TEST-ASLEEP-0001") {
      send({
        requestId: "stub-device-asleep",
        data: {
          uniqueId: "TEST-ASLEEP-0001",
          fleetId: "TEST-FLEET",
          onlineState: "OFFLINE",
          dormantState: "ASLEEP",
          channels: "1",
          deviceType: "TEST-DEVICE",
        },
      });
      return;
    }
    if (url.pathname.endsWith("/live-links")) {
      send({
        requestId: "stub-live",
        data: [
          {
            channel: 1,
            session: "TEST-STUB-LIVE",
            url: "https://media.example.invalid/live/TEST-STUB-LIVE.flv",
          },
        ],
      });
      return;
    }
    if (url.pathname.endsWith("/playback-links")) {
      send({
        requestId: "stub-playback",
        data: [
          {
            channel: 1,
            session: "TEST-STUB-PLAYBACK",
            url: "https://media.example.invalid/playback/TEST-STUB-PLAYBACK.flv",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/openapi/v2/devices/session-close") {
      send({ requestId: "stub-close", code: 200, success: true, data: { closed: true } });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 4044, message: "stub not found", requestId: "stub-404" }));
  });
  await new Promise<void>((resolve, reject) => {
    stubServer.once("error", reject);
    stubServer.listen(0, "127.0.0.1", () => resolve());
  });
  const stubAddress = stubServer.address() as AddressInfo;
  stubBaseUrl = `http://127.0.0.1:${stubAddress.port}`;
  stubAdapter = new StreamaxAdapter({
    baseUrl: stubBaseUrl,
    token: MOCK_TOKEN,
    requestIdPrefix: "stub",
  });
});

afterAll(async () => {
  await Promise.all(
    [server, stubServer].map(
      (target) =>
        new Promise<void>((resolve, reject) => {
          target.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
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
    // mock 按 2.7.3-P3 不返回 total，适配层回退为当前页条数。
    expect(page.total).toBe(2);
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

  it("uniqueIds 过滤生效，DORMANT 映射为休眠", async () => {
    const page = await adapter.listVideoSources({ uniqueIds: ["TEST00000002"] });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("TEST00000002");
    expect(page.items[0]?.online).toBe(false);
    // 规格枚举为 AWAKE/DORMANT/UNKNOWN，DORMANT 才是休眠。
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
      storeType: "MAIN_STORAGE",
    });

    expect(playback.sessionId).toMatch(/^TEST-PLAYBACK-TEST00000001-CH2-/);
    expect(playback.expiresInSeconds).toBe(20);
    expect(playback.channelId).toBe(2);
    expect(playback.startTime).toBe("2026-11-18T08:00:00Z");
    expect(playback.endTime).toBe("2026-11-18T08:05:00Z");
    expect(playback.storeType).toBe("MAIN_STORAGE");
  });

  it("关闭会话只传 session", async () => {
    const result = await adapter.closeSession({ sessionId: "TEST-SESSION-0001" });

    expect(result.closed).toBe(true);
    expect(result.requestId).toMatch(/^spike-test-/);
  });
});

describe("告警映射", () => {
  // mock 告警时间以加载时间为基准合成，使用最近 24 小时覆盖全部告警。
  const range = {
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 60 * 1000).toISOString(),
  };

  it("告警列表保留锐明原始语义并支持分页", async () => {
    const page = await adapter.listAlarms({ ...range, page: 1, pageSize: 2 });

    expect(page.items).toHaveLength(2);
    // mock 不返回 total，适配层回退为当前页条数。
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({
      alarmId: "TEST-ALARM-0001",
      videoSourceId: "TEST00000001",
      vehicleNumber: "TEST-VEHICLE-01",
      alarmType: 56002,
      processStatus: "UNPROCESSED",
      realFlag: 1,
    });
  });

  it("按视频源过滤告警，参数名为 uniqueIds", async () => {
    const page = await adapter.listAlarms({ ...range, videoSourceIds: ["TEST00000002"] });

    expect(page.items.map((alarm) => alarm.alarmId)).toEqual(["TEST-ALARM-0002"]);
  });

  it("缺少时间范围时由 mock 拒绝，证明 startTime/endTime 必填", async () => {
    const error = await captureError(() =>
      adapter.listAlarms({
        page: 1,
      } as unknown as Parameters<StreamaxAdapter["listAlarms"]>[0]),
    );

    expect(error.code).toBe(3800);
    expect(error.message).toContain("startTime");
  });
});

describe("严格鉴权", () => {
  /** 调用 mock 的 /openapi/auth 换取 token。 */
  async function postAuth(payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}/openapi/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "spike-auth" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  it("账号或 secret 不匹配时拒绝签发 token", async () => {
    const wrongSecret = await postAuth({ identifyCode: MOCK_ACCOUNT, secret: "TEST-WRONG-SECRET" });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body).toMatchObject({ code: 3806, success: false });
    expect(wrongSecret.body.data?.token).toBeUndefined();

    const wrongAccount = await postAuth({ identifyCode: "TEST-UNKNOWN", secret: MOCK_SECRET });
    expect(wrongAccount.status).toBe(401);
    expect(wrongAccount.body).toMatchObject({ code: 3806, success: false });
    expect(wrongAccount.body.data?.token).toBeUndefined();
  });

  it("固定账号换取 token 后可调用适配层", async () => {
    const auth = await postAuth({ identifyCode: MOCK_ACCOUNT, secret: MOCK_SECRET });
    expect(auth.status).toBe(200);
    expect(auth.body.data.token).toBe(MOCK_TOKEN);

    const authorized = new StreamaxAdapter({
      baseUrl,
      token: auth.body.data.token,
      requestIdPrefix: "spike-auth",
    });
    const page = await authorized.listVideoSources({ page: 1, pageSize: 1 });
    expect(page.items).toHaveLength(1);
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

    expect(error.code).toBe(3800);
    expect(error.message).toContain("channels");
    expect(error.requestId).toMatch(/^spike-test-/);
  });

  it("设备不存在返回 4040", async () => {
    const error = await captureError(() => adapter.getVideoSource("TEST-NOT-EXIST"));

    expect(error.code).toBe(4040);
    expect(error.requestId).toMatch(/^spike-test-/);
  });
});

describe("规格参数名与请求体", () => {
  it("直播使用 channels 与 streamingProtocol，不再使用 channel/protocol", async () => {
    await stubAdapter.createLiveSession({
      videoSourceId: "TEST00000001",
      channelId: 2,
      protocol: "HLS",
    });

    expect(captured?.pathname).toBe("/openapi/v2/devices/TEST00000001/live-links");
    expect(captured?.query).toMatchObject({ channels: "2", streamingProtocol: "HLS" });
    expect(captured?.query.channel).toBeUndefined();
    expect(captured?.query.protocol).toBeUndefined();
  });

  it("回放使用 channels、streamingProtocol 与字符串 storeType", async () => {
    const playback = await stubAdapter.createPlaybackSession({
      videoSourceId: "TEST00000001",
      channelId: 1,
      startTime: "2026-11-18T08:00:00Z",
      endTime: "2026-11-18T08:05:00Z",
      storeType: "SUB_STORAGE",
      protocol: "FLV",
    });

    expect(captured?.query).toMatchObject({
      channels: "1",
      streamingProtocol: "FLV",
      storeType: "SUB_STORAGE",
      startTime: "2026-11-18T08:00:00Z",
      endTime: "2026-11-18T08:05:00Z",
    });
    expect(captured?.query.channel).toBeUndefined();
    expect(playback.storeType).toBe("SUB_STORAGE");
  });

  it("session-close 请求体只包含 session", async () => {
    const result = await stubAdapter.closeSession({ sessionId: "TEST-SESSION-0001" });

    expect(result.closed).toBe(true);
    expect(captured?.body).toEqual({ session: "TEST-SESSION-0001" });
    expect(Object.keys(captured?.body ?? {})).toEqual(["session"]);
  });

  it("dormantState=DORMANT 才映射为休眠", async () => {
    const source = await stubAdapter.getVideoSource("TEST-DORMANT-0001");

    expect(source.dormant).toBe(true);
    expect(source.online).toBe(true);
  });

  it("非规格枚举 ASLEEP 不映射为休眠", async () => {
    const source = await stubAdapter.getVideoSource("TEST-ASLEEP-0001");

    expect(source.dormant).toBe(false);
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
