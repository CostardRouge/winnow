// Helpers communs aux route handlers.
import { NextResponse } from "next/server";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export function notFound(message = "Introuvable") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown) {
  console.error("API error:", err);
  const message = err instanceof Error ? err.message : "Erreur interne";
  return NextResponse.json({ error: message }, { status: 500 });
}

// Cursor de pagination : (captured_at, id) encodé en base64url.
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
