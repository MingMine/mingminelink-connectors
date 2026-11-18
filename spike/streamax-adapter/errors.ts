/**
 * Connectors 统一错误信封（草案，待 RFC）。
 *
 * 锐明错误形态并不统一（R3）：
 * - 规格形态：{ code, message, requestId }
 * - 运行形态：{ code, message, sid, success, data }
 * - 嵌套形态：{ error: { code, message } }
 *
 * 适配层统一收敛为 { code, message, requestId }，业务码原样保留，
 * 便于上层按 3806 / 207001 等锐明码做分支处理。
 */

import { inspectEnvelope } from "../../conformance/streamax-client";
import type { ConnectorsErrorPayload } from "./types";

/** 适配层自身产生的错误码，与锐明业务码区分。 */
export const CONNECTORS_ERROR_CODE = {
  /** track、analysis 等锐明不支持的能力。 */
  unsupportedCapability: "UNSUPPORTED_CAPABILITY",
  /** 网络失败、超时或连接被拒绝。 */
  network: "NETWORK_ERROR",
  /** 响应结构不符合预期，无法完成映射。 */
  invalidResponse: "INVALID_RESPONSE",
} as const;

/** 统一错误信封异常，调用方可通过 toJSON() 直接返回给上层。 */
export class ConnectorsError extends Error implements ConnectorsErrorPayload {
  readonly code: string | number;
  readonly requestId: string;
  /** 上游 HTTP 状态码；适配层本地错误时为 undefined。 */
  readonly httpStatus?: number;

  constructor(payload: ConnectorsErrorPayload, httpStatus?: number) {
    super(payload.message);
    this.name = "ConnectorsError";
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.httpStatus = httpStatus;
  }

  toJSON(): ConnectorsErrorPayload {
    return { code: this.code, message: this.message, requestId: this.requestId };
  }
}

/**
 * 把锐明响应归一化为统一错误信封。
 *
 * 复用 conformance 的 inspectEnvelope，避免重复实现多套信封判断。
 * 3806（非法用户）、207001（无权限）等业务码即使 HTTP 200 也会被识别为错误。
 */
export function normalizeConnectorsError(
  body: unknown,
  httpStatus: number,
  fallbackRequestId: string,
): ConnectorsError {
  const view = inspectEnvelope(body, httpStatus, fallbackRequestId);
  return new ConnectorsError(
    {
      code: view.code ?? `HTTP_${httpStatus}`,
      message: view.message,
      requestId: view.requestId,
    },
    httpStatus,
  );
}

/** 构造“能力不支持”错误；锐明 track / analysis 走此路径。 */
export function unsupportedCapability(capability: string, requestId: string): ConnectorsError {
  return new ConnectorsError({
    code: CONNECTORS_ERROR_CODE.unsupportedCapability,
    message: `锐明 2.7.3-P3 不支持 ${capability} 能力`,
    requestId,
  });
}

/** 构造响应结构错误。 */
export function invalidResponse(message: string, requestId: string): ConnectorsError {
  return new ConnectorsError({
    code: CONNECTORS_ERROR_CODE.invalidResponse,
    message,
    requestId,
  });
}
