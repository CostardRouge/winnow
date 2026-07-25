"use client";

// The lens portraits on /gear. Same spirit as CameraArt, except nothing is
// classified: the barrel is drawn straight from the optics that lib/gearArt.ts
// derives from the name and the recorded EXIF — length from the focal, girth from
// the entrance pupil (focal ÷ aperture). So a fast 56mm draws short and fat, an
// f/2.8 pancake draws flat, a 70-300 draws long and stepped like a telescope, and
// the engraved aperture scale starts at the lens' real widest stop.
//
// Standing upright, mount at the bottom, as in a maker's line drawing.
import { useId } from "react";
import { lensArt, type LensArt as Spec } from "@/lib/gearArt";

const VB = { w: 140, h: 200 };
const CX = 70;
const BASE = 192; // bottom of the mount flange

const STROKE = 1.4;
const THIN = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Millimetres → viewBox units, on a COMPRESSED scale (a power curve rather than
// a straight ratio). Every lens shares the mapping, so the ordering is truthful —
// a telephoto towers over a pancake — but the ratio is softened: drawn strictly
// to scale, a 23mm pancake next to a 190mm zoom is a postage stamp nobody can
// read. Cameras don't need this (their range is narrow) and stay linear.
function curve(v: number, min: number, max: number, lo: number, hi: number, p: number) {
  return lo + (hi - lo) * Math.pow(clamp((v - min) / (max - min), 0, 1), p);
}
const lengthUnits = (mm: number) => curve(mm, 26, 190, 66, 168, 0.55);
const diameterUnits = (mm: number) => curve(mm, 52, 104, 44, 96, 0.7);

/** Half/full stops, widest first — the scale engraved on an aperture ring. */
const STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];

/**
 * The stops engraved on the ring, thinned to what the barrel can hold: a slim
 * pancake gets four marks, a fat fast prime the whole scale. The widest stop and
 * f/16 are the two that always survive — they're the ends of the ring.
 */
function stopScale(widest: number | null, room: number): string[] {
  const from = widest ?? 2;
  // The lens' own widest stop opens the scale (0.95, 1.2, 1.8 … are not on the
  // canonical list), then the standard stops up to f/16.
  const all = [String(from), ...STOPS.filter((s) => s > from).map(String)];
  const max = clamp(Math.floor(room / 9), 3, all.length);
  if (all.length <= max) return all;
  // Even sample of the middle, ends pinned.
  const step = (all.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => all[Math.round(i * step)]);
}

/** Knurled collar: the band of fine ribs on a focus or zoom ring. */
function Knurl({
  x,
  y,
  w,
  h,
  gap = 2.4,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  gap?: number;
}) {
  const n = Math.max(3, Math.round(w / gap));
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="var(--color-surface)" strokeWidth={THIN} />
      {Array.from({ length: n - 1 }).map((_, i) => {
        const lx = x + ((i + 1) * w) / n;
        return (
          <line key={i} x1={lx} y1={y + 0.9} x2={lx} y2={y + h - 0.9} strokeWidth={0.7} opacity={0.75} />
        );
      })}
    </g>
  );
}

/** The engraved aperture scale: the stops, plus an "A" where the ring has one. */
function ApertureScale({ x, y, w, spec }: { x: number; y: number; w: number; spec: Spec }) {
  // The "A" position takes a slot of its own, so it comes off the budget.
  const marks = stopScale(spec.aperture, spec.autoStop ? w - 9 : w);
  const labels = spec.autoStop ? ["A", ...marks] : marks;
  return (
    <g fill="currentColor" stroke="none" opacity={0.8}>
      {labels.map((label, i) => (
        <text
          key={label + i}
          x={x + (w * (i + 0.5)) / labels.length}
          y={y}
          fontSize={5}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
        >
          {label}
        </text>
      ))}
    </g>
  );
}

/**
 * Draw a lens from its EXIF name + the focal/aperture range its files recorded.
 * Decorative: the name and the spec line live in the card's text.
 */
export default function LensArt({
  name,
  focalMin,
  focalMax,
  aperture,
  className,
}: {
  name: string;
  focalMin?: number | null;
  focalMax?: number | null;
  aperture?: number | null;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const spec = lensArt(name, { focalMin, focalMax, aperture });

  const d = diameterUnits(spec.mm.diameter);
  const len = lengthUnits(spec.mm.length);
  const x = CX - d / 2;
  const flangeH = 6;
  const bottom = BASE - flangeH - 3; // where the barrel meets the mount
  const top = bottom - len;

  // Long glass steps down toward the front element; short glass is one tube.
  const stepped = len > 118;
  const dFront = stepped ? d * 0.86 : d;
  const stepY = stepped ? top + len * 0.42 : top;

  // Collars, front to mount: front ring · focus · [zoom] · [aperture ring].
  // Heights and gaps scale with the barrel so a pancake isn't all rings and a
  // telephoto isn't a bare tube.
  const frontH = clamp(len * 0.09, 4.5, 9);
  const apertureH = spec.apertureRing ? clamp(len * 0.16, 7, 12) : 0;
  const free = len - frontH - apertureH;
  const focusH = clamp(free * (spec.zoom ? 0.3 : 0.44), 7, 42);
  const zoomH = spec.zoom ? clamp(free * 0.3, 7, 40) : 0;

  const focusY = top + frontH + free * 0.1;
  const apertureY = bottom - apertureH;
  // The zoom collar rides low, just above the mount end of the barrel.
  const zoomY = apertureY - free * 0.1 - zoomH;
  // Engraving goes in the gap the collars leave in the middle of the barrel.
  const labelY = spec.zoom
    ? (focusY + focusH + zoomY) / 2 + 2
    : focusY + focusH + Math.min(9, (apertureY - focusY - focusH) * 0.7);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${VB.w} ${VB.h}`}
      role="img"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <defs>
        {/* Collars are clipped to the barrel so a ring can never overhang it. */}
        <clipPath id={`lens-clip-${uid}`}>
          <rect x={x} y={stepY} width={d} height={bottom - stepY} />
          <rect x={CX - dFront / 2} y={top} width={dFront} height={stepY - top + 1} />
        </clipPath>
      </defs>

      {/* Barrel — one tube, or a rear section plus a narrower front one */}
      <rect
        x={x}
        y={stepY}
        width={d}
        height={bottom - stepY}
        rx={2.5}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      {stepped && (
        <rect
          x={CX - dFront / 2}
          y={top}
          width={dFront}
          height={stepY - top + 3}
          rx={2.5}
          fill="var(--color-surface)"
          strokeWidth={STROKE}
        />
      )}
      {/* Front element ring, standing slightly proud of the barrel */}
      <rect
        x={CX - dFront / 2 - 1.8}
        y={top}
        width={dFront + 3.6}
        height={frontH}
        rx={2}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />

      <g clipPath={`url(#lens-clip-${uid})`}>
        <Knurl x={x - 1} y={focusY} w={d + 2} h={focusH} />
        {spec.zoom && <Knurl x={x - 1} y={zoomY} w={d + 2} h={zoomH} gap={3.4} />}
      </g>

      {/* Aperture ring: a smooth collar carrying the engraved scale */}
      {apertureH > 0 && (
        <>
          <rect
            x={x}
            y={apertureY}
            width={d}
            height={apertureH}
            fill="var(--color-surface)"
            strokeWidth={THIN}
          />
          <ApertureScale x={x} y={apertureY + apertureH * 0.68} w={d} spec={spec} />
        </>
      )}

      {/* Focal length engraved on the barrel, in the gap between the collars */}
      {spec.label && (
        <text
          x={CX}
          y={labelY}
          fontSize={7}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fill="currentColor"
          stroke="none"
          opacity={0.9}
        >
          {spec.label}
          <tspan fontSize={4.6}>mm</tspan>
        </text>
      )}

      {/* Mount: flange plus the bayonet plate that catches the body */}
      <rect
        x={CX - d * 0.42}
        y={bottom}
        width={d * 0.84}
        height={3}
        fill="var(--color-surface)"
        strokeWidth={THIN}
      />
      <rect
        x={CX - d * 0.34}
        y={bottom + 3}
        width={d * 0.68}
        height={flangeH}
        rx={1}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <line
        x1={CX - d * 0.34}
        y1={bottom + 3 + flangeH * 0.55}
        x2={CX + d * 0.34}
        y2={bottom + 3 + flangeH * 0.55}
        strokeWidth={0.7}
        opacity={0.55}
      />
      {/* Contact block — the electronic lenses' tell */}
      <rect
        x={CX + d * 0.08}
        y={bottom + 3}
        width={d * 0.17}
        height={flangeH}
        fill="var(--color-surface-2)"
        strokeWidth={0.7}
      />
    </svg>
  );
}
