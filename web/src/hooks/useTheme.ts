import { useEffect, useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'tele-photo-theme';

function read(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be blocked. The system setting is a fine answer.
  }
  return 'system';
}

const listeners = new Set<() => void>();
let current = read();

function apply(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(choice: ThemeChoice): void {
  current = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Still applies for this visit.
  }
  apply(choice);
  for (const listener of listeners) listener();
}

export function useTheme(): ThemeChoice {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply(current);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return theme;
}
