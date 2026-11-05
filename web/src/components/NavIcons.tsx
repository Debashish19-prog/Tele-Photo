import type { SVGProps } from 'react';

/** Solid glyphs for the glass orbs in the navigation, where a thin outline would get lost in the refraction. */
function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function PhotosGlyph() {
  return (
    <Glyph>
      <path
        fillRule="evenodd"
        d="M6 3.5h12A2.5 2.5 0 0 1 20.5 6v12a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5ZM9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-3 10.5h12l-3.8-5.4a.6.6 0 0 0-1 0l-2.4 3.2-1.3-1.5a.6.6 0 0 0-.9 0L6 17.5Z"
      />
    </Glyph>
  );
}

export function FavoritesGlyph() {
  return (
    <Glyph stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="m12 3.6 2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.98l-5.25 2.77 1-5.85L3.5 9.75l5.9-.85L12 3.6Z" />
    </Glyph>
  );
}

export function AlbumsGlyph() {
  return (
    <Glyph>
      <path d="M7.5 3h9a1 1 0 1 1 0 2h-9a1 1 0 0 1 0-2ZM5.5 6.4h13a1 1 0 1 1 0 2h-13a1 1 0 0 1 0-2Z" />
      <rect x="3" y="9.8" width="18" height="11.2" rx="2.6" />
    </Glyph>
  );
}

export function TrashGlyph() {
  return (
    <Glyph>
      <path d="M9.6 3h4.8c.5 0 .95.3 1.15.75l.65 1.45H20a1 1 0 1 1 0 2H4a1 1 0 0 1 0-2h3.8l.65-1.45C8.65 3.3 9.1 3 9.6 3Z" />
      <path
        fillRule="evenodd"
        d="M5.4 8.6h13.2l-.85 10.9a2.5 2.5 0 0 1-2.49 2.3H8.74a2.5 2.5 0 0 1-2.49-2.3L5.4 8.6Zm4.35 3a.9.9 0 0 0-.9.95l.35 5.5a.9.9 0 1 0 1.8-.1l-.35-5.5a.9.9 0 0 0-.9-.85Zm4.5 0a.9.9 0 0 0-.9.85l-.35 5.5a.9.9 0 1 0 1.8.1l.35-5.5a.9.9 0 0 0-.9-.95Z"
      />
    </Glyph>
  );
}
