// The `original_asset_id` field of POST /api/upload, read without a database.
//
// A client that sends back an edit names the capture it came from (Atelier's
// WinnowClient.upload appends `original_asset_id` to the multipart, one request
// per file). The field follows the shape `paths` already has: either ONE value,
// which applies to every file of the request, or one value per file in the
// order the files were appended. Any other count is a malformed request (400),
// never a guess about which file meant which source.
//
// A value that is not a positive integer is not an error: the upload goes
// through unlinked and the reason is reported, the same way an id naming no
// asset is (lib/importLinks.ts checks that part against the database).

export type LinkFieldInvalid = { value: string; reason: string };

export type LinkField =
  | {
      ok: true;
      // Per file, in the order the files were appended.
      ids: Array<number | null>;
      invalid: Array<LinkFieldInvalid | null>;
    }
  | { ok: false; error: string };

export function parseOriginalIds(
  values: unknown[],
  fileCount: number,
): LinkField {
  const raw = values.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (raw.every((v) => v === "")) {
    return {
      ok: true,
      ids: new Array(fileCount).fill(null),
      invalid: new Array(fileCount).fill(null),
    };
  }
  if (raw.length !== 1 && raw.length !== fileCount) {
    return {
      ok: false,
      error: `original_asset_id: ${raw.length} values for ${fileCount} files (send one, or one per file)`,
    };
  }
  const perFile =
    raw.length === 1 ? new Array<string>(fileCount).fill(raw[0]) : raw;
  const ids: Array<number | null> = [];
  const invalid: Array<LinkFieldInvalid | null> = [];
  for (const value of perFile) {
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (value === "") {
      ids.push(null);
      invalid.push(null);
    } else if (!Number.isSafeInteger(n) || n <= 0) {
      ids.push(null);
      invalid.push({ value, reason: "not an asset id" });
    } else {
      ids.push(n);
      invalid.push(null);
    }
  }
  return { ok: true, ids, invalid };
}
