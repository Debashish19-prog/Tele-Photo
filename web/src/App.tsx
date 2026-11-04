import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api';
import { LoginScreen } from '@/components/LoginScreen';
import { Shell } from '@/components/Shell';
import { useTheme } from '@/hooks/useTheme';

export function App() {
  useTheme();
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const [reauth, setReauth] = useState(false);

  if (session.isPending) return <div className="ambient" />;

  if (session.isError) {
    return (
      <>
        <div className="ambient" />
        <div className="grid min-h-dvh place-items-center p-6 text-center">
          <div>
            <p className="text-base font-semibold">Can't reach the Tele-Photo server</p>
            <p className="mt-1 text-[var(--lq-text-dim)]">Check that it is running, then reload this page.</p>
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
