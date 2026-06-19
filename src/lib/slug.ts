// ASCII slug for path segments (device, etc.).
// We strip combining diacritics (U+0300-U+036F) after NFD normalization.
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g");

export function slug(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(COMBINING, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "unknown"
  );
}
