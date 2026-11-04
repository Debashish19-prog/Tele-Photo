import type { PhotoItem } from '@/api';
import { dayLabel, monthLabel } from '@/lib/format';

export interface Tile {
  item: PhotoItem;
  x: number;
  width: number;
}

export type LayoutRow =
  | { kind: 'header'; y: number; height: number; day: string; label: string; items: PhotoItem[] }
  | { kind: 'photos'; y: number; height: number; tiles: Tile[] };

export interface Marker {
  y: number;
  year: string;
  label: string;
}

export interface Layout {
  rows: LayoutRow[];
  height: number;
  markers: Marker[];
}

export interface LayoutOptions {
  width: number;
  targetRowHeight: number;
  gap: number;
  headerHeight: number;
  /** Extra room above a day after the first. */
  sectionGap: number;
}

/** Keeps a panorama from taking a whole row or a tall crop from becoming a sliver. Tiles crop to fit. */
const clampAspect = (w: number, h: number) => Math.min(3, Math.max(0.5, w / h || 1));

/**
 * The justified grid: photos fill each row edge to edge at their own shape, so rows differ a little
 * in height instead of cropping everything to squares. A final short row keeps its natural size
 * rather than stretching one photo across the whole width.
 */
export function buildLayout(items: PhotoItem[], options: LayoutOptions): Layout {
  const { width, targetRowHeight, gap, headerHeight, sectionGap } = options;
  const rows: LayoutRow[] = [];
  const markers: Marker[] = [];
  if (width <= 0 || items.length === 0) return { rows, height: 0, markers };

  let y = 0;
  let index = 0;
  let lastMonth = '';

  while (index < items.length) {
    const day = items[index]!.takenAt.slice(0, 10);
    const start = index;
    while (index < items.length && items[index]!.takenAt.slice(0, 10) === day) index++;
    const group = items.slice(start, index);

    if (start > 0) y += sectionGap;
    const month = day.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      markers.push({ y, year: day.slice(0, 4), label: monthLabel(day) });
    }
    rows.push({ kind: 'header', y, height: headerHeight, day, label: dayLabel(day), items: group });
    y += headerHeight;

    let pending: PhotoItem[] = [];
    let aspectSum = 0;
    const flush = (isLast: boolean) => {
      if (pending.length === 0) return;
      const gaps = gap * (pending.length - 1);
      const fitted = (width - gaps) / aspectSum;
      // A last row only shrinks when it would overflow. It never stretches past the target.
      const height = isLast ? Math.min(fitted, targetRowHeight) : fitted;
      let x = 0;
      const tiles = pending.map((item) => {
        const tileWidth = clampAspect(item.width, item.height) * height;
        const tile: Tile = { item, x, width: tileWidth };
        x += tileWidth + gap;
        return tile;
      });
      rows.push({ kind: 'photos', y, height, tiles });
      y += height + gap;
      pending = [];
      aspectSum = 0;
    };

    for (const item of group) {
      const aspect = clampAspect(item.width, item.height);
      pending.push(item);
      aspectSum += aspect;
      const naturalWidth = aspectSum * targetRowHeight + gap * (pending.length - 1);
      if (naturalWidth >= width) flush(false);
    }
    flush(true);
  }

  return { rows, height: y, markers };
}

/** The index of the first row that reaches below `y`. Rows are sorted, so this is a binary search. */
export function firstRowAt(rows: LayoutRow[], y: number): number {
  let low = 0;
  let high = rows.length - 1;
  let found = rows.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid]!;
    if (row.y + row.height >= y) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}
