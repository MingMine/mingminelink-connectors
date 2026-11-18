import { describe, expect, it } from "vitest";
import { inspectEnvelope } from "../conformance/streamax-client";

describe("错误信封转换", () => {
  it("识别锐明 code/message/sid/success 形态", () => {
    const view = inspectEnvelope(
      { code: 3806, message: "illegal user", sid: "sid-0001", success: false },
      401,
      "fallback-request",
    );

    expect(view.isError).toBe(true);
    expect(view.code).toBe(3806);
    expect(view.message).toBe("illegal user");
    expect(view.success).toBe(false);
    expect(view.requestId).toBe("sid-0001");
  });

  it("规格形态 code/message/requestId 且 code=200 视为成功", () => {
    const view = inspectEnvelope({ code: 200, message: "success", requestId: "req-0001" }, 200, "fallback");

    expect(view.isError).toBe(false);
    expect(view.code).toBe(200);
    expect(view.requestId).toBe("req-0001");
  });

  it("成功列表响应（无 code）不视为错误", () => {
    const view = inspectEnvelope({ data: [], page: 1, pageSize: 20, requestId: "req-0002" }, 200, "fallback");

    expect(view.isError).toBe(false);
    expect(view.code).toBeUndefined();
    expect(view.requestId).toBe("req-0002");
  });

  it("嵌套 error 对象可被识别", () => {
    const view = inspectEnvelope({ error: { code: "E1001", message: "boom" } }, 500, "fallback");

    expect(view.isError).toBe(true);
    expect(view.code).toBe("E1001");
    expect(view.message).toBe("boom");
    expect(view.requestId).toBe("fallback");
  });

  it("纯文本错误响应回退到 HTTP 状态描述", () => {
    const view = inspectEnvelope("bad gateway", 502, "req-0003");

    expect(view.isError).toBe(true);
    expect(view.code).toBeUndefined();
    expect(view.message).toBe("HTTP 502");
    expect(view.requestId).toBe("req-0003");
  });

  it("非 200 业务码即使 HTTP 200 也视为失败", () => {
    const view = inspectEnvelope({ code: 207001, message: "no permission" }, 200, "fallback");

    expect(view.isError).toBe(true);
    expect(view.code).toBe(207001);
  });
});
