// Split a set of paths into what they share and what tells them apart — the
// deduplication page draws every copy of a group as three runs: the shared
// prefix (faint), the folder segment that differs (highlighted), and the file
// name. Three 60-character absolute paths that differ by one folder in the
// middle read as the same line otherwise, and that one folder is the whole
// decision ("keep the dated folder, not the card backup").
//
// Pure and client-safe: no Node imports, so the page bundles it directly.

export type PathParts = {
  /** Folders every path shares, with its trailing slash ("" when none). */
  prefix: string;
  /** The folders after the prefix, with a trailing slash ("" when none). */
  rest: string;
  file: string;
  /** The file names themselves differ ("DSC0001 (1).ARW" beside "DSC0001.ARW"). */
  fileDiffers: boolean;
};

export function splitPaths(paths: string[]): PathParts[] {
  const segs = paths.map((p) => p.split("/"));
  // Only FOLDER segments may join the prefix — never a file name, even when
  // every copy shares it — so `rest` always ends where the folder ends.
  const folders = Math.min(...segs.map((s) => s.length - 1));
  let shared = 0;
  if (segs.length > 1)
    while (shared < folders && segs.every((s) => s[shared] === segs[0][shared]))
      shared++;
  else shared = folders; // a lone path has nothing to differ from
  const files = new Set(segs.map((s) => s[s.length - 1]));
  return segs.map((s) => {
    const dirs = s.slice(shared, -1);
    return {
      prefix: shared ? s.slice(0, shared).join("/") + "/" : "",
      rest: dirs.length ? dirs.join("/") + "/" : "",
      file: s[s.length - 1],
      fileDiffers: files.size > 1,
    };
  });
}
