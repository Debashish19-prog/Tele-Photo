import { useState } from 'react';
import { AlertDialog, AlertDialogActions, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmRequest {
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => Promise<unknown> | void;
}

/** For anything that cannot be undone. The confirm button says what it will do, never just "OK". */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={request !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>{request?.title}</AlertDialogTitle>
        <AlertDialogDescription>{request?.description}</AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogClose disabled={busy}>Cancel</AlertDialogClose>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!request) return;
              setBusy(true);
              void Promise.resolve(request.onConfirm()).finally(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {busy ? 'Working…' : request?.confirm}
          </Button>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}
