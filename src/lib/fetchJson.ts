// Wrapper fetch côté client : vérifie le statut HTTP avant de parser le JSON.
// Sans ce garde, un `fetch().then(r => r.json())` sur une 500 renvoyant
// `{ error: "…" }` injecte un objet d'erreur dans le state des composants, qui
// plantent ensuite en accédant à des champs absents (cf. crash FilterPanel).
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
      /* corps non-JSON : on garde le statut */
    }
    throw new HttpError(r.status, msg);
  }
  return (await r.json()) as T;
}
