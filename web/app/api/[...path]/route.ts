import { NextRequest, NextResponse } from "next/server";

const API = process.env.API_URL ?? "http://127.0.0.1:8000";

async function proxy(req: NextRequest, path: string[]) {
  const url = new URL(req.url);
  const target = `${API}/${path.join("/")}${url.search}`;
  const headers = new Headers();
  if (req.headers.get("content-type")) {
    headers.set("content-type", req.headers.get("content-type")!);
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, init);
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "api_unreachable", detail: String(err) },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
