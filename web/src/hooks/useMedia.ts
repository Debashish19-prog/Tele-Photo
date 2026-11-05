import { useEffect, useState } from 'react';
import { getEngine } from '@/api';

export type MediaKind = 'thumb' | 'preview' | 'original';
/** `empty` means there is no such image to show, which is different from failing to get one. */
export type MediaState = 'loading' | 'ready' | 'empty' | 'failed';

export interface MediaResult {
  url: string | null;
  state: MediaState;
}

/** A screen of thumbnails at most, so scrolling never opens hundreds of downloads at once. */
const MAX_THUMB_LOADS = 6;
/** Object URLs kept alive after their last user has gone, so scrolling back does not reload them. */
const KEEP_UNUSED = 400;

interface Entry {
  key: string;
  url: string | null;
  state: MediaState;
  users: number;
  listeners: Set<() => void>;
  force: boolean;
}

const entries = new Map<string, Entry>();
const thumbQueue: { entry: Entry; id: number }[] = [];
let activeThumbs = 0;

function settle(entry: Entry, blob: Blob | null): void {
  entry.url = blob ? URL.createObjectURL(blob) : null;
  entry.state = blob ? 'ready' : 'empty';
  for (const listener of entry.listeners) listener();
}

function fail(entry: Entry): void {
  entry.state = 'failed';
  for (const listener of entry.listeners) listener();
}

async function loadInto(entry: Entry, id: number, kind: MediaKind): Promise<void> {
  try {
    const engine = await getEngine();
    if (kind === 'thumb') settle(entry, await engine.thumb(id));
    else if (kind === 'preview') settle(entry, await engine.preview(id, { force: entry.force }));
    else settle(entry, await engine.original(id));
  } catch {
    fail(entry);
  }
}

/** Newest first: after a fast scroll, what is on screen now matters more than what went past. */
function pumpThumbs(): void {
  while (activeThumbs < MAX_THUMB_LOADS && thumbQueue.length > 0) {
    const { entry, id } = thumbQueue.pop()!;
    if (entry.users === 0) {
      entries.delete(entry.key);
      continue;
    }
    activeThumbs++;
    void loadInto(entry, id, 'thumb').finally(() => {
      activeThumbs--;
      pumpThumbs();
    });
  }
}

/** Originals are big, so they are let go at once. Thumbnails are small and worth keeping around. */
function trim(): void {
  const unused = [...entries.values()].filter((e) => e.users === 0 && e.state !== 'loading');
  for (const entry of unused) {
    const isThumb = entry.key.startsWith('thumb:');
    if (isThumb && unused.length <= KEEP_UNUSED) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entries.delete(entry.key);
  }
}

function acquire(id: number, kind: MediaKind, force: boolean): Entry {
  const key = `${kind}:${id}${force ? ':forced' : ''}`;
  let entry = entries.get(key);
  // A failure is worth another try next time something asks, in case the connection has come back.
  if (!entry || entry.state === 'failed') {
    entry = { key, url: null, state: 'loading', users: 0, listeners: new Set(), force };
    entries.set(key, entry);
    if (kind === 'thumb') {
      thumbQueue.push({ entry, id });
      entry.users++;
      pumpThumbs();
      return entry;
    }
    void loadInto(entry, id, kind);
  }
  entry.users++;
  return entry;
}

function release(entry: Entry): void {
  entry.users--;
  if (entry.users === 0) trim();
}

/**
 * The image for a photo, as a URL an <img> can use. It may have to come all the way from Telegram,
 * so it starts out null and fills in. Pass `enabled: false` to not fetch anything yet.
 */
export function useMedia(id: number | null, kind: MediaKind, options: { enabled?: boolean; force?: boolean } = {}): MediaResult {
  const { enabled = true, force = false } = options;
  const [, rerender] = useState(0);
  const [current, setCurrent] = useState<Entry | null>(null);

  useEffect(() => {
    if (id === null || !enabled) {
      setCurrent(null);
      return;
    }
    const entry = acquire(id, kind, force);
    const listener = () => rerender((n) => n + 1);
    entry.listeners.add(listener);
    setCurrent(entry);
    return () => {
      entry.listeners.delete(listener);
      release(entry);
    };
  }, [id, kind, enabled, force]);

  // The right photo only: for one render after `id` changes, `current` is still the last one's.
  if (!current || current.key !== `${kind}:${id}${force ? ':forced' : ''}`) return { url: null, state: 'loading' };
  return { url: current.url, state: current.state };
}

/** Warms up a photo the person is likely to open next. Only a local copy or a small download is worth it. */
export function preloadPreview(id: number): void {
  if (entries.has(`preview:${id}`)) return;
  const entry = acquire(id, 'preview', false);
  // Nobody is using it yet. It stays available until the next tidy-up.
  release(entry);
}
