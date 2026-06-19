/** Small shared presentational helpers: skeleton loaders + composed empty states. */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * `<img>` that only fetches once it scrolls into view. An IntersectionObserver
 * watches the element and swaps in the real `src` on sight (with a small
 * rootMargin so the image is ready just before it's revealed). Falls back to an
 * eager load where IntersectionObserver is unavailable. Fades in on decode.
 */
export function LazyImage({
  src,
  alt = "",
  className,
  style,
  rootMargin = "300px",
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible, rootMargin]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={visible ? src : undefined}
      alt={alt}
      className={["lazy-img", loaded && "is-loaded", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
      onLoad={() => setLoaded(true)}
    />
  );
}

/** Card-shaped skeleton rows — used while session/export lists load. */
export function SkeletonCards({ rows = 4 }: { rows?: number }) {
  return (
    <div className="session-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="session-card"
          style={{ pointerEvents: "none" }}
        >
          <div style={{ flex: 1, minWidth: 200, display: "grid", gap: 10 }}>
            <div className="skeleton" style={{ height: 16, width: "45%" }} />
            <div className="skeleton" style={{ height: 12, width: "70%" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <div className="skeleton" style={{ height: 22, width: 64, borderRadius: 999 }} />
              <div className="skeleton" style={{ height: 22, width: 80, borderRadius: 999 }} />
              <div className="skeleton" style={{ height: 22, width: 56, borderRadius: 999 }} />
            </div>
          </div>
          <div className="skeleton" style={{ height: 34, width: 90 }} />
        </div>
      ))}
    </div>
  );
}

/** Composed empty state: glyph + headline + supporting line (+ optional action). */
export function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="empty"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
      }}
    >
      {icon && (
        <div
          aria-hidden
          style={{ color: "var(--color-faint)", lineHeight: 0 }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)" }}>
        {title}
      </div>
      {hint && <div style={{ maxWidth: 360, fontSize: 13 }}>{hint}</div>}
      {children && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

/** A few line-icons (Phosphor-style, 1.5 stroke) so empty states aren't bare text. */
export const Icons = {
  inbox: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13h4l2 3h6l2-3h4" />
      <path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2-8Z" />
    </svg>
  ),
  export: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
    </svg>
  ),
  photos: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </svg>
  ),
  viewList: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  viewCard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
};
