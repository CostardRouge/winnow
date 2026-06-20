// Helpers common to the route handlers.
import { NextResponse } from "next/server";
import { createLogger } from "./log";

const log = createLogger("api");

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown) {
  log.error("API error", { err });
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}

// Pagination cursor: (captured_at, id) encoded in base64url.
export function encodeCursor(capturedAt: string, id: number): string {
  return Buffer.from(`${capturedAt}|${id}`).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): { capturedAt: string; id: number } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep < 0) return null;
    const capturedAt = raw.slice(0, sep);
    const id = Number.parseInt(raw.slice(sep + 1), 10);
    if (!capturedAt || !Number.isFinite(id)) return null;
    return { capturedAt, id };
  } catch {
    return null;
  }
}
