// Which media the viewer's actions act on (MediaViewer's `frameActions`).
//
// The viewer can show any frame of a burst pile through its filmstrip while
// the host's list holds only the pile's cover. Until 2026-11-28 the host's
// keys, buttons and menu always got the cover: a P pressed on frame 4 picked
// frame 1, and every frame of the strip then showed the cover's verdict — it
// read as "a verdict applies to the whole burst". With `frameActions` on, the
// frame on screen is the subject; off, the host's own item, as before.
//
// The frame row is laid over the item's: every field the pile read carries
// (id, verdict, stars, ♥, tags, file facts) is the frame's own, and a field it
// does not carry keeps the item's value rather than turning undefined.
export function viewerSubject<T extends { id: number }, F extends { id: number }>(
  item: T,
  frame: F | null,
  frameActions: boolean,
): T {
  return frameActions && frame ? ({ ...item, ...frame } as T) : item;
}
