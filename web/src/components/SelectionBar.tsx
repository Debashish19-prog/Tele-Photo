import { Download, FolderMinus, FolderPlus, ImageIcon, RotateCcw, Star, Trash2, X } from 'lucide-react';
import { motion, useIsPresent } from 'motion/react';
import { ToolbarIcon } from '@/components/IconAction';
import { Button } from '@/components/ui/button';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/ui/toolbar';
import { formatCount } from '@/lib/format';
import { QUICK } from '@/lib/motion';

export interface SelectionHandlers {
  onClear: () => void;
  onFavorite?: () => void;
  onAddToAlbum?: () => void;
  onDownload?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
  onRemoveFromAlbum?: () => void;
  onSetCover?: () => void;
  /** The single main action, when the page is being used to pick photos for something. */
  primary?: { label: string; onClick: () => void };
  allFavorite?: boolean;
}

/** Takes the place of the header while photos are selected, as the actions then all concern them. */
export function SelectionBar({ count, handlers }: { count: number; handlers: SelectionHandlers }) {
  const h = handlers;
  // Lets the header start returning as this leaves, rather than popping back once it has gone.
  const leaving = !useIsPresent();
  return (
    <motion.div
      data-leaving={leaving}
      initial={{ opacity: 0, y: -14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14, transition: QUICK }}
      style={{ pointerEvents: leaving ? 'none' : undefined }}
      className="selection-bar fixed top-3 right-3 left-3 z-30 min-[720px]:right-5 min-[720px]:left-5"
    >
      <Toolbar aria-label="Actions for the selected photos" className="lq-round w-full" glass={{ frost: 0.8, radius: 26, blur: 1, elevated: true }}>
        <ToolbarGroup className="flex items-center">
          <ToolbarIcon label="Clear selection" icon={<X className="size-[18px]" aria-hidden="true" />} onClick={h.onClear} />
        </ToolbarGroup>
        <span className="px-1.5 text-sm font-semibold whitespace-nowrap" aria-live="polite">
          {formatCount(count, 'selected', 'selected')}
        </span>
        <span className="flex-1" />
        {h.primary ? (
          <Button variant="accent" size="sm" onClick={h.primary.onClick}>
            {h.primary.label}
          </Button>
        ) : (
          <ToolbarGroup className="flex items-center">
            {h.onRestore ? <ToolbarIcon label="Restore" icon={<RotateCcw className="size-[18px]" aria-hidden="true" />} onClick={h.onRestore} /> : null}
            {h.onFavorite ? (
              <ToolbarIcon
                label={h.allFavorite ? 'Remove from favorites' : 'Add to favorites'}
                icon={<Star className={`size-[18px] ${h.allFavorite ? 'fill-current' : ''}`} aria-hidden="true" />}
                onClick={h.onFavorite}
              />
            ) : null}
            {h.onSetCover ? <ToolbarIcon label="Use as album cover" icon={<ImageIcon className="size-[18px]" aria-hidden="true" />} onClick={h.onSetCover} /> : null}
            {h.onAddToAlbum ? <ToolbarIcon label="Add to album" icon={<FolderPlus className="size-[18px]" aria-hidden="true" />} onClick={h.onAddToAlbum} /> : null}
            {h.onRemoveFromAlbum ? <ToolbarIcon label="Remove from this album" icon={<FolderMinus className="size-[18px]" aria-hidden="true" />} onClick={h.onRemoveFromAlbum} /> : null}
            {h.onDownload ? <ToolbarIcon label="Download originals" icon={<Download className="size-[18px]" aria-hidden="true" />} onClick={h.onDownload} /> : null}
            {h.onTrash || h.onDeleteForever ? <ToolbarSeparator /> : null}
            {h.onTrash ? <ToolbarIcon label="Move to Trash" icon={<Trash2 className="size-[18px]" aria-hidden="true" />} onClick={h.onTrash} /> : null}
            {h.onDeleteForever ? <ToolbarIcon danger label="Delete forever" icon={<Trash2 className="size-[18px]" aria-hidden="true" />} onClick={h.onDeleteForever} /> : null}
          </ToolbarGroup>
        )}
      </Toolbar>
    </motion.div>
  );
}
