/**
 * A placeholder for the real venue photo — not a photo, an atmospheric
 * approximation built entirely in SVG (shelf lighting, pendant glows,
 * a floor reflection, grain) so the panel reads as considered rather than
 * empty while a real photo is still pending. See login-hero.tsx: this is
 * only ever rendered when `photoSrc` is absent, and is swapped out
 * entirely — not layered under — the moment one is supplied.
 */
export function LoginHeroScene() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
    >
      <defs>
        <linearGradient id="lh-base" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#12161a" />
          <stop offset="55%" stopColor="#0d1013" />
          <stop offset="100%" stopColor="#08090b" />
        </linearGradient>
        <linearGradient id="lh-shelf-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8a34d" stopOpacity="0" />
          <stop offset="55%" stopColor="#e8a34d" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#e8a34d" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="lh-pendant" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffd9a0" stopOpacity="0.9" />
          <stop offset="45%" stopColor="#e8a34d" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#e8a34d" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lh-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8a34d" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#e8a34d" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="lh-vignette" cx="50%" cy="42%" r="75%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="75%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
        </radialGradient>
        <filter id="lh-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.02 0" />
        </filter>
      </defs>

      <rect width="1000" height="600" fill="url(#lh-base)" />

      {/* Back-bar shelving, upper-right — two shelf lines of bottle
          silhouettes over a warm backlight strip. */}
      <rect x="560" y="90" width="400" height="10" fill="url(#lh-shelf-glow)" />
      <rect x="560" y="180" width="400" height="10" fill="url(#lh-shelf-glow)" />
      {[
        [590, 60, 14, 40], [615, 50, 14, 50], [640, 65, 14, 35], [668, 45, 16, 55],
        [696, 58, 14, 42], [722, 52, 14, 48], [748, 62, 14, 38], [776, 48, 16, 52],
        [804, 60, 14, 40], [830, 55, 14, 45], [858, 63, 14, 37], [886, 50, 16, 50],
        [914, 58, 14, 42],
      ].map(([x, y, w, h], i) => (
        <g key={`s1-${i}`}>
          <rect x={x} y={y} width={w} height={h} rx={w / 2.4} fill="#1c2126" opacity={0.85} />
          <rect x={x + w * 0.3} y={y - 4} width={w * 0.4} height="6" rx="2" fill="#e8a34d" opacity={0.35} />
        </g>
      ))}
      {[
        [600, 150, 13, 34], [626, 142, 13, 42], [652, 152, 13, 32], [680, 138, 15, 46],
        [708, 148, 13, 36], [734, 144, 13, 40], [762, 150, 13, 34], [790, 140, 15, 44],
        [818, 149, 13, 35], [846, 145, 13, 39],
      ].map(([x, y, w, h], i) => (
        <g key={`s2-${i}`}>
          <rect x={x} y={y} width={w} height={h} rx={w / 2.4} fill="#1c2126" opacity={0.8} />
          <rect x={x + w * 0.3} y={y - 4} width={w * 0.4} height="6" rx="2" fill="#e8a34d" opacity={0.3} />
        </g>
      ))}

      {/* Pendant lights — a few warm blooms at varying heights with a
          thin cord up to the top edge. */}
      {[
        [230, 150], [330, 200], [430, 165],
      ].map(([cx, cy], i) => (
        <g key={`p-${i}`}>
          <line x1={cx} y1="0" x2={cx} y2={cy - 14} stroke="#2a2f34" strokeWidth="1.5" />
          <circle cx={cx} cy={cy} r="70" fill="url(#lh-pendant)" />
          <circle cx={cx} cy={cy} r="5" fill="#ffe4b8" />
        </g>
      ))}

      {/* Soft seating silhouettes, lower-left — barely-there depth. */}
      <ellipse cx="140" cy="560" rx="220" ry="70" fill="#000000" opacity="0.35" />
      <ellipse cx="420" cy="580" rx="260" ry="60" fill="#000000" opacity="0.3" />

      {/* Floor catching the warm light. */}
      <rect x="0" y="480" width="1000" height="120" fill="url(#lh-floor)" />

      <rect width="1000" height="600" fill="url(#lh-vignette)" />
      <rect width="1000" height="600" filter="url(#lh-grain)" opacity="0.5" />
    </svg>
  )
}
