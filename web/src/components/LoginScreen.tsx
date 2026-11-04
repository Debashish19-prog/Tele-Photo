import { LiquiGlass } from '@liqui-design/glass';
import { ArrowLeft, ExternalLink, Lock, Send } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { ApiError, api } from '@/api';
import { DemoBadge } from '@/components/DemoBadge';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const SWATCHES = [
  ['#f6a26b', '#d9506a'], ['#7fd1e8', '#3478c9'], ['#ffd76a', '#f08a3c'], ['#9ad98b', '#2f8f6b'], ['#c39bf2', '#6a4fd0'],
  ['#ff9eb0', '#c23f7c'], ['#8bb7f0', '#26408f'], ['#f2e3c0', '#b98a5a'], ['#7fe0c3', '#1c8796'], ['#2f3a57', '#10131f'],
  ['#ffb88a', '#7a3fb8'], ['#b6e36f', '#3b8a3f'], ['#e8eef5', '#9fb2c8'], ['#ff7e6b', '#7a1f3d'],
];

function Mosaic() {
  const tiles = useMemo(
    () =>
      Array.from({ length: 96 }, (_, i) => {
        const swatch = SWATCHES[(i * 7 + (i % 5)) % SWATCHES.length]!;
        return {
          background: `linear-gradient(${(i * 47) % 360}deg, ${swatch[0]}, ${swatch[1]})`,
          gridColumn: i % 11 === 0 ? 'span 2' : undefined,
          gridRow: i % 17 === 0 ? 'span 2' : undefined,
        };
      }),
    [],
  );
  return (
    <div aria-hidden="true" className="fixed inset-0 overflow-hidden bg-[#0e1016]">
      <div className="mosaic">
        {tiles.map((style, i) => (
          <i key={i} style={style} />
        ))}
      </div>
    </div>
  );
}

type Step =
  | { name: 'phone' }
  | { name: 'code'; loginId: string; phone: string; delivery: 'app' | 'other' }
  | { name: 'password'; loginId: string; hint: string };

const CARD_GLASS = { radius: 30, elevated: true, frost: 1, blur: 8, refraction: 90, bezel: 26 } as const;
const FIELD_GLASS = { radius: 14, frost: 0.6 } as const;

interface LoginScreenProps {
  storage: 'telegram' | 'fake';
  configured: boolean;
  reason?: string;
  onSignedIn: () => void;
}

export function LoginScreen({ storage, configured, reason, onSignedIn }: LoginScreenProps) {
  const [step, setStep] = useState<Step>({ name: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>, event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'LOGIN_EXPIRED' || err.code === 'CODE_EXPIRED')) {
        setStep({ name: 'phone' });
        setCode('');
      }
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const submitPhone = (event: FormEvent) =>
    run(async () => {
      const { loginId, delivery } = await api.sendCode(phone);
      setStep({ name: 'code', loginId, phone, delivery });
    }, event);

  const submitCode = (event: FormEvent) =>
    run(async () => {
      if (step.name !== 'code') return;
      const result = await api.submitCode(step.loginId, code);
      if (result.status === 'password') setStep({ name: 'password', loginId: step.loginId, hint: result.hint });
      else onSignedIn();
    }, event);

  const submitPassword = (event: FormEvent) =>
    run(async () => {
      if (step.name !== 'password') return;
      await api.submitPassword(step.loginId, password);
      onSignedIn();
    }, event);

  return (
    <>
      <Mosaic />
      <main className="relative grid min-h-dvh place-items-center p-4">
        <div className="flex w-full max-w-[420px] flex-col items-center gap-3">
          {storage === 'fake' ? <DemoBadge /> : null}
          <LiquiGlass {...CARD_GLASS} className="w-full" contentClassName="p-7">
            <div className="mb-6 flex items-center gap-3">
              <LogoMark size={38} />
              <div>
                <h1 className="text-xl font-bold tracking-tight">Tele-Photo</h1>
                <p className="text-[13px]">Your photos, in your own Telegram</p>
              </div>
            </div>

            {reason ? <p className="mb-4 rounded-xl bg-amber-400/20 px-3 py-2 text-[13px] font-medium">{reason}</p> : null}

            {!configured ? (
              <SetupNeeded />
            ) : step.name === 'phone' ? (
              <form onSubmit={submitPhone} className="flex flex-col gap-3">
                <label htmlFor="tp-phone" className="text-[13px] font-semibold">
                  Your Telegram phone number
                </label>
                <Input
                  id="tp-phone"
                  glass={FIELD_GLASS}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                  type="tel"
                  autoComplete="tel"
                  autoFocus
                  required
                  inputClassName="py-3 text-[15px]"
                />
                <Button type="submit" variant="accent" disabled={busy || !phone.trim()} className="mt-1 w-full justify-center py-2.5">
                  <Send className="size-4" aria-hidden="true" />
                  {busy ? 'Sending code…' : 'Send sign-in code'}
                </Button>
                <p className="mt-1 text-[12.5px] leading-snug">
                  Originals are kept at full quality in a private channel on your account. Thumbnails and search stay on this server.
                </p>
              </form>
            ) : step.name === 'code' ? (
              <form onSubmit={submitCode} className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setStep({ name: 'phone' });
                    setCode('');
                    setError(null);
                  }}
                  className="flex w-fit items-center gap-1 text-[13px] font-medium text-[var(--lq-text-dim)] hover:text-[var(--lq-text)]"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" /> {step.phone}
                </button>
                <label htmlFor="tp-code" className="text-[13px] font-semibold">
                  {step.delivery === 'app' ? 'Enter the code Telegram sent to your app' : 'Enter the code Telegram sent you'}
                </label>
                <Input
                  id="tp-code"
                  glass={FIELD_GLASS}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  inputClassName="py-3 text-center text-xl font-semibold tracking-[0.4em]"
                />
                <Button type="submit" variant="accent" disabled={busy || !code} className="mt-1 w-full justify-center py-2.5">
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              </form>
            ) : (
              <form onSubmit={submitPassword} className="flex flex-col gap-3">
                <label htmlFor="tp-password" className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Lock className="size-3.5" aria-hidden="true" /> Your two-step verification password
                </label>
                <Input
                  id="tp-password"
                  glass={FIELD_GLASS}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  inputClassName="py-3 text-[15px]"
                />
                {step.hint ? <p className="text-[12.5px] text-[var(--lq-text-dim)]">Hint: {step.hint}</p> : null}
                <Button type="submit" variant="accent" disabled={busy || !password} className="mt-1 w-full justify-center py-2.5">
                  {busy ? 'Checking…' : 'Sign in'}
                </Button>
              </form>
            )}

            {error ? (
              <p role="alert" className="mt-3 text-[13px] font-medium text-[var(--lq-danger-text)]">
                {error}
              </p>
            ) : null}
          </LiquiGlass>
        </div>
      </main>
    </>
  );
}

function SetupNeeded() {
  return (
    <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed">
      <p className="font-semibold">One setup step before you can sign in</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5">
        <li>
          Go to{' '}
          <a className="inline-flex items-center gap-0.5 font-semibold text-[var(--lq-accent)] underline" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
            my.telegram.org/apps <ExternalLink className="size-3" aria-hidden="true" />
          </a>{' '}
          and create an app.
        </li>
        <li>
          Copy <code className="font-mono text-[12px]">.env.example</code> to <code className="font-mono text-[12px]">.env</code> and fill in{' '}
          <code className="font-mono text-[12px]">TELEGRAM_API_ID</code> and <code className="font-mono text-[12px]">TELEGRAM_API_HASH</code>.
        </li>
        <li>Restart the server, then reload this page.</li>
      </ol>
    </div>
  );
}
