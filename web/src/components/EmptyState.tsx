import type { ReactNode } from 'react';

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
      <div className="grid size-20 place-items-center rounded-full bg-[var(--app-tile)] text-[var(--lq-text-dim)]">{icon}</div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children ? <div className="text-[13.5px] leading-relaxed text-[var(--lq-text-dim)]">{children}</div> : null}
    </div>
  );
}
