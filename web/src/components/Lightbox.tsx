import { LiquiGlass } from '@liqui-design/glass';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Calendar, Camera, ChevronLeft, ChevronRight, CloudCheck, CloudUpload, Download, FileImage, FolderPlus, Info,
  MapPin, RotateCcw, Star, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, originalUrl, type PhotoDetail, type PhotoItem, previewUrl } from '@/api';
import { Tip } from '@/components/IconAction';
import { Toolbar, ToolbarButton, ToolbarGroup } from '@/components/ui/toolbar';
import { usePhotoActions } from '@/hooks/usePhotoActions';
import { formatBytes, formatExposure, formatMegapixels, fullDate, timeOfDay } from '@/lib/format';

/** Shown in the browser at full size only below this. Larger ones wait for the person to ask. */
const AUTO_ORIGINAL_BYTES = 50 * 1024 * 1024;
const WEB_SAFE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_ZOOM = 8;

interface LightboxProps {
  photoId: number;
  items: PhotoItem[];
  mode: 'normal' | 'trash';
  /** True while a dialog is open on top, which then owns the keyboard. */
  keysPaused: boolean;
  onNavigate: (id: number) => void;
  onClose: () => void;
  onAddToAlbum: (ids: number[]) => void;
  onDeleteForever: (ids: number[], after: () => void) => void;
}

const VIEW_DEFAULT = { scale: 1, x: 0, y: 0 };

export function Lightbox({ photoId, items, mode, keysPaused, onNavigate, onClose, onAddToAlbum, onDeleteForever }: LightboxProps) {
  const actions = usePhotoActions();
  const detail = useQuery({ queryKey: ['photo', photoId], queryFn: () => api.photo(photoId) });
  const photo = detail.data;
  const [infoOpen, setInfoOpen] = useState(() => window.innerWidth >= 1180);
  const [view, setView] = useState(VIEW_DEFAULT);
  const [originalState, setOriginalState] = useState<'none' | 'loading' | 'ready' | 'failed'>('none');
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const swipe = useRef<number | null>(null);

  const index = items.findIndex((item) => item.id === photoId);
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 ? items[index + 1] : undefined;

  useEffect(() => {
    setView(VIEW_DEFAULT);
    setOriginalState('none');
  }, [photoId]);

  // The page stays exactly where it was underneath, so closing lands back on the same photo.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, []);

  useEffect(() => {
    for (const neighbor of [previous, next]) {
      if (neighbor && !neighbor.noPreview && !neighbor.previewComing) new Image().src = previewUrl(neighbor.id);
    }
  }, [previous, next]);

  const webSafe = photo ? WEB_SAFE.has(photo.mime) : false;
  const isGif = photo?.mime === 'image/gif';

  const loadOriginal = useCallback(() => {
    setOriginalState((state) => (state === 'none' || state === 'failed' ? 'loading' : state));
  }, []);

  // A preview of a GIF would be frozen, so it goes straight to the real thing.
  useEffect(() => {
    if (isGif) loadOriginal();
  }, [isGif, loadOriginal]);

  useEffect(() => {
    if (photo && webSafe && view.scale > 1.2 && photo.size <= AUTO_ORIGINAL_BYTES) loadOriginal();
  }, [photo, webSafe, view.scale, loadOriginal]);

  useEffect(() => {
    if (originalState !== 'loading') return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => !cancelled && setOriginalState('ready');
    image.onerror = () => !cancelled && setOriginalState('failed');
    image.src = originalUrl(photoId);
    return () => {
      cancelled = true;
    };
  }, [originalState, photoId]);

  const afterRemoval = useCallback(() => {
    if (next) onNavigate(next.id);
    else if (previous) onNavigate(previous.id);
    else onClose();
  }, [next, previous, onNavigate, onClose]);

  const removeToTrash = () => void actions.trash([photoId]).then(afterRemoval);
  const restore = () => void actions.restore([photoId]).then(afterRemoval);
  const toggleFavorite = () => photo && void actions.setFavorite([photoId], !photo.favorite);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (keysPaused || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && previous) onNavigate(previous.id);
      else if (event.key === 'ArrowRight' && next) onNavigate(next.id);
      else if (event.key === 'i') setInfoOpen((open) => !open);
      else if (event.key === 'f' && mode === 'normal') toggleFavorite();
      else if ((event.key === 'Delete' || event.key === '#') && mode === 'normal') removeToTrash();
    };
    // Capture phase: otherwise a tooltip left open by returning focus takes the Esc for itself.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      setView((current) => {
        const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY * 0.0022)));
        if (scale === 1) return VIEW_DEFAULT;
        const ratio = scale / current.scale;
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const hasPreview = photo?.previewState === 'ready';
  const src = originalState === 'ready' ? originalUrl(photoId) : previewUrl(photoId);

  return (
    <div role="dialog" aria-modal="true" aria-label={photo?.filename ?? 'Photo'} data-lightbox className="fixed inset-0 z-50 flex bg-black text-white">
      <div
        ref={stage}
        className={`relative min-w-0 flex-1 touch-none overflow-hidden select-none ${view.scale > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left - rect.width / 2;
          const py = event.clientY - rect.top - rect.height / 2;
          setView((current) => (current.scale > 1 ? VIEW_DEFAULT : { scale: 2.5, x: -px * 1.5, y: -py * 1.5 }));
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [role="toolbar"]')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
          swipe.current = view.scale === 1 ? event.clientX : null;
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          drag.current = { x: event.clientX, y: event.clientY, moved: true };
          if (view.scale > 1) setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={(event) => {
          if (swipe.current !== null) {
            const distance = event.clientX - swipe.current;
            if (distance > 70 && previous) onNavigate(previous.id);
            else if (distance < -70 && next) onNavigate(next.id);
          }
          drag.current = null;
          swipe.current = null;
        }}
      >
        {hasPreview ? (
          <img
            key={photoId}
            src={src}
            alt={photo?.filename ?? ''}
            draggable={false}
            className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
            style={{
              // A preview can be smaller than the screen, and it should still fill it like the original would.
              width: photo?.width && photo?.height ? `min(100%, calc(100dvh * ${photo.width / photo.height}))` : undefined,
              height: 'auto',
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transition: drag.current ? 'none' : 'transform 90ms ease-out',
            }}
          />
        ) : photo ? (
          <NoPreview photo={photo} onDownload={() => actions.download([photoId])} />
        ) : null}

        <div className="absolute top-3 right-3 left-3 z-10 flex items-center gap-2">
          <Tip label="Back to photos">
            <button type="button" aria-label="Back to photos" onClick={onClose} className="block flex-none cursor-pointer rounded-full">
              <RoundGlass size={46}>
                <ArrowLeft className="size-5 text-white" aria-hidden="true" />
              </RoundGlass>
            </button>
          </Tip>
          <span className="flex-1" />
          <div className="dark">
            <Toolbar aria-label="Photo actions" className="lq-round" glass={{ radius: 24, frost: 0.45, blur: 1 }}>
              <ToolbarGroup className="flex items-center">
                {mode === 'trash' ? (
                  <>
                    <LightboxAction label="Restore" onClick={restore} icon={<RotateCcw className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Delete forever" onClick={() => onDeleteForever([photoId], afterRemoval)} icon={<Trash2 className="size-[18px] text-[#ff8a8f]" aria-hidden="true" />} />
                  </>
                ) : (
                  <>
                    <LightboxAction
                      label={photo?.favorite ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
                      onClick={toggleFavorite}
                      icon={<Star className={`size-[18px] ${photo?.favorite ? 'fill-current text-amber-300' : ''}`} aria-hidden="true" />}
                    />
                    <LightboxAction label="Add to album" onClick={() => onAddToAlbum([photoId])} icon={<FolderPlus className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Download original" onClick={() => actions.download([photoId])} icon={<Download className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Move to Trash (Delete)" onClick={removeToTrash} icon={<Trash2 className="size-[18px]" aria-hidden="true" />} />
                  </>
                )}
                <LightboxAction label="Info (I)" onClick={() => setInfoOpen((open) => !open)} icon={<Info className={`size-[18px] ${infoOpen ? 'text-[#8fb3ff]' : ''}`} aria-hidden="true" />} />
              </ToolbarGroup>
            </Toolbar>
          </div>
        </div>

        {previous ? <NavArrow side="left" label="Previous photo" onClick={() => onNavigate(previous.id)} /> : null}
        {next ? <NavArrow side="right" label="Next photo" onClick={() => onNavigate(next.id)} /> : null}

        {originalState === 'loading' ? <Chip>Loading the original from Telegram…</Chip> : null}
        {originalState === 'failed' ? <Chip>Couldn't load the original. Showing the preview.</Chip> : null}
        {originalState === 'none' && photo && webSafe && view.scale > 1.2 && photo.size > AUTO_ORIGINAL_BYTES ? (
          <Chip>
            <button type="button" className="cursor-pointer font-semibold underline" onClick={loadOriginal}>
              Load the {formatBytes(photo.size)} original
            </button>
          </Chip>
        ) : null}
      </div>

      {infoOpen ? <InfoPanel photo={photo} onClose={() => setInfoOpen(false)} /> : null}
    </div>
  );
}

function LightboxAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <Tip label={label}>
      <ToolbarButton aria-label={label} onClick={onClick}>
        {icon}
      </ToolbarButton>
    </Tip>
  );
}

function RoundGlass({ size, children }: { size: number; children: ReactNode }) {
  return (
    <LiquiGlass radius={size / 2} blur={1} frost={0.35} refraction={size} bezel={Math.round(size * 0.26)} className="dark lq-round" style={{ width: size, height: size }} contentClassName="grid size-full place-items-center">
      {children}
    </LiquiGlass>
  );
}

function NavArrow({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <div className={`absolute top-1/2 z-10 hidden -translate-y-1/2 min-[720px]:block ${side === 'left' ? 'left-3' : 'right-3'}`}>
      <Tip label={label}>
        <button type="button" aria-label={label} onClick={onClick} className="block cursor-pointer rounded-full">
          <RoundGlass size={52}>
            <Icon className="size-6 text-white" aria-hidden="true" />
          </RoundGlass>
        </button>
      </Tip>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/65 px-4 py-2 text-[13px] whitespace-nowrap text-white backdrop-blur-md">
      {children}
    </div>
  );
}

function NoPreview({ photo, onDownload }: { photo: PhotoDetail; onDownload: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <FileImage className="size-14 text-white/60" aria-hidden="true" />
        <p className="text-base font-semibold">{photo.filename}</p>
        <p className="text-[13.5px] text-white/65">
          {photo.previewState === 'missing'
            ? 'The preview is being rebuilt from Telegram.'
            : "This browser can't show this format, but the original is stored safely and unchanged."}
        </p>
        <button type="button" onClick={onDownload} className="mt-1 cursor-pointer rounded-full bg-white px-4 py-2 text-[13.5px] font-semibold text-black">
          Download original ({formatBytes(photo.size)})
        </button>
      </div>
    </div>
  );
}

function Fact({ icon, title, lines }: { icon: ReactNode; title: ReactNode; lines: ReactNode[] }) {
  return (
    <div className="flex gap-3.5">
      <span className="mt-0.5 flex-none text-white/60">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {lines.filter(Boolean).map((line, i) => (
          <div key={i} className="mt-0.5 text-[12.5px] text-white/60">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function storageFact(photo: PhotoDetail) {
  if (photo.status === 'stored') {
    return <Fact icon={<CloudCheck className="size-5" aria-hidden="true" />} title="In your Telegram" lines={['Original quality, unchanged', photo.telegramMessageId ? `Message #${photo.telegramMessageId} in Tele-Photo Library` : null]} />;
  }
  if (photo.status === 'failed') {
    return <Fact icon={<TriangleAlert className="size-5 text-[#ff8a8f]" aria-hidden="true" />} title="Not in Telegram yet" lines={[photo.error, 'Your file is safe on this server. Retry from the uploads panel.']} />;
  }
  return <Fact icon={<CloudUpload className="size-5" aria-hidden="true" />} title="Being saved to Telegram" lines={['A full copy stays on this server until Telegram confirms it.']} />;
}

function InfoPanel({ photo, onClose }: { photo: PhotoDetail | undefined; onClose: () => void }) {
  const camera = photo?.camera;
  const cameraName = [camera?.make, camera?.model]
    .filter(Boolean)
    .join(' ')
    // Many cameras repeat the maker's name in the model: "Canon Canon EOS R5".
    .replace(/^(\S+)\s+\1\b/i, '$1');
  const exposure = [
    camera?.fNumber ? `ƒ/${camera.fNumber}` : null,
    camera?.exposureTime ? formatExposure(camera.exposureTime) : null,
    camera?.focalLength ? `${Math.round(camera.focalLength)} mm` : null,
    camera?.iso ? `ISO ${camera.iso}` : null,
  ].filter(Boolean).join(' · ');

  const daysLeft = photo?.purgeAt ? Math.max(0, Math.ceil((photo.purgeAt - Date.now()) / 86_400_000)) : null;

  return (
    <aside aria-label="Photo details" className="dark absolute inset-x-0 bottom-0 z-20 flex max-h-[62dvh] w-full flex-col overflow-y-auto rounded-t-3xl border-l border-white/10 bg-[#15161b] min-[900px]:static min-[900px]:max-h-none min-[900px]:w-[360px] min-[900px]:flex-none min-[900px]:rounded-none">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 className="text-[15px] font-semibold">Info</h2>
        <button type="button" aria-label="Close info" onClick={onClose} className="grid size-8 cursor-pointer place-items-center rounded-full hover:bg-white/10">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {photo ? (
        <div className="flex flex-col gap-5 px-5 pt-2 pb-6">
          {daysLeft !== null ? (
            <p className="rounded-xl bg-amber-400/15 px-3 py-2 text-[12.5px] font-medium text-amber-200">
              In Trash. Deleted forever in {daysLeft} {daysLeft === 1 ? 'day' : 'days'}.
            </p>
          ) : null}
          <Fact
            icon={<Calendar className="size-5" aria-hidden="true" />}
            title={fullDate(photo.takenAt)}
            lines={[timeOfDay(photo.takenAt), photo.takenSource === 'exif' || photo.takenSource === 'telegram' ? null : photo.takenSource === 'file' ? 'Date from the file, as it had no capture date' : 'Date of upload, as it had no capture date']}
          />
          <Fact
            icon={<FileImage className="size-5" aria-hidden="true" />}
            title={photo.filename}
            lines={[
              [photo.width && photo.height ? formatMegapixels(photo.width, photo.height) : null, photo.width && photo.height ? `${photo.width} × ${photo.height}` : null, formatBytes(photo.size)].filter(Boolean).join(' · '),
              photo.mime,
            ]}
          />
          {cameraName || exposure ? <Fact icon={<Camera className="size-5" aria-hidden="true" />} title={cameraName || 'Camera'} lines={[camera?.lens, exposure]} /> : null}
          {photo.location ? (
            <Fact
              icon={<MapPin className="size-5" aria-hidden="true" />}
              title={
                <a className="underline" href={`https://www.openstreetmap.org/?mlat=${photo.location.lat}&mlon=${photo.location.lon}#map=14/${photo.location.lat}/${photo.location.lon}`} target="_blank" rel="noreferrer">
                  View on map
                </a>
              }
              lines={[`${photo.location.lat.toFixed(5)}, ${photo.location.lon.toFixed(5)}`]}
            />
          ) : null}
          {storageFact(photo)}
          {photo.albums.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-white/60">Albums</h3>
              <div className="flex flex-wrap gap-1.5">
                {photo.albums.map((album) => (
                  <Link key={album.id} href={`/albums/${album.id}`} className="rounded-full bg-white/10 px-3 py-1 text-[12.5px] hover:bg-white/15">
                    {album.title}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
