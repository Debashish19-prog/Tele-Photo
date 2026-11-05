import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, stopEngine } from '@/api';
import { LoginScreen } from '@/components/LoginScreen';
import { Shell } from '@/components/Shell';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/useTheme';
import { holdTabLock, type TabLockState } from '@/lib/tabLock';

const TAKE_OVER_KEY = 'tele-photo-take-over';

function OtherTabNotice({ moved }: { moved: boolean }) {
  return (
    <>
      <div className="ambient" />
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="text-base font-semibold">{moved ? 'Tele-Photo moved to another tab' : 'Tele-Photo is open in another tab'}</p>
          <p className="text-[var(--lq-text-dim)]">It runs in one tab at a time. Using it here stops anything the other tab is uploading.</p>
          <Button
            variant="accent"
            onClick={() => {
              try {
                sessionStorage.setItem(TAKE_OVER_KEY, '1');
              } catch {
                // Without storage the reload just asks again.
              }
              window.location.reload();
            }}
          >
            Use it here
          </Button>
        </div>
      </div>
    </>
  );
}

export function App() {
  useTheme();
  const [tab, setTab] = useState<TabLockState>('waiting');
  const lock = useRef<(() => void) | null>(null);

  useEffect(() => {
    let takeOver = false;
    try {
      takeOver = sessionStorage.getItem(TAKE_OVER_KEY) === '1';
      sessionStorage.removeItem(TAKE_OVER_KEY);
    } catch {
      // Then this is simply not a take-over.
    }
    lock.current ??= holdTabLock(
      (state) => {
        setTab(state);
        if (state === 'moved') void stopEngine();
      },
      { takeOver },
    );
  }, []);

  if (tab === 'waiting') return <div className="ambient" />;
  if (tab === 'elsewhere' || tab === 'moved') return <OtherTabNotice moved={tab === 'moved'} />;
  return <ActiveApp />;
}

function ActiveApp() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const [reauth, setReauth] = useState(false);

  if (session.isPending) return <div className="ambient" />;

  if (session.isError) {
    return (
      <>
        <div className="ambient" />
        <div className="grid min-h-dvh place-items-center p-6 text-center">
          <div>
            <p className="text-base font-semibold">Tele-Photo couldn't start in this browser</p>
            <p className="mt-1 text-[var(--lq-text-dim)]">It keeps its index in browser storage, which private windows often block. Try a normal window, then reload this page.</p>
          </div>
        </div>
      </>
    );
  }

  const { account, storage, configured } = session.data;
  if (!account || reauth) {
    return (
      <LoginScreen
        storage={storage}
        configured={configured}
        reason={reauth ? 'Telegram ended this session. Sign in again to keep uploading.' : undefined}
        onSignedIn={() => {
          setReauth(false);
          void session.refetch();
        }}
      />
    );
  }
  return <Shell account={account} storage={storage} onReauth={() => setReauth(true)} />;
}
