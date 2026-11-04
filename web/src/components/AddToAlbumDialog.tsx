import { useQuery } from '@tanstack/react-query';
import { Images, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, thumbUrl } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent, DialogDismiss, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePhotoActions } from '@/hooks/usePhotoActions';
import { formatCount } from '@/lib/format';

export function AddToAlbumDialog({ photoIds, onClose }: { photoIds: number[] | null; onClose: (added: boolean) => void }) {
  const actions = usePhotoActions();
  const open = photoIds !== null;
  const albums = useQuery({ queryKey: ['albums'], queryFn: api.albums, enabled: open });
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function addTo(id: number, name: string) {
    if (!photoIds) return;
    setBusy(true);
    await actions.addToAlbum(id, photoIds, name);
    setBusy(false);
    onClose(true);
  }

  async function createAndAdd() {
    const name = title.trim();
    if (!name || !photoIds) return;
    setBusy(true);
    await actions.createAlbumWith(name, photoIds);
    setBusy(false);
    setTitle('');
    onClose(true);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose(false)}>
      <DialogContent>
        <DialogTitle>Add {formatCount(photoIds?.length ?? 0, 'photo')} to an album</DialogTitle>
        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createAndAdd();
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New album name" aria-label="New album name" />
          <Button type="submit" variant="accent" disabled={busy || !title.trim()}>
            <Plus className="size-4" aria-hidden="true" /> Create
          </Button>
        </form>
        <ul className="mt-3 flex max-h-72 flex-col overflow-y-auto">
          {albums.data?.map((album) => (
            <li key={album.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void addTo(album.id, album.title)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl p-1.5 text-left hover:bg-[var(--lq-highlight)]"
              >
                {album.coverId ? (
                  <img src={thumbUrl(album.coverId)} alt="" className="size-11 flex-none rounded-lg object-cover" />
                ) : (
                  <span className="grid size-11 flex-none place-items-center rounded-lg bg-[var(--app-tile)] text-[var(--lq-text-dim)]">
                    <Images className="size-5" aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{album.title}</span>
                  <span className="block text-[12px] text-[var(--lq-text-dim)]">{formatCount(album.photoCount, 'photo')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <DialogActions>
          <DialogDismiss>Cancel</DialogDismiss>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
