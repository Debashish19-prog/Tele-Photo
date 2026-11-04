import { LiquiGlass } from '@liqui-design/glass';
import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Images, Library, LogOut, Moon, RefreshCw, Search, Star, Sun, SunMoon, Trash2, Unplug, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation, useSearch } from 'wouter';
import { type Account, api, type UploadStatus } from '@/api';
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';
import { DemoBadge } from '@/components/DemoBadge';
import { LogoMark } from '@/components/Logo';
import { UploadPanel } from '@/components/UploadPanel';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { TabBar, TabBarItem } from '@/components/ui/tab-bar';
import { Toaster, useToast } from '@/components/ui/toast';
import { setTheme, type ThemeChoice, useTheme } from '@/hooks/useTheme';
import { useUploadStatus } from '@/hooks/useUploadStatus';
import { formatBytes, formatCount } from '@/lib/format';
import { filesFromDrop, uploader } from '@/lib/uploads';
import { AlbumPage, AlbumsPage, FavoritesPage, PhotosPage, SearchPage, TrashPage } from '@/pages/Pages';

const NAV = [
  { href: '/', label: 'Photos', icon: Images },
  { href: '/favorites', label: 'Favorites', icon: Star },
  { href: '/albums', label: 'Albums', icon: Library },
  { href: '/trash', label: 'Trash', icon: Trash2 },
] as const;

function activeSection(path: string): string {
  if (path.startsWith('/albums')) return '/albums';
  return NAV.find((item) => item.href === path)?.href ?? '';
}

/** A menu often opens over a dark photo, and it has to stay readable there. */
const MENU_GLASS = { frost: 1, blur: 6 } as const;

const FILE_INPUT_ID = 'tp-file-input';
export const openFilePicker = () => document.getElementById(FILE_INPUT_ID)?.click();

function Sidebar({ stats }: { stats: UploadStatus['stats'] | undefined }) {
  const [path] = useLocation();
  const active = activeSection(path);
  return (
    <aside className="fixed top-3 bottom-3 left-3 z-30 hidden w-[calc(var(--sidebar-w)-1.5rem)] min-[720px]:block">
      <LiquiGlass radius={28} blur={1} frost={0.62} refraction={80} bezel={24} elevated className="h-full" contentClassName="flex h-full flex-col p-3">
        <Link href="/" aria-label="Tele-Photo home" className="mb-4 flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 max-[1179px]:justify-center">
          <LogoMark size={32} />
          <span className="text-[17px] font-bold tracking-tight max-[1179px]:hidden">Tele-Photo</span>
        </Link>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const current = active === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? 'page' : undefined}
                title={label}
                className={`flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-[14px] font-medium transition-colors max-[1179px]:justify-center ${
                  current ? 'bg-[color-mix(in_srgb,var(--lq-accent)_17%,transparent)] font-semibold text-[var(--lq-accent)]' : 'hover:bg-[var(--lq-highlight)]'
                }`}
              >
                <Icon className={`size-[19px] flex-none ${current && href === '/favorites' ? 'fill-current' : ''}`} aria-hidden="true" />
                <span className="max-[1179px]:hidden">{label}</span>
              </Link>
            );
          })}
        </nav>
        <span className="flex-1" />
        {stats ? (
          <div className="rounded-[14px] px-3 py-2.5 text-[12.5px] leading-snug max-[1179px]:hidden">
            <div className="flex items-center gap-1.5 font-semibold">
              <CloudUpload className="size-3.5 flex-none text-[var(--lq-accent)]" aria-hidden="true" /> In your Telegram
            </div>
            <div className="mt-1 text-[var(--lq-text-dim)]">
              {formatCount(stats.count, 'photo')} · {formatBytes(stats.bytes)}
            </div>
          </div>
        ) : null}
      </LiquiGlass>
    </aside>
  );
}

function SearchBox() {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const urlValue = path === '/search' ? new URLSearchParams(search).get('q') ?? '' : '';
  const [value, setValue] = useState(urlValue);
  const lastSent = useRef(urlValue);

  useEffect(() => {
    if (urlValue !== lastSent.current) {
      lastSent.current = urlValue;
      setValue(urlValue);
    }
  }, [urlValue]);

  useEffect(() => {
    const term = value.trim();
    if (term === lastSent.current.trim()) return;
    const timer = setTimeout(() => {
      lastSent.current = term;
      if (term) navigate(`/search?q=${encodeURIComponent(term)}`, { replace: path === '/search' });
      else if (path === '/search') navigate('/', { replace: true });
    }, 260);
    return () => clearTimeout(timer);
  }, [value, navigate, path]);

  return (
    <div role="search" className="min-w-0 flex-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search your photos"
        className="lq-round"
        aria-label="Search your photos"
        glass={{ radius: 24, frost: 0.72, blur: 1, refraction: 60, bezel: 16, elevated: true }}
        inputClassName="py-[13px] text-[14.5px]"
        start={<Search className="ml-1 size-[18px] text-[var(--lq-text-dim)]" aria-hidden="true" />}
        end={
          value ? (
            <button type="button" aria-label="Clear search" className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={() => setValue('')}>
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null
        }
      />
    </div>
  );
}

function UserMenu({ account, onSignedOut }: { account: Account; onSignedOut: () => void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const name = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username || account.phone;
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <>
      <Menu>
        <MenuTrigger aria-label={`Account: ${name}`} className="flex-none cursor-pointer rounded-full">
          <Avatar size={48} className="lq-round">
            <AvatarFallback className="text-[15px] font-semibold">{initial}</AvatarFallback>
          </Avatar>
        </MenuTrigger>
        <MenuContent align="end" className="lq-solid w-64" glass={MENU_GLASS}>
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-[13.5px] font-semibold">{name}</p>
            <p className="truncate text-[12px] text-[var(--lq-text-dim)]">{account.phone}</p>
          </div>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Appearance</MenuGroupLabel>
            <MenuRadioGroup value={theme} onValueChange={(value: ThemeChoice) => setTheme(value)}>
              <MenuRadioItem value="system">
                <SunMoon className="size-4" aria-hidden="true" /> Match this device
              </MenuRadioItem>
              <MenuRadioItem value="light">
                <Sun className="size-4" aria-hidden="true" /> Light
              </MenuRadioItem>
              <MenuRadioItem value="dark">
                <Moon className="size-4" aria-hidden="true" /> Dark
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              void api.rescan().then(
                () => {
                  toast.add({ title: 'Checking your Telegram library', description: 'Anything missing from this server will be restored.' });
                  void queryClient.invalidateQueries({ queryKey: ['upload-status'] });
                },
                (err: Error) => toast.add({ title: 'That did not work', description: err.message, type: 'error' }),
              )
            }
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Restore from Telegram
          </MenuItem>
          <MenuItem onClick={() => void api.logout().then(onSignedOut)}>
            <LogOut className="size-4" aria-hidden="true" /> Sign out of this browser
          </MenuItem>
          <MenuItem
            variant="danger"
            onClick={() =>
              setConfirm({
                title: 'Disconnect Telegram?',
                description: 'This server loses access to your Telegram account, and every browser is signed out. Your photos stay in your Telegram, and you can sign back in at any time.',
                confirm: 'Disconnect',
                onConfirm: () => api.disconnect().then(onSignedOut),
              })
            }
          >
            <Unplug className="size-4" aria-hidden="true" /> Disconnect Telegram
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function DropOverlay({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current++;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (event.dataTransfer) void filesFromDrop(event.dataTransfer).then(onFiles);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);

  if (!dragging) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-[var(--lq-scrim)] p-6">
      <LiquiGlass radius={32} elevated frost={0.7} blur={2} refraction={110} bezel={30} contentClassName="flex flex-col items-center gap-3 px-14 py-11 text-center">
        <Upload className="size-10 text-[var(--lq-accent)]" aria-hidden="true" />
        <p className="text-lg font-semibold">Drop to upload</p>
        <p className="text-[13px] text-[var(--lq-text-dim)]">Photos and whole folders, up to 1.95 GB each</p>
      </LiquiGlass>
    </div>
  );
}

function MobileTabs() {
  const [path, navigate] = useLocation();
  return (
    <div className="mobile-tabs fixed inset-x-3 bottom-3 z-30 min-[720px]:hidden">
      {/* The stock frost is nearly clear, which leaves dark labels unreadable over a dark photo. */}
      <TabBar className="lq-round w-full" value={activeSection(path) || '/'} onValueChange={(value: string) => navigate(value)} aria-label="Main" glass={{ frost: 0.85, blur: 2 }}>
        {NAV.map(({ href, label, icon: Icon }) => (
          <TabBarItem key={href} value={href} icon={<Icon className="size-[22px]" aria-hidden="true" />}>
            {label}
          </TabBarItem>
        ))}
      </TabBar>
    </div>
  );
}

interface ShellProps {
  account: Account;
  storage: 'telegram' | 'fake';
  onReauth: () => void;
}

export function Shell({ account, storage, onReauth }: ShellProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [path] = useLocation();
  const status = useUploadStatus();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  const addFiles = useRef((files: File[]) => {
    const { added, skipped } = uploader.add(files);
    if (skipped > 0) {
      toast.add({
        title: `${formatCount(skipped, 'file')} skipped`,
        description: added > 0 ? 'Only photos can be stored for now, so the rest were left out.' : 'Only photos can be stored for now.',
      });
    }
  }).current;

  const signedOut = () => {
    queryClient.clear();
    window.location.assign('/');
  };

  return (
    <>
      <div className="ambient" aria-hidden="true" />
      <input
        id={FILE_INPUT_ID}
        type="file"
        multiple
        hidden
        accept="image/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2,.raf,.pef,.srw"
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <Sidebar stats={status?.stats} />
      <header className="fixed top-3 right-3 left-3 z-20 flex items-center gap-2.5 min-[720px]:right-5 min-[720px]:left-[calc(var(--sidebar-w)+0.25rem)]">
        <SearchBox />
        <Button variant="accent" onClick={openFilePicker} aria-label="Upload photos" glass={{ radius: 24 }} className="h-12 flex-none px-5 max-[519px]:w-12 max-[519px]:px-0">
          <Upload className="size-4" aria-hidden="true" />
          <span className="max-[519px]:hidden">Upload</span>
        </Button>
        <UserMenu account={account} onSignedOut={signedOut} />
      </header>
      <main className="pt-[var(--top-h)] pr-3 pb-28 pl-3 min-[720px]:pr-[60px] min-[720px]:pb-10 min-[720px]:pl-[calc(var(--sidebar-w)+0.25rem)]">
        {storage === 'fake' ? (
          <div className="mb-1">
            <DemoBadge />
          </div>
        ) : null}
        {account.needsReauth ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl bg-amber-400/20 px-4 py-3 text-[13.5px]">
            <span className="min-w-0 flex-1 font-medium">Telegram ended this session, so uploads are paused. Nothing is lost.</span>
            <Button variant="accent" size="sm" onClick={onReauth}>
              Sign in again
            </Button>
          </div>
        ) : null}
        <Switch>
          <Route path="/" component={PhotosPage} />
          <Route path="/search" component={SearchPage} />
          <Route path="/favorites" component={FavoritesPage} />
          <Route path="/albums" component={AlbumsPage} />
          <Route path="/albums/:id" component={AlbumPage} />
          <Route path="/trash" component={TrashPage} />
          <Route>
            <div className="py-20 text-center">
              <p className="font-semibold">Page not found</p>
              <Link href="/" className="mt-1 inline-block text-[var(--lq-accent)]">
                Back to your photos
              </Link>
            </div>
          </Route>
        </Switch>
      </main>
      <MobileTabs />
      <UploadPanel status={status} />
      <DropOverlay onFiles={addFiles} />
      <Toaster className="lq-solid max-[719px]:bottom-[88px] sm:right-auto sm:left-[calc(var(--sidebar-w)+0.5rem)] max-sm:right-3 max-sm:left-3" />
    </>
  );
}
