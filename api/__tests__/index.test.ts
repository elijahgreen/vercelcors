import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { AxiosResponse } from "axios";

vi.mock("axios", () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

import axios from "axios";
import indexModule from "../index";

const {
  isEndpointAllowed,
  isPathAllowed,
  handleRequest,
  handleError,
  handler,
  allowCors,
} = indexModule as any;

function mockReq(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "GET",
    query: { url: "https://example.com/data" },
    headers: {},
    ...overrides,
  } as unknown as VercelRequest;
}

function mockRes() {
  const res: any = {
    setHeader: vi.fn(),
    status: vi.fn(),
    end: vi.fn(),
    send: vi.fn(),
    statusCode: 200,
    write: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as VercelResponse & Record<string, ReturnType<typeof vi.fn>>;
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.ENDPOINT_ALLOWLIST;
  delete process.env.PATH_ALLOWLIST;
  delete process.env.CONTENT_TYPE_ALLOWLIST;
  vi.clearAllMocks();
  vi.mocked(axios.request).mockResolvedValue({
    headers: { "content-type": "application/json" },
    data: { pipe: vi.fn() },
  });
});

afterEach(() => {
  process.env = originalEnv;
});

// --- isEndpointAllowed ---

describe("isEndpointAllowed", () => {
  it("returns true for matching host", () => {
    expect(isEndpointAllowed(["example.com"], new URL("https://example.com/path"))).toBe(true);
  });

  it("returns false for non-matching host", () => {
    expect(isEndpointAllowed(["other.com"], new URL("https://example.com/path"))).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(isEndpointAllowed([], new URL("https://example.com"))).toBe(false);
  });

  it("checks host not origin (no protocol)", () => {
    expect(isEndpointAllowed(["example.com"], new URL("https://example.com"))).toBe(true);
    expect(isEndpointAllowed(["https://example.com"], new URL("https://example.com"))).toBe(false);
  });

  it("matches host with port", () => {
    expect(isEndpointAllowed(["example.com:8080"], new URL("https://example.com:8080/path"))).toBe(true);
  });
});

// --- isPathAllowed ---

describe("isPathAllowed", () => {
  it("matches exact path via regex", () => {
    expect(isPathAllowed(["/api/data"], "/api/data")).toBe(true);
  });

  it("matches wildcard regex pattern", () => {
    expect(isPathAllowed(["^/api/.*"], "/api/data/123")).toBe(true);
  });

  it("returns false for non-matching path", () => {
    expect(isPathAllowed(["^/api/.*"], "/other/path")).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(isPathAllowed([], "/anything")).toBe(false);
  });

  it("returns true when one of multiple patterns matches", () => {
    expect(isPathAllowed(["^/x/", "^/api/"], "/api/v1")).toBe(true);
  });
});

// --- allowCors ---

describe("allowCors", () => {
  it("sets all CORS headers", async () => {
    const inner = vi.fn();
    const wrapped = allowCors(inner);
    const req = mockReq();
    const res = mockRes();

    await wrapped(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Headers",
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );
  });

  it("returns 200 for OPTIONS and does not call inner handler", async () => {
    const inner = vi.fn();
    const wrapped = allowCors(inner);
    const req = mockReq({ method: "OPTIONS" } as any);
    const res = mockRes();

    await wrapped(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it("calls inner handler for non-OPTIONS requests", async () => {
    const inner = vi.fn();
    const wrapped = allowCors(inner);
    const req = mockReq();
    const res = mockRes();

    await wrapped(req, res);

    expect(inner).toHaveBeenCalledWith(req, res);
  });
});

// --- handleRequest ---

describe("handleRequest", () => {
  function mockAxiosResponse(
    contentType: string | undefined,
  ): AxiosResponse {
    return {
      headers: contentType ? { "content-type": contentType } : {},
      data: { pipe: vi.fn() },
    } as unknown as AxiosResponse;
  }

  it("pipes response when no content-type allowlist is set", () => {
    const response = mockAxiosResponse("application/json");
    const res = mockRes();

    handleRequest(response, res);

    expect((response.data as any).pipe).toHaveBeenCalledWith(res);
  });

  it("pipes response when content-type matches allowlist", () => {
    process.env.CONTENT_TYPE_ALLOWLIST = '["application/json"]';
    const response = mockAxiosResponse("application/json; charset=utf-8");
    const res = mockRes();

    handleRequest(response, res);

    expect((response.data as any).pipe).toHaveBeenCalledWith(res);
  });

  it("returns 403 when content-type is not in allowlist", () => {
    process.env.CONTENT_TYPE_ALLOWLIST = '["application/json"]';
    const response = mockAxiosResponse("text/html");
    const res = mockRes();

    handleRequest(response, res);

    expect(res.statusCode).toBe(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden Content Type: text/html");
    expect((response.data as any).pipe).not.toHaveBeenCalled();
  });

  it("pipes response when content-type header is missing", () => {
    process.env.CONTENT_TYPE_ALLOWLIST = '["application/json"]';
    const response = mockAxiosResponse(undefined);
    const res = mockRes();

    handleRequest(response, res);

    expect((response.data as any).pipe).toHaveBeenCalledWith(res);
  });
});

// --- handleError ---

describe("handleError", () => {
  it("sets status code from error response", () => {
    const res = mockRes();
    const error = { response: { status: 502 } };

    handleError(error, res);

    expect(res.statusCode).toBe(502);
  });

  it("sends the error object", () => {
    const res = mockRes();
    const error = { response: { status: 500 } };

    handleError(error, res);

    expect(res.send).toHaveBeenCalledWith(error);
  });
});

// --- handler (integration) ---

describe("handler", () => {
  it("proxies request when no allowlists are set", () => {
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(axios.request).toHaveBeenCalledWith({
      url: "https://example.com/data",
      method: "GET",
      responseType: "stream",
    });
  });

  it("uses first element when url query param is an array", () => {
    const req = mockReq({ query: { url: ["https://a.com", "https://b.com"] } } as any);
    const res = mockRes();

    handler(req, res);

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://a.com" })
    );
  });

  it("blocks forbidden endpoint with 403", () => {
    process.env.ENDPOINT_ALLOWLIST = '["allowed.com"]';
    const req = mockReq({ query: { url: "https://forbidden.com/path" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden endpoint: forbidden.com");
    expect(axios.request).not.toHaveBeenCalled();
  });

  it("allows matching endpoint", () => {
    process.env.ENDPOINT_ALLOWLIST = '["allowed.com"]';
    const req = mockReq({ query: { url: "https://allowed.com/path" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(axios.request).toHaveBeenCalled();
  });

  it("blocks forbidden path with 403", () => {
    process.env.PATH_ALLOWLIST = '["^/api/"]';
    const req = mockReq({ query: { url: "https://any.com/other" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden path: /other");
    expect(axios.request).not.toHaveBeenCalled();
  });

  it("allows matching path", () => {
    process.env.PATH_ALLOWLIST = '["^/api/"]';
    const req = mockReq({ query: { url: "https://any.com/api/data" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(axios.request).toHaveBeenCalled();
  });

  it("allows when endpoint blocked but path matches (AND logic)", () => {
    process.env.ENDPOINT_ALLOWLIST = '["other.com"]';
    process.env.PATH_ALLOWLIST = '["^/api/"]';
    const req = mockReq({ query: { url: "https://blocked.com/api/data" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(axios.request).toHaveBeenCalled();
  });

  it("returns 403 when both endpoint and path are blocked", () => {
    process.env.ENDPOINT_ALLOWLIST = '["other.com"]';
    process.env.PATH_ALLOWLIST = '["^/x/"]';
    const req = mockReq({ query: { url: "https://blocked.com/api/data" } } as any);
    const res = mockRes();

    handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it("forwards axios errors via handleError", async () => {
    const axiosError = { response: { status: 500 } };
    vi.mocked(axios.request).mockRejectedValueOnce(axiosError);

    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    // Wait for the promise rejection to be handled
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(500);
    });

    expect(res.send).toHaveBeenCalledWith(axiosError);
  });
});
