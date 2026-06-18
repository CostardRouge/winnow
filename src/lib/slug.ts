// Slug ASCII pour les segments de chemin (device, etc.).
// On retire les diacritiques combinants (U+0300–U+036F) après normalisation NFD.
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
