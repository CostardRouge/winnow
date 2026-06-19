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
