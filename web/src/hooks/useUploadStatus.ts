import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api } from '@/api';
import { uploader } from '@/lib/uploads';

export function useLocalUploads() {
  return useSyncExternalStore(uploader.subscribe, uploader.snapshot);
}

/** Watches the server's queue, and refreshes the grid as photos move through it. */
export function useUploadStatus() {
  const queryClient = useQueryClient();
  const local = useLocalUploads();
  const sending = local.some((e) => e.stage === 'waiting' || e.stage === 'sending');

  const query = useQuery({
    queryKey: ['upload-status'],
    queryFn: api.uploadStatus,
    refetchInterval: (q) => {
      const data = q.state.data;
      return sending || data?.scan.running || (data?.items.some((i) => i.status !== 'failed') ?? false) ? 1200 : 20_000;
    },
  });

  const stats = query.data?.stats;
  const scan = query.data?.scan;
  const signature = `${stats?.count}/${stats?.pending}/${stats?.failed}/${stats?.trash}/${scan?.added}/${scan?.running}`;
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current !== signature) {
      previous.current = signature;
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
    }
  }, [signature, queryClient]);

  useEffect(() => {
    uploader.onReceived = () => {
      void queryClient.invalidateQueries({ queryKey: ['upload-status'] });
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
    };
    return () => {
      uploader.onReceived = null;
    };
  }, [queryClient]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (uploader.isBusy) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  return query.data;
}
