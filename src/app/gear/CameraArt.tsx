"use client";

// The camera portraits on /gear: an SVG drawn from the archetype + footprint
// that lib/gearArt.ts derives from the EXIF name. Line-art on paper — ink
// outlines, hatched front plate, no fills that would fight the photos elsewhere
// in the app — and every body drawn on ONE mm→unit scale in a shared viewBox, so
// the cards are honest about relative size (a 5D really is twice a GR).
//
// Nothing here is model-specific: change the spec and the drawing follows.
import { useId } from "react";
import { cameraArt, type CameraArt as Spec } from "@/lib/gearArt";

// Shared drawing space. Every body sits on BASE and is centred on CX, so bodies
// of different sizes line up on a common shelf across the grid.
const VB = { w: 240, h: 176 };
const CX = 120;
const BASE = 164;
/** Millimetres → viewBox units. 152mm (a pro reflex) ≈ 190 units wide. */
const U = 1.25;

const STROKE = 1.4;
const THIN = 1;

/** 45° hatch used on the front plates — the shading of the reference line-art. */
function HatchDef({ id }: { id: string }) {
  return (
    <pattern
      id={id}
      width={5}
      height={5}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={5}
        stroke="currentColor"
        strokeWidth={0.8}
        opacity={0.45}
      />
    </pattern>
  );
}

/** Concentric lens/mount rings — the front of any interchangeable-lens body. */
function Mount({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface)" strokeWidth={STROKE} />
      <circle cx={cx} cy={cy} r={r * 0.82} strokeWidth={THIN} />
      <circle cx={cx} cy={cy} r={r * 0.6} strokeWidth={THIN} />
      <circle cx={cx} cy={cy} r={r * 0.36} strokeWidth={THIN} opacity={0.7} />
    </g>
  );
}

/** Top-plate control dial: a milled disc seen from the front. */
function Dial({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const ticks = 9;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface)" strokeWidth={THIN} />
      {Array.from({ length: ticks }).map((_, i) => {
        const x = cx - r + ((i + 1) * 2 * r) / (ticks + 1);
        return (
          <line
            key={i}
            x1={x}
            y1={cy - r * 0.75}
            x2={x}
            y2={cy + r * 0.75}
            strokeWidth={0.7}
            opacity={0.55}
          />
        );
      })}
    </g>
  );
}

/**
 * A body with a top plate and a front: reflex, mirrorless, rangefinder and
 * compact are all this drawing with different proportions and details.
 */
function StandardBody({ spec, hatch, clip }: { spec: Spec; hatch: string; clip: string }) {
  const w = spec.mm.w * U;
  const h = spec.mm.h * U;
  const x = CX - w / 2;
  const top = BASE - h;
  const r = Math.min(6, h * 0.12); // corner radius of the body shell

  // Vertical split: [hump] [top plate] [front]. The prism eats a fifth of the
  // height; the flat-top bodies give that room back to the front plate.
  const humpH = spec.hump === "prism" ? h * 0.2 : spec.hump === "low" ? h * 0.1 : 0;
  const shellTop = top + humpH;
  const shellH = h - humpH;
  const plateH = shellH * (spec.body === "compact" ? 0.3 : 0.26);
  const plateY = shellTop + plateH;

  // Grip: a rounded bulge on the (viewer's) left, pronounced on a reflex.
  const gripW = spec.grip === "deep" ? w * 0.2 : spec.grip === "slight" ? w * 0.12 : 0;

  const lensR = spec.lensR * h;
  const lensCx = x + spec.lensX * w;
  const lensCy = plateY + (BASE - plateY) * 0.5;

  const humpW = w * 0.3;
  const humpTopW = humpW * 0.6;

  return (
    <>
      <defs>
        <HatchDef id={hatch} />
        {/* The hatch is painted as one rect and clipped to the silhouette, so it
            can never spill past the outline whatever the proportions are. */}
        <clipPath id={clip}>
          <rect x={x} y={shellTop} width={w} height={shellH} rx={r} />
          {gripW > 0 && (
            <rect x={x} y={shellTop} width={gripW + r} height={shellH} rx={r} />
          )}
        </clipPath>
      </defs>

      {/* Prism / EVF hump */}
      {spec.hump === "prism" && (
        <path
          d={`M ${CX - humpW / 2} ${shellTop + 2}
              L ${CX - humpTopW / 2} ${top + 3}
              Q ${CX - humpTopW / 2} ${top} ${CX - humpTopW / 2 + 3} ${top}
              L ${CX + humpTopW / 2 - 3} ${top}
              Q ${CX + humpTopW / 2} ${top} ${CX + humpTopW / 2} ${top + 3}
              L ${CX + humpW / 2} ${shellTop + 2} Z`}
          fill="var(--color-surface)"
          strokeWidth={STROKE}
        />
      )}
      {spec.hump === "low" && (
        <rect
          x={CX - humpW / 2}
          y={top}
          width={humpW}
          height={humpH + 2}
          rx={2.5}
          fill="var(--color-surface)"
          strokeWidth={STROKE}
        />
      )}
      {/* Hot shoe, on top of the hump or on the plate of a flat-top body */}
      <rect
        x={CX - 9}
        y={(humpH > 0 ? top : shellTop) - 3.5}
        width={18}
        height={4}
        rx={1}
        fill="var(--color-surface)"
        strokeWidth={THIN}
      />

      {/* Shell: top plate + front, one outline */}
      <rect
        x={x}
        y={shellTop}
        width={w}
        height={shellH}
        rx={r}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      {gripW > 0 && (
        <rect
          x={x}
          y={shellTop + plateH * 0.7}
          width={gripW}
          height={shellH - plateH * 0.7}
          rx={Math.min(gripW * 0.5, 9)}
          fill="var(--color-surface)"
          strokeWidth={STROKE}
        />
      )}

      {/* Hatched front plate (the top plate stays light, as on the real thing) */}
      <g clipPath={`url(#${clip})`}>
        <rect
          x={x - 2}
          y={plateY}
          width={w + 4}
          height={BASE - plateY}
          fill={`url(#${hatch})`}
          stroke="none"
        />
      </g>
      <line x1={x} y1={plateY} x2={x + w} y2={plateY} strokeWidth={THIN} opacity={0.8} />

      {/* Top-plate furniture: shutter release, dials, and the corner finder
          window that stands in for the missing prism on a flat-top body. */}
      <circle
        cx={x + w * 0.9}
        cy={shellTop + plateH * 0.45}
        r={2.6}
        fill="var(--color-surface-2)"
        strokeWidth={THIN}
      />
      {Array.from({ length: spec.dials }).map((_, i) => (
        <Dial
          key={i}
          cx={x + w * (0.72 - i * 0.13)}
          cy={shellTop + plateH * 0.45}
          r={Math.min(plateH * 0.34, 5)}
        />
      ))}
      {spec.finder === "window" && (
        <rect
          x={x + w * 0.06}
          y={shellTop + plateH * 1.25}
          width={w * 0.13}
          height={Math.max(plateH * 0.5, 5)}
          rx={1.5}
          fill="var(--color-surface)"
          strokeWidth={THIN}
        />
      )}
      {/* AF-assist lamp — the small detail that makes a front read as a front */}
      <circle
        cx={x + w * (spec.grip === "none" ? 0.14 : 0.28)}
        cy={plateY + 7}
        r={1.6}
        fill="var(--color-surface)"
        strokeWidth={0.8}
        opacity={0.8}
      />

      <Mount cx={lensCx} cy={lensCy} r={lensR} />
    </>
  );
}

/** Phone: rounded slab, held landscape, with its camera island. */
function PhoneBody({ spec }: { spec: Spec }) {
  const w = spec.mm.w * U;
  const h = spec.mm.h * U;
  const x = CX - w / 2;
  const y = BASE - h;
  const lensR = spec.lensR * h;
  // Three lenses on a "Pro" island (spec.lensR is bumped for those), two else.
  const three = spec.lensR > 0.13;
  const island = lensR * (three ? 4.6 : 4.2);
  const ix = x + w - island - h * 0.14;
  const iy = y + h * 0.14;

  return (
    <>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={h * 0.19}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <rect
        x={ix}
        y={iy}
        width={island}
        height={island}
        rx={island * 0.28}
        fill="var(--color-surface-2)"
        strokeWidth={THIN}
      />
      {(three
        ? [
            [0.3, 0.3],
            [0.3, 0.72],
            [0.72, 0.5],
          ]
        : [
            [0.32, 0.32],
            [0.68, 0.68],
          ]
      ).map(([fx, fy], i) => (
        <g key={i}>
          <circle
            cx={ix + island * fx}
            cy={iy + island * fy}
            r={lensR}
            fill="var(--color-surface)"
            strokeWidth={THIN}
          />
          <circle cx={ix + island * fx} cy={iy + island * fy} r={lensR * 0.45} strokeWidth={0.8} />
        </g>
      ))}
      {/* Flash + microphone pinhole */}
      <circle cx={ix + island * 0.75} cy={iy + island * (three ? 0.22 : 0.28)} r={1.6} strokeWidth={0.8} />
      <circle cx={ix + island * 0.75} cy={iy + island * 0.85} r={0.9} strokeWidth={0.7} opacity={0.7} />
    </>
  );
}

/** Drone: fuselage, four arms with props, gimbal ball under the nose. */
function DroneBody({ spec, hatch }: { spec: Spec; hatch: string }) {
  const w = spec.mm.w * U;
  const h = spec.mm.h * U;
  const bodyW = w * 0.42;
  const bodyH = h * 0.4;
  const bx = CX - bodyW / 2;
  const by = BASE - h + h * 0.22;
  const armLen = (w - bodyW) / 2;
  const propR = w * 0.16;
  const lensR = spec.lensR * h * 0.7;

  const arms: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];

  return (
    <>
      <defs>
        <HatchDef id={hatch} />
      </defs>
      {arms.map(([sx, sy], i) => {
        const ex = CX + sx * (bodyW / 2 + armLen * 0.82);
        const ey = by + bodyH / 2 + sy * bodyH * 0.42;
        return (
          <g key={i}>
            <line
              x1={CX + sx * bodyW * 0.32}
              y1={by + bodyH / 2 + sy * bodyH * 0.2}
              x2={ex}
              y2={ey}
              strokeWidth={STROKE * 2.2}
              strokeLinecap="round"
              opacity={0.9}
            />
            <circle cx={ex} cy={ey} r={3.4} fill="var(--color-surface)" strokeWidth={THIN} />
            {/* Blades, drawn as the arcs a spinning prop actually reads as */}
            <path
              d={`M ${ex - propR} ${ey - 3} Q ${ex} ${ey - 9} ${ex + propR} ${ey - 3}`}
              strokeWidth={THIN}
              opacity={0.75}
            />
            <path
              d={`M ${ex - propR} ${ey + 3} Q ${ex} ${ey + 9} ${ex + propR} ${ey + 3}`}
              strokeWidth={THIN}
              opacity={0.75}
            />
          </g>
        );
      })}
      <rect
        x={bx}
        y={by}
        width={bodyW}
        height={bodyH}
        rx={bodyH * 0.3}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <rect
        x={bx}
        y={by + bodyH * 0.55}
        width={bodyW}
        height={bodyH * 0.45}
        fill={`url(#${hatch})`}
        stroke="none"
        opacity={0.8}
      />
      {/* Gimbal: yoke under the nose carrying the camera ball */}
      <path
        d={`M ${CX - bodyW * 0.16} ${by + bodyH} L ${CX - bodyW * 0.16} ${by + bodyH + 6}
            M ${CX + bodyW * 0.16} ${by + bodyH} L ${CX + bodyW * 0.16} ${by + bodyH + 6}`}
        strokeWidth={THIN}
      />
      <circle
        cx={CX}
        cy={by + bodyH + 9}
        r={h * 0.14}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <circle cx={CX} cy={by + bodyH + 9} r={lensR} strokeWidth={THIN} />
      <circle cx={CX} cy={by + bodyH + 9} r={lensR * 0.45} strokeWidth={0.8} opacity={0.7} />
    </>
  );
}

/** Action cam: a cube of a body, big lens ring, side door seam. */
function ActionBody({ spec, hatch, clip }: { spec: Spec; hatch: string; clip: string }) {
  const w = spec.mm.w * U;
  const h = spec.mm.h * U;
  const x = CX - w / 2;
  const y = BASE - h;
  const lensR = spec.lensR * h;

  return (
    <>
      <defs>
        <HatchDef id={hatch} />
        <clipPath id={clip}>
          <rect x={x} y={y} width={w} height={h} rx={h * 0.16} />
        </clipPath>
      </defs>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={h * 0.16}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <g clipPath={`url(#${clip})`}>
        <rect x={x} y={y + h * 0.3} width={w} height={h * 0.7} fill={`url(#${hatch})`} stroke="none" />
      </g>
      {/* Lens ring, proud of the body like the real barrel */}
      <circle
        cx={x + spec.lensX * w}
        cy={y + h * 0.52}
        r={lensR * 1.28}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <circle cx={x + spec.lensX * w} cy={y + h * 0.52} r={lensR} strokeWidth={THIN} />
      <circle cx={x + spec.lensX * w} cy={y + h * 0.52} r={lensR * 0.5} strokeWidth={0.8} />
      {/* Front status screen + shutter button on top */}
      <rect
        x={x + w * 0.6}
        y={y + h * 0.36}
        width={w * 0.26}
        height={h * 0.2}
        rx={1.5}
        fill="var(--color-surface-2)"
        strokeWidth={THIN}
      />
      <rect x={CX - 4} y={y - 3} width={8} height={3.5} rx={1} fill="var(--color-surface)" strokeWidth={THIN} />
    </>
  );
}

/** Camcorder: long body, barrel at the front, viewfinder at the back. */
function CamcorderBody({ spec, hatch, clip }: { spec: Spec; hatch: string; clip: string }) {
  const w = spec.mm.w * U;
  const h = spec.mm.h * U;
  const x = CX - w / 2;
  const y = BASE - h;
  const bodyY = y + h * 0.22;
  const bodyH = h * 0.78;
  const lensR = spec.lensR * h;
  const lensCx = x + spec.lensX * w;

  return (
    <>
      <defs>
        <HatchDef id={hatch} />
        <clipPath id={clip}>
          <rect x={x} y={bodyY} width={w} height={bodyH} rx={6} />
        </clipPath>
      </defs>
      {/* Microphone/accessory block on the top plate */}
      <rect
        x={x + w * 0.42}
        y={bodyY - h * 0.13}
        width={w * 0.3}
        height={h * 0.13 + 2}
        rx={3}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <rect
        x={x}
        y={bodyY}
        width={w}
        height={bodyH}
        rx={6}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <g clipPath={`url(#${clip})`}>
        <rect
          x={x + w * 0.4}
          y={bodyY}
          width={w * 0.6}
          height={bodyH}
          fill={`url(#${hatch})`}
          stroke="none"
        />
      </g>
      {/* Lens barrel, stepped out of the body */}
      <rect
        x={lensCx - lensR * 1.25}
        y={bodyY + bodyH * 0.14}
        width={lensR * 2.5}
        height={bodyH * 0.72}
        rx={lensR * 0.5}
        fill="var(--color-surface)"
        strokeWidth={STROKE}
      />
      <Mount cx={lensCx} cy={bodyY + bodyH * 0.5} r={lensR} />
      {/* Eyecup at the back */}
      <rect
        x={x + w * 0.78}
        y={bodyY + bodyH * 0.18}
        width={w * 0.16}
        height={bodyH * 0.28}
        rx={3}
        fill="var(--color-surface)"
        strokeWidth={THIN}
      />
    </>
  );
}

/**
 * Draw a camera from its EXIF name. `title` is what a screen reader announces —
 * the artwork itself is decorative, the name is already in the card's text.
 */
export default function CameraArt({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const hatch = `gear-hatch-${uid}`;
  const clip = `gear-clip-${uid}`;
  const spec = cameraArt(name);

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
      {spec.body === "phone" ? (
        <PhoneBody spec={spec} />
      ) : spec.body === "drone" ? (
        <DroneBody spec={spec} hatch={hatch} />
      ) : spec.body === "action" ? (
        <ActionBody spec={spec} hatch={hatch} clip={clip} />
      ) : spec.body === "camcorder" ? (
        <CamcorderBody spec={spec} hatch={hatch} clip={clip} />
      ) : (
        <StandardBody spec={spec} hatch={hatch} clip={clip} />
      )}
    </svg>
  );
}
