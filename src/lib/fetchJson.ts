// Client-side fetch wrapper: checks the HTTP status before parsing the JSON.
// Without this guard, a `fetch().then(r => r.json())` on a 500 returning
// `{ error: "..." }` injects an error object into the components' state, which
// then crash when accessing absent fields (cf. FilterPanel crash).
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      /* non-JSON body: we keep the status */
    }
    throw new HttpError(r.status, msg);
  }
  return (await r.json()) as T;
}

// Every row of a keyset-paged list (`{ assets, next_cursor }`), following the
// cursor to the end. For a set the caller must hold WHOLE — a burst pile to
// export, expand or choose the sharpest of — where one page silently stopped
// at 500 (or 200) frames. Nothing caps a pile's length: interval shooting at
// one frame a second for ten minutes is one pile of 600.
export async function fetchAllPages<T>(url: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const sep = url.includes("?") ? "&" : "?";
    const page: { assets?: T[]; next_cursor?: string | null } = await fetchJson(
      cursor ? `${url}${sep}cursor=${encodeURIComponent(cursor)}` : url,
    );
    all.push(...(page.assets ?? []));
    cursor = page.next_cursor ?? null;
    if (!cursor) return all;
  }
}
