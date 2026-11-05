export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="flex-none">
      <defs>
        <linearGradient id="tp-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#37aee2" />
          <stop offset="1" stopColor="#1e6fd9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#tp-logo)" />
      <path d="M6 21.5 12 14l4.2 5 2.8-3.2L26 23a1 1 0 0 1-.8 1.5H6.8A1 1 0 0 1 6 21.5Z" fill="#fff" />
      <circle cx="21.5" cy="10.5" r="2.6" fill="#fff" />
    </svg>
  );
}

/** The mark's mountain and sun without its square, in colour, for placing on a light surface. */
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="4 6 24 20" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="tp-glyph" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#37aee2" />
          <stop offset="1" stopColor="#1e6fd9" />
        </linearGradient>
      </defs>
      <path d="M6 21.5 12 14l4.2 5 2.8-3.2L26 23a1 1 0 0 1-.8 1.5H6.8A1 1 0 0 1 6 21.5Z" fill="url(#tp-glyph)" />
      <circle cx="21.5" cy="10.5" r="2.6" fill="url(#tp-glyph)" />
    </svg>
  );
}
