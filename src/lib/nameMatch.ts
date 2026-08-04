// Accent/case-insensitive name matching, shared by every People surface that
// compares or searches names (cf. app/people): the duplicate-name-rename merge
// offer, the shelf search, the merge/move pickers. Names are STORED as typed —
// "Chloé" stays "Chloé" — only the comparisons flatten, so "chloe" finds her
// and renaming a stack "Chloe" still offers the merge with "Chloé".
//
// NFKD splits each accented glyph into base + combining marks; stripping the
// marks (Unicode category M) then leaves the bare letters. Whitespace collapses
// so "Jean  Dupont" and "Jean Dupont" compare equal. Pure and dependency-free:
// usable from client components and server routes alike.
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
