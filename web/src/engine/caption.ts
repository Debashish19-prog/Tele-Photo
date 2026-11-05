/** Strips anything that could change meaning in a path or a zip, and keeps the name readable. */
export function cleanFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'photo';
}

export interface CaptionFacts {
  filename: string;
  sha256: string;
  takenAt: string;
  width: number | null;
  height: number | null;
}

const MARKER = 'telephoto:v1';
const TELEGRAM_CAPTION_LIMIT = 1024;
const MACHINE_LINE = /^telephoto:v1 sha256=([0-9a-f]{64}) taken=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?: w=(\d+) h=(\d+))?$/;

/**
 * The caption does two jobs. The top is for a person browsing the channel in Telegram, with
 * hashtags that make it searchable by year and month. The last line is for this app, and holds
 * what is needed to rebuild the library if the local index is ever lost.
 */
export function buildCaption(facts: CaptionFacts): string {
  const year = facts.takenAt.slice(0, 4);
  const month = facts.takenAt.slice(5, 7);
  const size = facts.width && facts.height ? ` w=${facts.width} h=${facts.height}` : '';
  const machine = `${MARKER} sha256=${facts.sha256} taken=${facts.takenAt}${size}`;
  const human = `#y${year} #y${year}_${month}\n${facts.takenAt.slice(0, 16).replace('T', ' ')}`;
  const room = TELEGRAM_CAPTION_LIMIT - human.length - machine.length - 3;
  const name = facts.filename.replace(/\s+/g, ' ').slice(0, Math.max(0, room));
  return `${human}\n${name}\n${machine}`;
}

/** Only the last line counts, so a filename shaped like the marker cannot spoof it. */
export function parseCaption(caption: string): Omit<CaptionFacts, 'filename'> | null {
  const match = MACHINE_LINE.exec(caption.trimEnd().split('\n').at(-1) ?? '');
  if (!match) return null;
  return {
    sha256: match[1]!,
    takenAt: match[2]!,
    width: match[3] ? Number(match[3]) : null,
    height: match[4] ? Number(match[4]) : null,
  };
}

/** Marks the one message that holds albums, favorites and Trash. The hashtag makes it findable by search. */
export const STATE_CAPTION = '#telephotostate\ntelephoto-state:v1\nAlbums and favorites for Tele-Photo. Deleting this loses them, but not your photos.';
export const STATE_MARKER = 'telephoto-state:v1';
export const STATE_SEARCH = '#telephotostate';
