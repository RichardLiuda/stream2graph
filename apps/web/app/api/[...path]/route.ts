import { NextRequest, NextResponse } from "next/server";

import { getApiProxyCandidates } from "@/lib/server-api-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  const forwardedHost = request.headers.get("host");
  if (forwardedHost) {
    headers.set("x-forwarded-host", forwardedHost);
  }
  headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-for", request.headers.get("x-forwarded-for") || "127.0.0.1");
  return headers;
}

function buildResponseHeaders(response: Response) {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  return headers;
}

async function proxy(request: NextRequest, path: string[]) {
  const suffix = path.join("/");
  const search = request.nextUrl.search || "";
  const headers = buildForwardHeaders(request);
  const bodyBytes =
    request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer());

  let lastError: unknown = null;
  const candidates = getApiProxyCandidates();

  for (const origin of candidates) {
    const target = `${origin}/api/${suffix}${search}`;
    try {
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: bodyBytes,
        redirect: "manual",
        cache: "no-store",
      });
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: buildResponseHeaders(response),
      });
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "unknown proxy error";
  return NextResponse.json(
    {
      detail: `All API proxy targets failed. Tried: ${candidates.join(", ")}. Last error: ${detail}`,
    },
    { status: 502 },
  );
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}
