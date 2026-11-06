// The ♥ glyph (migration 0058, docs/FAVOURITES.md): filled when the media is a
// favourite, an outline otherwise. currentColor throughout, so each host
// (.fav-btn on a tile, .btn-fav on the bars, the pass's tiles) decides the hue
// — `--color-fav`, never the vermillion of the brand.
export function HeartIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
    >
      <path d="M12 20.5s-7.5-4.6-9.6-9.2C1 8 3 4.5 6.5 4.5c2 0 3.6 1.2 5.5 3.3 1.9-2.1 3.5-3.3 5.5-3.3C21 4.5 23 8 21.6 11.3 19.5 15.9 12 20.5 12 20.5z" />
    </svg>
  );
}

// The tile's ♥ button: a sibling of the stars in `.cell-marks`. Its click never
// reaches the tile (which would open the viewer or toggle the selection).
export function TileHeart({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`fav-btn${on ? " on" : ""}`}
      aria-pressed={on}
      aria-label={on ? "Remove from favourites" : "Add to favourites"}
      title={on ? "Favourite — click to remove (F in the viewer)" : "Add to favourites (F in the viewer)"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <HeartIcon filled={on} />
    </button>
  );
}
