/**
 * 锐明预研版 HTTP 客户端与错误信封转换。
 *
 * 锐明的响应信封并不统一（见 providers/streamax/README.md 风险 R3），
 * 这里把 {code,message,requestId}、{code,message,sid,success,data}、{error:{...}}
 * 等形态统一归一化为 EnvelopeView，供自测脚本判断成功与失败。
 */

export interface EnvelopeView {
  httpStatus: number;
  requestId: string;
  code?: string | number;
  message: string;
  success?: boolean;
  isError: boolean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/**
 * 归一化响应信封。
 *
 * @param body 已解析的响应体；无法解析时为原始字符串或 undefined
 * @param httpStatus HTTP 状态码
 * @param fallbackRequestId 客户端请求 ID，响应未返回 requestId/sid 时回填
 */
export function inspectEnvelope(body: unknown, httpStatus: number, fallbackRequestId: string): EnvelopeView {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);

  const rawCode = record?.code ?? nestedError?.code;
  const code = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : undefined;

  const rawMessage = record?.message ?? nestedError?.message;
  const message =
    typeof rawMessage === "string" && rawMessage !== "" ? rawMessage : `HTTP ${httpStatus}`;

  const rawRequestId = record?.requestId ?? record?.sid;
  const requestId =
    typeof rawRequestId === "string" && rawRequestId !== "" ? rawRequestId : fallbackRequestId;

  const success = typeof record?.success === "boolean" ? record.success : undefined;
  const codeIndicatesSuccess = code === undefined || code === 200 || code === "200";
  const isError = httpStatus >= 400 || success === false || !codeIndicatesSuccess;

  return { httpStatus, requestId, code, message, success, isError };
}

export interface StreamaxRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  /** 每个用例生成一个请求 ID，便于失败定位。 */
  requestId: string;
  timeoutMs?: number;
}

export interface StreamaxResponse {
  status: number;
  body: unknown;
  requestId: string;
  envelope: EnvelopeView;
}

/** 锐明 mock / 网关的最小 HTTP 客户端。 */
export class StreamaxClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request(path: string, options: StreamaxRequestOptions): Promise<StreamaxResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-request-id": options.requestId,
    };
    if (options.token !== undefined && options.token !== "") {
      headers.token = options.token;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }

    const envelope = inspectEnvelope(parsed, response.status, options.requestId);
    return {
      status: response.status,
      body: parsed,
      requestId: envelope.requestId,
      envelope,
    };
  }
}
