const LOCK_NAME = 'tele-photo-active-tab';
/** A page being reloaded still holds the lock for a moment, and that must not look like another tab. */
const NOTICE_DELAY_MS = 800;

export type TabLockState = 'waiting' | 'active' | 'elsewhere' | 'moved';

/**
 * Only one tab may run the app at a time.
 *
 * Each tab holds the library in memory, and two of them would hand out the same ids, purge the same
 * Trash and overwrite each other's saves. A server used to settle all of that. Web Locks are
 * released by the browser when a tab closes or crashes, so this can never get stuck, and a tab left
 * waiting takes over by itself once the other one has gone.
 */
export function holdTabLock(onChange: (state: TabLockState) => void, options: { takeOver?: boolean } = {}): () => void {
  if (!navigator.locks) {
    // Very old browsers only. Running without the guard beats not running.
    onChange('active');
    return () => undefined;
  }
  let finish: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // A browser can keep a page frozen after leaving it, in case the person comes back, and that page
  // would go on holding the lock. So leaving always lets go, and a page brought back starts afresh.
  window.addEventListener('pagehide', finish);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });

  const notice = setTimeout(() => onChange('elsewhere'), NOTICE_DELAY_MS);
  const granted = () => {
    clearTimeout(notice);
    onChange('active');
    return held;
  };
  const claim = options.takeOver ? navigator.locks.request(LOCK_NAME, { steal: true }, granted) : navigator.locks.request(LOCK_NAME, granted);

  // Rejected when another tab takes over. That tab now owns the library, so this one has to stop.
  claim.catch(() => {
    clearTimeout(notice);
    onChange('moved');
  });
  return finish;
}
