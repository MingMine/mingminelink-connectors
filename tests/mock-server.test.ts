import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_TOKEN } from "../mock/streamax/data";
import { createMockServer } from "../mock/streamax/server";

let server: Server;
let baseUrl: string;

/** 覆盖合成告警（2026-11-18）的时间范围。 */
const ALARM_RANGE = "startTime=2026-11-18T00:00:00Z&endTime=2026-11-19T00:00:00Z";

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

interface TestResponse {
  status: number;
  body: any;
}

async function request(
  path: string,
  options: { token?: string; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = { "x-request-id": "unit-test-request" };
  if (options.token !== undefined) {
    headers.token = options.token;
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe("锐明 mock 鉴权", () => {
  it("公钥端点无需 token", async () => {
    const response = await request("/openapi/auth/public-key");
    expect(response.status).toBe(200);
    expect(response.body.data.publicKey).toContain("PUBLIC KEY");
  });

  it("缺失 token 返回 3806 错误信封", async () => {
    const response = await request("/openapi/v2/devices");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 3806, message: "illegal user", success: false });
    expect(response.body.requestId).toBe("unit-test-request");
  });

  it("错误 token 返回 3806 错误信封", async () => {
    const response = await request("/openapi/v2/devices", { token: "TEST-INVALID-TOKEN" });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe(3806);
    expect(response.body.success).toBe(false);
  });

  it("合成凭证换取固定 token", async () => {
    const response = await request("/openapi/auth", {
      method: "POST",
      body: { appId: "10001", tenantId: "100001", tenantSecret: "TEST-MOCK-SECRET" },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.token).toBe(MOCK_TOKEN);
  });
});

describe("分页参数", () => {
  it("pageSize 限制返回条数并回显分页字段", async () => {
    const response = await request("/openapi/v2/devices?page=1&pageSize=2", { token: MOCK_TOKEN });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(2);
    expect(response.body.total).toBe(3);
  });

  it("第二页返回剩余数据", async () => {
    const response = await request("/openapi/v2/devices?page=2&pageSize=2", { token: MOCK_TOKEN });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.page).toBe(2);
  });

  it("非法 pageSize 返回 3800", async () => {
    const response = await request("/openapi/v2/devices?page=1&pageSize=0", { token: MOCK_TOKEN });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 3800, success: false });
  });

  it("uniqueIds 过滤生效", async () => {
    const response = await request("/openapi/v2/devices?page=1&pageSize=20&uniqueIds=TEST00000001", {
      token: MOCK_TOKEN,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].uniqueId).toBe("TEST00000001");
  });

  it("告警列表支持分页（startTime/endTime 必填）", async () => {
    const response = await request(
      `/openapi/v2/alarms?page=1&pageSize=1&${ALARM_RANGE}`,
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pageSize).toBe(1);
    expect(response.body.total).toBe(3);
  });

  it("告警缺少 startTime/endTime 返回 3800", async () => {
    const response = await request("/openapi/v2/alarms?page=1&pageSize=1", { token: MOCK_TOKEN });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("startTime");
  });

  it("告警按 uniqueIds 过滤", async () => {
    const response = await request(
      `/openapi/v2/alarms?page=1&pageSize=20&${ALARM_RANGE}&uniqueIds=TEST00000001`,
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.data.every((alarm: any) => alarm.uniqueId === "TEST00000001")).toBe(true);
  });
});

/** 从媒体地址的 expires 参数推算剩余秒数。 */
function remainingSeconds(urlValue: string): number {
  const expires = Number(new URL(urlValue).searchParams.get("expires"));
  return expires - Math.floor(Date.now() / 1000);
}

describe("媒体地址与会话", () => {
  it("直播地址 10 秒有效，响应仅含 channel/session/url", async () => {
    const response = await request(
      "/openapi/v2/devices/TEST00000001/live-links?channels=1&streamingProtocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(200);
    const link = response.body.data[0];
    expect(Object.keys(link).sort()).toEqual(["channel", "session", "url"]);
    expect(link.channel).toBe(1);
    expect(link.session).toMatch(/^TEST-LIVE-TEST00000001-CH1-/);
    expect(link.url).toContain("media.example.invalid");
    expect(remainingSeconds(link.url)).toBeGreaterThanOrEqual(8);
    expect(remainingSeconds(link.url)).toBeLessThanOrEqual(11);
  });

  it("回放地址 20 秒有效，响应仅含 channel/session/url", async () => {
    const response = await request(
      "/openapi/v2/devices/TEST00000001/playback-links?channels=1&startTime=2026-11-18T08:00:00Z&endTime=2026-11-18T08:05:00Z&storeType=MAIN_STORAGE&streamingProtocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(200);
    const link = response.body.data[0];
    expect(Object.keys(link).sort()).toEqual(["channel", "session", "url"]);
    expect(link.channel).toBe(1);
    expect(link.session).toMatch(/^TEST-PLAYBACK-TEST00000001-CH1-/);
    expect(remainingSeconds(link.url)).toBeGreaterThanOrEqual(18);
    expect(remainingSeconds(link.url)).toBeLessThanOrEqual(21);
  });

  it("旧参数 channel/protocol 被拒绝", async () => {
    const withoutChannels = await request(
      "/openapi/v2/devices/TEST00000001/live-links?channel=1&protocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(withoutChannels.status).toBe(400);
    expect(withoutChannels.body.code).toBe(3800);
    expect(withoutChannels.body.message).toContain("channels");

    const withoutStreamingProtocol = await request(
      "/openapi/v2/devices/TEST00000001/live-links?channels=1&protocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(withoutStreamingProtocol.status).toBe(400);
    expect(withoutStreamingProtocol.body.code).toBe(3800);
    expect(withoutStreamingProtocol.body.message).toContain("streamingProtocol");
  });

  it("非法 streamingProtocol 返回 3800", async () => {
    const response = await request(
      "/openapi/v2/devices/TEST00000001/live-links?channels=1&streamingProtocol=H264",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("streamingProtocol");
  });

  it("旧 storeType 0/1 被拒绝", async () => {
    for (const storeType of ["0", "1"]) {
      const response = await request(
        `/openapi/v2/devices/TEST00000001/playback-links?channels=1&startTime=2026-11-18T08:00:00Z&endTime=2026-11-18T08:05:00Z&storeType=${storeType}&streamingProtocol=FLV`,
        { token: MOCK_TOKEN },
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(3800);
      expect(response.body.message).toContain("storeType");
    }
  });

  it("回放缺少 storeType 返回 3800", async () => {
    const response = await request(
      "/openapi/v2/devices/TEST00000001/playback-links?channels=1&startTime=2026-11-18T08:00:00Z&endTime=2026-11-18T08:05:00Z&streamingProtocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("storeType");
  });

  it("不存在的 channels 返回 3800", async () => {
    const response = await request(
      "/openapi/v2/devices/TEST00000001/live-links?channels=9&streamingProtocol=FLV",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("channels");
  });

  it("证据链接 24 小时有效（必填 hasAudio/mediaProtocol/streamType）", async () => {
    const response = await request(
      "/openapi/v2/alarms/evidence-link?alarmId=TEST-ALARM-0001&hasAudio=1&mediaProtocol=HTTP_FLV&streamType=MAJOR",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      alarmId: "TEST-ALARM-0001",
      uniqueId: "TEST00000001",
      expiresInSeconds: 86400,
    });
  });

  it("证据链接缺少 hasAudio 返回 3800", async () => {
    const response = await request(
      "/openapi/v2/alarms/evidence-link?alarmId=TEST-ALARM-0001&mediaProtocol=HTTP_FLV&streamType=MAJOR",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("hasAudio");
  });

  it("不存在的告警返回 4042", async () => {
    const response = await request(
      "/openapi/v2/alarms/evidence-link?alarmId=TEST-ALARM-9999&hasAudio=1&mediaProtocol=HTTP_FLV&streamType=MAJOR",
      { token: MOCK_TOKEN },
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe(4042);
  });

  it("会话关闭只需 session", async () => {
    const response = await request("/openapi/v2/devices/session-close", {
      token: MOCK_TOKEN,
      method: "POST",
      body: { session: "TEST-SESSION-0001" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: 200, success: true });
    expect(response.body.data.closed).toBe(true);
  });

  it("会话关闭缺少 session 返回 3800", async () => {
    const response = await request("/openapi/v2/devices/session-close", {
      token: MOCK_TOKEN,
      method: "POST",
      body: { uniqueId: "TEST00000001" },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(3800);
    expect(response.body.message).toContain("session");
  });
});
