import type { ReactElement, ReactNode } from 'react';
import { ToolbarButton } from '@/components/ui/toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** An icon-only control always needs a name, for people who can't see the icon and those who can't place it. */
export function Tip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ToolbarIcon({ label, icon, onClick, disabled, danger }: { label: string; icon: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Tip label={label}>
      <ToolbarButton aria-label={label} onClick={onClick} disabled={disabled} className={danger ? 'text-[var(--lq-danger-text)]' : undefined}>
        {icon}
      </ToolbarButton>
    </Tip>
  );
}
