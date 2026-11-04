import { TriangleAlert } from 'lucide-react';

/** Fake storage must never be mistaken for the real thing, so it is impossible to miss. */
export function DemoBadge({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      className={`inline-flex items-center gap-2 rounded-full bg-amber-400 px-3 py-1.5 text-xs font-bold text-amber-950 shadow-md ${className}`}
    >
      <TriangleAlert className="size-3.5 flex-none" aria-hidden="true" />
      Demo mode: photos are not sent to Telegram
    </div>
  );
}
