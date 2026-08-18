// From an EXIF string to a drawable shape: the model behind the /gear page's
// line-art illustrations.
//
// The library can hold any camera anyone ever pointed at anything, so hand-drawn
// artwork per body is a losing game. Instead each EXIF name is classified into a
// body ARCHETYPE (SLR, rangefinder, compact, phone, drone, …) with a rough
// physical footprint, and the SVG is drawn from those numbers — so every gear
// card gets a plausible portrait, unknown cameras included, and the bodies read
// to scale against each other (a 5D towers over a GR, as it should).
//
// Lenses go further and are drawn from the DATA rather than a lookup: barrel
// length and diameter follow the focal length and the maximum aperture (a fast
// 56mm is short and fat, a 70-300 is long and thin), with the focal range read
// off the name where it is stated and off the recorded EXIF otherwise.
//
// Pure functions, no React and no DB — the page, and any future consumer, share
// one source of truth for "what does this thing look like".

// ---------------------------------------------------------------- cameras ----

export type CameraBody =
  | "dslr" // reflex: tall prism hump, deep grip, big mount
  | "slr" // mirrorless with a centred EVF hump (X-T5, A7, EOS R, Z6)
  | "rangefinder" // flat top plate, finder in the corner (X-E5, X100V, A6700)
  | "compact" // pocketable, fixed lens (GR IIIx, RX100)
  | "phone"
  | "drone"
  | "action" // GoPro-shaped cube
  | "camcorder";

export type CameraArt = {
  body: CameraBody;
  /** Body footprint in millimetres — ballpark per archetype, not per model. All
   *  the cards share one mm→pixel scale, which is what makes them comparable. */
  mm: { w: number; h: number };
  /** Top-plate silhouette. */
  hump: "prism" | "low" | "none";
  /** Where the eye goes: through the hump, through a corner window, or nowhere. */
  finder: "prism" | "window" | "none";
  grip: "deep" | "slight" | "none";
  /** Control dials on the top plate. */
  dials: number;
  /** Mount/lens radius, as a fraction of the body height. */
  lensR: number;
  /** Lens centre, as a fraction of the body width from the left edge. */
  lensX: number;
};

const BODIES: Record<CameraBody, Omit<CameraArt, "body">> = {
  dslr: {
    mm: { w: 152, h: 116 },
    hump: "prism",
    finder: "prism",
    grip: "deep",
    dials: 2,
    lensR: 0.34,
    lensX: 0.52,
  },
  slr: {
    mm: { w: 130, h: 92 },
    hump: "prism",
    finder: "prism",
    grip: "slight",
    dials: 3,
    lensR: 0.3,
    lensX: 0.5,
  },
  rangefinder: {
    mm: { w: 126, h: 74 },
    hump: "none",
    finder: "window",
    grip: "slight",
    dials: 2,
    lensR: 0.3,
    lensX: 0.5,
  },
  compact: {
    mm: { w: 109, h: 62 },
    hump: "none",
    finder: "none",
    grip: "slight",
    dials: 1,
    lensR: 0.32,
    lensX: 0.56,
  },
  phone: {
    // Held landscape, so the long side is the width.
    mm: { w: 147, h: 71 },
    hump: "none",
    finder: "none",
    grip: "none",
    dials: 0,
    lensR: 0.12,
    lensX: 0.84,
  },
  drone: {
    mm: { w: 152, h: 88 },
    hump: "none",
    finder: "none",
    grip: "none",
    dials: 0,
    lensR: 0.16,
    lensX: 0.5,
  },
  action: {
    mm: { w: 71, h: 55 },
    hump: "none",
    finder: "none",
    grip: "none",
    dials: 0,
    lensR: 0.36,
    lensX: 0.36,
  },
  camcorder: {
    mm: { w: 148, h: 86 },
    hump: "low",
    finder: "window",
    grip: "none",
    dials: 1,
    lensR: 0.3,
    lensX: 0.28,
  },
};

// trim + collapse whitespace + lowercase, so the matchers below tolerate the
// casing and spacing quirks different makers write ("NIKON D850", "X-T5", …).
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// Ordered matchers — FIRST hit wins, so the specific families come before the
// broad ones. Notably: "iPhone 12 mini" must be a phone before /mini \d/ reads
// it as a DJI Mini, and the flat-top mirrorless bodies (A7C, A6700) must be
// claimed before the /ilce-7|a7/ hump rule.
const MATCHERS: [CameraBody, RegExp][] = [
  // Phones report a marketing name (iPhone, Pixel) or an internal SKU (SM-…,
  // OnePlus A5010 — cf. lib/cameraLabels.ts).
  [
    "phone",
    /iphone|ipad|ipod|pixel|galaxy|\bsm-[a-z]\d|oneplus|xiaomi|redmi|\bpoco\b|huawei|honor|\boppo\b|\bvivo\b|nothing phone|motorola|\bmoto [ge]\b|nexus/,
  ],
  // Drones write the flight-controller board code (FC-nnnn) as often as a name.
  [
    "drone",
    /\bdji\b|mavic|phantom \d|inspire \d|avata|\bfc\d{3,4}\b|autel|\bevo (ii|lite|nano)|skydio|parrot|anafi/,
  ],
  ["action", /gopro|hero\s?\d|osmo (action|pocket)|insta360|\bone (rs|x\d)\b|virb/],
  ["camcorder", /handycam|camcorder|\bhdr-[a-z]|\bfdr-ax|\bhc-x\d|\bag-[a-z]|\bxa\d{2}|\bur\d{2}\b/],
  // Reflex bodies: Canon "EOS 5D Mark III"/"EOS 90D", Nikon "D850", Pentax
  // "K-3", Sony's A-mount SLT translucent-mirror line.
  ["dslr", /eos-?1d|eos \d{1,4}d\b|eos rebel|\bnikon d\d|\bd[1-8]\d{2,3}\b|\bslt-|\bk-[1357x]\b|\bist\b|\bsd1\b/],
  // Fixed-lens pocketables.
  [
    "compact",
    /ricoh gr|\bgr ii{1,2}x?\b|\bgriii|\brx0\b|\brx100|powershot|coolpix|\bxf10\b|\bx70\b|\btg-\d|\bdsc-(w|hx|t)|\blx\d|\bzs\d|\bg[579] x\b|\bstylus\b/,
  ],
  // Flat-top / corner-finder mirrorless — checked before the hump rule since
  // several share a family prefix with it (ILCE-7C vs ILCE-7, X-E vs X-T).
  [
    "rangefinder",
    /\bx-e\d|\bx-pro\d|\bx100|\bx-a\d|\bx-m\d|ilce-6\d00|ilce-7c|\ba6\d00\b|\ba7c\b|\bnex-|leica [mq]\b|\btyp \d{3}|sigma fp|\be-p\d|\bpen-f\b|\bz fc\b|\bzf\b|\bdc-gx|\bdmc-gx|\bzv-e/,
  ],
  // Mirrorless with a centred EVF hump.
  [
    "slr",
    /\bx-[ht]\d|\bx-s\d{2}|\bx-s\d\b|ilce-\d|\ba7\b|\ba7r|\ba7s|\ba9\b|\ba1\b|eos r\d?\b|\bz [5-9]\b|\bz\d{1}\b|nikon z|\be-m\d|\bom-\d|\bdc-g|\bdc-s\d|\bdmc-g|lumix s|\bgfx|\bs1r?\b|\bk-\d{2}/,
  ],
];

/**
 * Classify an EXIF camera string into an archetype and its drawing parameters.
 * Unknown cameras fall back to the rangefinder silhouette: the most neutral
 * "a camera" shape of the set, and never wrong in an embarrassing way.
 */
export function cameraArt(name: string): CameraArt {
  const s = norm(name);
  const body = MATCHERS.find(([, re]) => re.test(s))?.[0] ?? "rangefinder";
  const art = { body, ...BODIES[body] };

  // Full-frame reflex bodies wear a visibly bigger mount than a crop one.
  if (body === "dslr" && /eos-?1d|\b5d|\b6d|\bd[4-8]\d0\b|\bd[3-5]\b|\ba99/.test(s)) {
    art.mm = { w: 152, h: 120 };
    art.lensR = 0.36;
  }
  // Medium format is simply large.
  if (/\bgfx|hasselblad|\bx1d\b|phase one/.test(s)) {
    art.mm = { w: 150, h: 104 };
    art.lensR = 0.34;
  }
  // Two-lens phone modules on the small phones, three on the "Pro" ones.
  if (body === "phone" && /\bpro\b|ultra|\bmax\b/.test(s)) art.lensR = 0.14;

  return art;
}

// ----------------------------------------------------------------- lenses ----

export type LensArt = {
  zoom: boolean;
  focalMin: number | null;
  focalMax: number | null;
  /** Fastest aperture: read off the name, else the fastest one ever recorded. */
  aperture: number | null;
  /** Barrel size in millimetres, derived from the optics (see below). */
  mm: { length: number; diameter: number };
  /** Marked aperture ring — Fujifilm's "R", Voigtländer/Mitakon manual glass. */
  apertureRing: boolean;
  /** The ring carries an "A" (auto) position — the Fujifilm "R" convention. */
  autoStop: boolean;
  /** Engraved on the barrel, like the real thing: "56" / "70-300". */
  label: string;
};

/** EXIF focal/aperture stats for a lens, straight from the aggregate. */
export type LensExif = {
  focalMin?: number | null;
  focalMax?: number | null;
  aperture?: number | null;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Derive a lens' drawn shape from its name plus the focal/aperture range its
 * files actually recorded. Nothing here is a lookup table: the barrel diameter
 * follows the entrance pupil (focal ÷ aperture, the physical reason fast glass
 * is fat) and the length follows the focal length, so a 90mm f/2 draws long, an
 * f/2.8 pancake draws flat, and a 70-300 draws like a telescope.
 */
export function lensArt(name: string, exif: LensExif = {}): LensArt {
  const s = name.replace(/\s+/g, " ").trim();

  // "18-55mm" / "70-300 mm" → a zoom, stated on the barrel.
  const range = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*mm/i);
  // "56mm", "XF27mmF2.8" → a prime.
  const single = s.match(/(\d+(?:\.\d+)?)\s*mm/i);
  // "f/1.2", "F2.8", "f1.4" — the first number wins on variable-aperture zooms
  // ("f/3.5-5.6"), which is what the front of the barrel advertises. The focal
  // token is cut out first: in "XF35mmF1.4" or "XF 18-55mm", the F of the
  // mount name fronts the focal length, and without the cut it would read as
  // f/35 or f/18.
  const rest = range ? s.replace(range[0], " ") : single ? s.replace(single[0], " ") : s;
  const fstop = rest.match(/f\/?\s*(\d+(?:\.\d+)?)/i);
  // Manual and third-party glass often states the aperture without the "f"
  // ("35mm 0.95", "18-35 1.8"). Only looked for AFTER the focal length, so a
  // focal digit or a "Mark II" can't pass for an f-number.
  const tail = single ? s.slice(s.indexOf(single[0]) + single[0].length) : "";
  const bare = tail.match(/(?:^|\s)(0?\.\d{2}|\d(?:\.\d)?)(?=$|\s)/);

  let focalMin = range ? Number(range[1]) : single ? Number(single[1]) : null;
  let focalMax = range ? Number(range[2]) : focalMin;
  // No focal on the name (adapted or third-party glass that reports a bare
  // model): fall back to what the frames recorded.
  if (focalMin == null && exif.focalMin != null) focalMin = exif.focalMin;
  if (focalMax == null && exif.focalMax != null) focalMax = exif.focalMax;

  let aperture = fstop ? Number(fstop[1]) : bare ? Number(bare[1]) : null;
  if (aperture == null || aperture < 0.5 || aperture > 45) aperture = exif.aperture ?? null;

  // A zoom either says so on the barrel, or gives itself away by having shot a
  // spread of focal lengths.
  const zoom =
    !!range ||
    (focalMin != null && focalMax != null && focalMax - focalMin > 2);

  // Optics → millimetres. `f` drives length, the entrance pupil drives girth.
  const f = focalMax ?? focalMin ?? 35;
  const fast = aperture ?? 4;
  const pupil = f / Math.max(fast, 0.7);
  const diameter = clamp(Math.round(pupil + 24), 52, 104);
  const length = zoom
    ? clamp(Math.round(0.72 * f + 28), 46, 190)
    : clamp(Math.round(1.25 * f - 20 + (fast <= 1.4 ? 12 : 0)), 26, 190);

  // Aperture ring: Fujifilm marks it with a standalone "R" (and that ring has an
  // "A" position), and manual-focus glass (Voigtländer, Mitakon, Samyang,
  // TTArtisan, Zeiss) always carries a marked ring, without the A.
  const autoStop = /\bR\b/.test(s);
  const apertureRing =
    autoStop ||
    /voigt|mitakon|zhongyi|samyang|rokinon|ttartisan|7artisans|laowa|zeiss|nokton|ultron|helios|takumar/i.test(s);

  const label =
    focalMin == null
      ? ""
      : zoom && focalMax != null && focalMax !== focalMin
        ? `${Math.round(focalMin)}-${Math.round(focalMax)}`
        : `${Math.round(focalMin)}`;

  return {
    zoom,
    focalMin,
    focalMax,
    aperture,
    mm: { length, diameter },
    apertureRing,
    autoStop,
    label,
  };
}

/** "56mm f/1.2" — the spec line under a lens card, from the derived numbers. */
export function lensSpec(art: LensArt): string {
  const focal =
    art.focalMin == null
      ? null
      : art.zoom && art.focalMax != null && art.focalMax !== art.focalMin
        ? `${Math.round(art.focalMin)}-${Math.round(art.focalMax)}mm`
        : `${Math.round(art.focalMin)}mm`;
  const ap = art.aperture == null ? null : `f/${art.aperture}`;
  return [focal, ap].filter(Boolean).join(" · ");
}
