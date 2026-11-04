import { LiquiGlass } from '@liqui-design/glass';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, CloudUpload, Copy, RotateCw, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type ServerUpload, type UploadStatus } from '@/api';
import { Progress, ProgressTrack } from '@/components/ui/progress';
import { useLocalUploads } from '@/hooks/useUploadStatus';
import { formatBytes } from '@/lib/format';
import { type LocalUpload, uploader } from '@/lib/uploads';

const MAX_ROWS = 60;

type Tone = 'active' | 'done' | 'error' | 'info';

interface Row {
  key: string;
  filename: string;
  size: number;
  tone: Tone;
  label: string;
  progress: number | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

function describeServer(item: ServerUpload): Pick<Row, 'tone' | 'label' | 'progress'> {
  if (item.status === 'failed') return { tone: 'error', label: item.error ?? 'Could not save to Telegram.', progress: null };
  if (item.status === 'uploading') {
    return { tone: 'active', label: `Saving to Telegram · ${Math.round((item.progress ?? 0) * 100)}%`, progress: item.progress ?? 0 };
  }
  if (item.nextAttemptAt) {
    const minutes = Math.max(1, Math.ceil((item.nextAttemptAt - Date.now()) / 60_000));
    return { tone: 'active', label: item.error ? `Will retry in about ${minutes} min` : `Telegram asked us to wait about ${minutes} min`, progress: null };
  }
  return { tone: 'active', label: 'Waiting to go to Telegram', progress: null };
}

export function UploadPanel({ status }: { status: UploadStatus | undefined }) {
  const queryClient = useQueryClient();
  const local = useLocalUploads();
  const [collapsed, setCollapsed] = useState(false);

  const server = useMemo(() => new Map((status?.items ?? []).map((item) => [item.id, item])), [status]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const claimed = new Set<number>();
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['upload-status'] });

    const retryServer = (id: number) => () => void api.retryUploads([id]).then(refresh);
    const cancelServer = (id: number) => () => void api.cancelUpload(id).then(() => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
    });

    for (const entry of local as LocalUpload[]) {
      const base = { key: `l${entry.key}`, filename: entry.filename, size: entry.size, onDismiss: () => uploader.dismiss(entry.key) };
      if (entry.photoId !== null) claimed.add(entry.photoId);
      const remote = entry.photoId !== null ? server.get(entry.photoId) : undefined;

      if (entry.stage === 'waiting') out.push({ ...base, tone: 'active', label: 'Waiting', progress: null, onDismiss: undefined });
      else if (entry.stage === 'sending') {
        out.push({ ...base, tone: 'active', label: `Sending to server · ${Math.round(entry.progress * 100)}%`, progress: entry.progress, onDismiss: undefined });
      } else if (entry.stage === 'error') {
        out.push({ ...base, tone: 'error', label: entry.error ?? 'Failed.', progress: null, onRetry: entry.file ? () => uploader.retry(entry.key) : undefined });
      } else if (entry.stage === 'duplicate') {
        out.push({ ...base, tone: 'info', label: 'Already in your library', progress: null });
      } else if (entry.stage === 'restored') {
        out.push({ ...base, tone: 'info', label: 'Back from Trash', progress: null });
      } else if (remote) {
        out.push({
          ...base,
          ...describeServer(remote),
          onDismiss: remote.status === 'uploading' ? undefined : cancelServer(remote.id),
          onRetry: remote.status === 'failed' ? retryServer(remote.id) : undefined,
        });
      } else {
        out.push({ ...base, tone: 'done', label: 'Saved to Telegram', progress: null });
      }
    }

    // Work the server is still doing after a reload, or from another device.
    for (const item of status?.items ?? []) {
      if (claimed.has(item.id)) continue;
      out.push({
        key: `s${item.id}`,
        filename: item.filename,
        size: item.size,
        ...describeServer(item),
        onDismiss: item.status === 'uploading' ? undefined : cancelServer(item.id),
        onRetry: item.status === 'failed' ? retryServer(item.id) : undefined,
      });
    }

    const rank: Record<Tone, number> = { error: 0, active: 1, done: 2, info: 3 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [local, server, status, queryClient]);

  const scanning = status?.scan.running ?? false;
  if (rows.length === 0 && !scanning) return null;

  const active = rows.filter((r) => r.tone === 'active').length;
  const failed = rows.filter((r) => r.tone === 'error').length;
  const finished = rows.length - active - failed;
  const sendingFromBrowser = local.some((e) => e.stage === 'sending' || e.stage === 'waiting');

  const title = scanning
    ? `Restoring from Telegram · ${status!.scan.added.toLocaleString()} found`
    : active > 0
      ? `Uploading ${active.toLocaleString()} ${active === 1 ? 'photo' : 'photos'}`
      : failed > 0
        ? `${failed.toLocaleString()} ${failed === 1 ? 'photo needs' : 'photos need'} attention`
        : `${finished.toLocaleString()} ${finished === 1 ? 'photo' : 'photos'} done`;

  return (
    <div className="fixed right-3 bottom-[88px] z-40 w-[min(380px,calc(100vw-1.5rem))] min-[720px]:right-5 min-[720px]:bottom-5">
      <LiquiGlass radius={22} elevated frost={1} blur={6} refraction={70} bezel={20} className="lq-solid" contentClassName="flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3" aria-live="polite">
          {failed > 0 && active === 0 ? (
            <TriangleAlert className="size-[18px] flex-none text-[var(--lq-danger)]" aria-hidden="true" />
          ) : active > 0 || scanning ? (
            <CloudUpload className="shimmer size-[18px] flex-none text-[var(--lq-accent)]" aria-hidden="true" />
          ) : (
            <Check className="size-[18px] flex-none text-emerald-500" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</h2>
          <button type="button" aria-label={collapsed ? 'Show uploads' : 'Hide uploads'} className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          </button>
          {active === 0 && failed === 0 && !scanning ? (
            <button
              type="button"
              aria-label="Close"
              className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]"
              onClick={() => uploader.clearSettled(() => true)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {collapsed ? null : (
          <>
            <ul className="max-h-[38vh] overflow-y-auto border-t border-[var(--app-line)]">
              {rows.slice(0, MAX_ROWS).map((row) => (
                <li key={row.key} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.filename}</p>
                      <span className="flex-none text-[11px] text-[var(--lq-text-dim)]">{formatBytes(row.size)}</span>
                    </div>
                    <p className={`mt-0.5 flex items-center gap-1 text-[12px] ${row.tone === 'error' ? 'font-medium text-[var(--lq-danger-text)]' : 'text-[var(--lq-text-dim)]'}`}>
                      {row.tone === 'done' ? <Check className="size-3 flex-none text-emerald-500" aria-hidden="true" /> : null}
                      {row.tone === 'info' ? <Copy className="size-3 flex-none" aria-hidden="true" /> : null}
                      <span className="min-w-0">{row.label}</span>
                    </p>
                    {row.progress !== null ? (
                      <Progress value={Math.round(row.progress * 100)} aria-label={`${row.filename} progress`} className="mt-1.5">
                        <ProgressTrack className="h-1.5" glass={{ material: 'clear' }} />
                      </Progress>
                    ) : null}
                  </div>
                  {row.onRetry ? (
                    <button type="button" aria-label={`Retry ${row.filename}`} className="grid size-7 flex-none cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={row.onRetry}>
                      <RotateCw className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {row.onDismiss && row.tone === 'error' ? (
                    <button type="button" aria-label={`Remove ${row.filename}`} className="grid size-7 flex-none cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={row.onDismiss}>
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
              {rows.length > MAX_ROWS ? (
                <li className="px-4 py-2 text-center text-[12px] text-[var(--lq-text-dim)]">and {(rows.length - MAX_ROWS).toLocaleString()} more</li>
              ) : null}
            </ul>
            {sendingFromBrowser ? (
              <p className="border-t border-[var(--app-line)] px-4 py-2 text-[11.5px] text-[var(--lq-text-dim)]">
                Keep this tab open until each file has reached the server. After that, the server finishes the job on its own.
              </p>
            ) : null}
          </>
        )}
      </LiquiGlass>
    </div>
  );
}
