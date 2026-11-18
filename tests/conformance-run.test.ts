import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveAuth, resolveTimeWindow, runConformance } from "../conformance/run";
import { StreamaxClient } from "../conformance/streamax-client";
import { MOCK_TOKEN } from "../mock/streamax/data";
import { createMockServer } from "../mock/streamax/server";

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createMockServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("预研版一致性自测端到端", () => {
  it("对 mock 服务全部用例通过", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const report = await runConformance({ provider: "streamax", baseUrl });

      expect(report.summary.failed).toBe(0);
      expect(report.summary.total).toBe(11);
      expect(report.checks.every((check) => check.status === "passed")).toBe(true);
      expect(report.checks.map((check) => check.id)).toContain("auth.bad-token");

      // 新参数链路：直播/回放响应只有 url，有效期从地址推导。
      const live = report.checks.find((check) => check.id === "live.links");
      const playback = report.checks.find((check) => check.id === "playback.links");
      expect(live?.detail).toContain("有效期约 10 秒");
      expect(playback?.detail).toContain("有效期约 20 秒");
    } finally {
      await stopServer(server);
    }
  });

  it("mock 断开后失败项包含请求 ID 与原因", async () => {
    const { server, baseUrl } = await startServer();
    await stopServer(server);

    const report = await runConformance({ provider: "streamax", baseUrl });
    const failed = report.checks.filter((check) => check.status === "failed");

    expect(report.summary.failed).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    for (const check of failed) {
      expect(check.requestId).not.toBe("");
      expect(check.error).toBeTruthy();
    }
  });
});

describe("鉴权解析与时间窗", () => {
  it("非回环地址缺少鉴权参数时报错", () => {
    expect(() => resolveAuth("https://provider.example.com")).toThrow(/缺少鉴权参数/);
  });

  it("回环地址回退 mock token", () => {
    expect(resolveAuth("http://127.0.0.1:18080")).toEqual({ mode: "mock", token: MOCK_TOKEN });
    expect(resolveAuth("http://localhost:18080")).toEqual({ mode: "mock", token: MOCK_TOKEN });
  });

  it("优先使用 token", () => {
    expect(resolveAuth("https://provider.example.com", { token: "TEST-EXTERNAL-TOKEN" })).toEqual({
      mode: "token",
      token: "TEST-EXTERNAL-TOKEN",
    });
  });

  it("sign + tenant-id 使用 Sign 模式", () => {
    expect(
      resolveAuth("https://provider.example.com", { sign: "TEST-SIGN", tenantId: "100001" }),
    ).toEqual({ mode: "sign", sign: "TEST-SIGN", tenantId: "100001" });
  });

  it("只给 sign 或只给 tenant-id 时报错", () => {
    expect(() => resolveAuth("https://provider.example.com", { sign: "TEST-SIGN" })).toThrow(/--tenant-id/);
    expect(() => resolveAuth("https://provider.example.com", { tenantId: "100001" })).toThrow(/--sign/);
  });

  it("时间窗默认为最近 24 小时", () => {
    const window = resolveTimeWindow();
    expect(Date.parse(window.end) - Date.parse(window.start)).toBe(24 * 60 * 60 * 1000);
  });

  it("显式时间窗可覆盖默认值", () => {
    const window = resolveTimeWindow("2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z");
    expect(window.start).toBe("2026-11-18T00:00:00.000Z");
    expect(window.end).toBe("2026-11-19T00:00:00.000Z");
  });

  it("Sign 模式发送 _sign 与 _tenantid 请求头", async () => {
    let received: { sign?: string | string[]; tenantId?: string | string[]; token?: string | string[] } = {};
    const server = createServer((req, res) => {
      received = {
        sign: req.headers["_sign"],
        tenantId: req.headers["_tenantid"],
        token: req.headers.token,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, requestId: "stub-request" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    try {
      const client = new StreamaxClient(`http://127.0.0.1:${address.port}`, {
        sign: "TEST-SIGN",
        tenantId: "100001",
      });
      const response = await client.request("/openapi/v2/devices", { requestId: "stub-request" });
      expect(response.status).toBe(200);
      expect(received.sign).toBe("TEST-SIGN");
      expect(received.tenantId).toBe("100001");
      expect(received.token).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
