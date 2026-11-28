// A page-wide notice of the writes the shared action helpers make
// (lib/assetActions.ts), for the copies of a row that live OUTSIDE the host's
// own list — today, the viewer's burst filmstrip (MediaViewer).
//
// Why it exists: the viewer can show any frame of a pile while the grid holds
// only the pile's cover (a collapsed tile). Rating that frame patches nothing
// in the host's list, so without this the viewer would keep drawing the
// frame's old verdict — and before 2026-11-28 the rating did not even reach
// the frame: the keys and buttons acted on the cover, which read as "a
// verdict applies to the whole burst".
//
// The protocol is deliberately two-step, and every helper follows it:
//   1. before the request, `announce(ids, patch)` — the optimistic change, so
//      the frame on screen lights up at once;
//   2. once it settles (success OR failure), `announce(ids)` with no patch —
//      a listener re-reads what the database now holds. That re-read is what
//      undoes a refused write, and what catches a change no per-id patch can
//      describe (a whole-pile verdict, a delete).
// `writesInFlight()` lets a listener hold its re-read until the last of a quick
// run of writes has landed (P then X in a row), so an early answer never paints
// a verdict the next write is about to replace.

export type AssetPatch = (row: AssetChangeRow) => Partial<AssetChangeRow>;
export type AssetChangeRow = {
  id: number;
  verdict?: string | null;
  star?: number | null;
  favourite?: boolean | null;
  tags?: string[] | null;
};
export type AssetChange = { ids: number[]; patch?: AssetPatch };

type Listener = (change: AssetChange) => void;
const listeners = new Set<Listener>();
let inFlight = 0;

export function subscribeAssetChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function writesInFlight(): number {
  return inFlight;
}

function announce(change: AssetChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch {
      // A listener's own bug never breaks the write that announced it.
    }
  }
}

// Wrap one write in the protocol above. The patch is announced before the
// request (when there is one), the settle after it, whatever it answered; the
// write's own result or error is passed through untouched.
export async function trackAssetWrite<T>(
  ids: number[],
  patch: AssetPatch | undefined,
  write: () => Promise<T>,
): Promise<T> {
  if (patch) announce({ ids, patch });
  inFlight++;
  try {
    return await write();
  } finally {
    inFlight--;
    announce({ ids });
  }
}

// Apply a change to a list of rows, returning the same array when nothing in it
// is touched (so a React state setter can skip the render).
export function applyAssetChange<R extends AssetChangeRow>(
  rows: R[],
  change: AssetChange,
): R[] {
  const { patch } = change;
  if (!patch) return rows;
  const ids = new Set(change.ids);
  let touched = false;
  const next = rows.map((r) => {
    if (!ids.has(r.id)) return r;
    touched = true;
    return { ...r, ...patch(r) };
  });
  return touched ? next : rows;
}
