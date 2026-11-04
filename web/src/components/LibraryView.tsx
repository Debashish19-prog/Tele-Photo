import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { api, type PhotoItem, type PhotoQuery } from '@/api';
import { AddToAlbumDialog } from '@/components/AddToAlbumDialog';
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';
import { Lightbox } from '@/components/Lightbox';
import { PhotoGrid } from '@/components/PhotoGrid';
import { SelectionBar, type SelectionHandlers } from '@/components/SelectionBar';
import { usePhotoActions } from '@/hooks/usePhotoActions';
import { useSelection } from '@/hooks/useSelection';
import { formatCount } from '@/lib/format';

interface LibraryViewProps {
  query: PhotoQuery;
  mode: 'library' | 'album' | 'trash';
  heading?: ReactNode;
  empty: ReactNode;
  albumId?: number;
  /** When set, the page is being used to pick photos, and tapping one selects it. */
  picker?: { label: (count: number) => string; onPick: (ids: number[]) => void };
}

export function LibraryView({ query, mode, heading, empty, albumId, picker }: LibraryViewProps) {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const actions = usePhotoActions();
  const [albumTarget, setAlbumTarget] = useState<number[] | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const photos = useQuery({
    queryKey: ['photos', query],
    queryFn: () => api.photos(query),
    placeholderData: (previous) => previous,
    // Thumbnails are being rebuilt in the background after a restore, so keep checking until they land.
    refetchInterval: (q) => (q.state.data?.some((item: PhotoItem) => item.previewComing) ? 5000 : false),
  });
  const items = useMemo(() => photos.data ?? [], [photos.data]);
  const selection = useSelection(items);

  const params = new URLSearchParams(search);
  const openId = (!picker && Number(params.get('photo'))) || null;

  const withPhoto = (id: number | null) => {
    const next = new URLSearchParams(search);
    if (id === null) next.delete('photo');
    else next.set('photo', String(id));
    const qs = next.toString();
    return qs ? `${path}?${qs}` : path;
  };

  const [openedHere, setOpenedHere] = useState(false);
  const open = (id: number) => {
    setOpenedHere(true);
    navigate(withPhoto(id));
  };
  const close = () => {
    // Opened from the grid, so going back undoes it. Arrived by link, so there is nothing to go back to.
    if (openedHere) history.back();
    else navigate(withPhoto(null), { replace: true });
    setOpenedHere(false);
  };

  const dialogOpen = albumTarget !== null || confirm !== null;

  // Esc belongs to whatever is on top: a dialog first, then the viewer, and only then the selection.
  const clearSelection = selection.clear;
  const escClearsSelection = selection.count > 0 && !dialogOpen && !openId;
  useEffect(() => {
    if (!escClearsSelection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escClearsSelection, clearSelection]);

  const askDeleteForever = (ids: number[], after: () => void) => {
    setConfirm({
      title: `Delete ${formatCount(ids.length, 'photo')} forever?`,
      description: 'The originals will be removed from your Telegram too. This cannot be undone.',
      confirm: 'Delete forever',
      onConfirm: () => actions.deleteForever(ids).then(after),
    });
  };

  const ids = selection.ids;
  const allFavorite = ids.length > 0 && ids.every((id) => items.find((item) => item.id === id)?.favorite);

  const handlers: SelectionHandlers =
    mode === 'trash'
      ? {
          onClear: selection.clear,
          onRestore: () => void actions.restore(ids).then(selection.clear),
          onDeleteForever: () => askDeleteForever(ids, selection.clear),
        }
      : picker
        ? { onClear: selection.clear, primary: { label: picker.label(ids.length), onClick: () => picker.onPick(ids) } }
        : {
            onClear: selection.clear,
            allFavorite,
            onFavorite: () => void actions.setFavorite(ids, !allFavorite).then(selection.clear),
            onAddToAlbum: () => setAlbumTarget(ids),
            onDownload: () => {
              actions.download(ids);
              selection.clear();
            },
            onTrash: () => void actions.trash(ids).then(selection.clear),
            ...(mode === 'album' && albumId
              ? {
                  onRemoveFromAlbum: () =>
                    void api.removeFromAlbum(albumId, ids).then(() => {
                      actions.refresh();
                      selection.clear();
                    }, actions.fail),
                  ...(ids.length === 1
                    ? {
                        onSetCover: () =>
                          void api.updateAlbum(albumId, { coverPhotoId: ids[0]! }).then(() => {
                            actions.refresh();
                            selection.clear();
                          }, actions.fail),
                      }
                    : {}),
                }
              : {}),
          };

  // In a picker, a plain tap selects rather than opens.
  const onTileOpen = picker ? (id: number) => selection.toggle(id, false) : open;

  return (
    <>
      {selection.count > 0 ? <SelectionBar count={selection.count} handlers={handlers} /> : null}
      {heading}
      {photos.isPending ? (
        <div className="py-20 text-center text-[var(--lq-text-dim)]" role="status">
          Loading your photos…
        </div>
      ) : photos.isError ? (
        <div className="py-20 text-center" role="alert">
          <p className="font-semibold">Couldn't load your photos</p>
          <p className="mt-1 text-[var(--lq-text-dim)]">{photos.error.message}</p>
        </div>
      ) : items.length === 0 ? (
        empty
      ) : (
        <PhotoGrid items={items} selection={selection} onOpen={onTileOpen} />
      )}
      {openId ? (
        <Lightbox
          photoId={openId}
          items={items}
          mode={mode === 'trash' ? 'trash' : 'normal'}
          keysPaused={dialogOpen}
          onNavigate={(id) => navigate(withPhoto(id), { replace: true })}
          onClose={close}
          onAddToAlbum={setAlbumTarget}
          onDeleteForever={askDeleteForever}
        />
      ) : null}
      <AddToAlbumDialog
        photoIds={albumTarget}
        onClose={(added) => {
          setAlbumTarget(null);
          if (added) selection.clear();
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
