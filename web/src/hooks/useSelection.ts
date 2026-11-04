import { useCallback, useMemo, useState } from 'react';
import type { PhotoItem } from '@/api';

export function useSelection(items: PhotoItem[]) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const order = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);

  // A photo can leave the view (trashed elsewhere, say), so a selection only ever counts what is shown.
  const visible = useMemo(() => {
    const ids: number[] = [];
    for (const id of selected) if (order.has(id)) ids.push(id);
    return ids;
  }, [selected, order]);

  const toggle = useCallback(
    (id: number, range: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        const from = anchor === null ? undefined : order.get(anchor);
        const to = order.get(id);
        if (range && from !== undefined && to !== undefined) {
          const [low, high] = from < to ? [from, to] : [to, from];
          for (let i = low; i <= high; i++) next.add(items[i]!.id);
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      setAnchor(id);
    },
    [anchor, items, order],
  );

  const toggleGroup = useCallback((group: PhotoItem[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const allIn = group.every((item) => next.has(item.id));
      for (const item of group) {
        if (allIn) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  return { selected, ids: visible, count: visible.length, toggle, toggleGroup, clear };
}

export type Selection = ReturnType<typeof useSelection>;
