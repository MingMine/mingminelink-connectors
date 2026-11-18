import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runConformance } from "../conformance/run";
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
      expect(report.summary.total).toBeGreaterThanOrEqual(10);
      expect(report.checks.every((check) => check.status === "passed")).toBe(true);
      expect(report.checks.map((check) => check.id)).toContain("auth.bad-token");
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
