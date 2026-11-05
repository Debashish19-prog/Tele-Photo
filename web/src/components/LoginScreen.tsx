import { LiquiGlass } from '@liqui-design/glass';
import { ChevronLeft, ExternalLink, Lock } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useState } from 'react';
import { ApiError, api } from '@/api';
import peaks from '@/assets/sign-in-peaks.webp';
import { DemoBadge } from '@/components/DemoBadge';
import { LogoGlyph } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { FLIGHT, QUICK } from '@/lib/motion';
import { cn } from '@/lib/utils';

type Step =
  | { name: 'phone' }
  | { name: 'code'; loginId: string; phone: string; delivery: 'app' | 'other' }
  | { name: 'password'; loginId: string; hint: string };

const STEP = {
  initial: { opacity: 0, x: 18 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -18 },
  transition: QUICK,
};

/**
 * Movement only, with no fade. Anything below 1 opacity on an ancestor cuts the glass off from the
 * photo behind it, so a fade would show a flat tint and then pop into refraction as it finished.
 */
const RISE = { initial: { y: 22, scale: 0.975 }, animate: { y: 0, scale: 1 }, transition: FLIGHT };

const CARD_GLASS = { radius: 84, elevated: true, frost: 0.34, blur: 2, refraction: 190, bezel: 42, specular: 1, saturation: 1.3 } as const;
const PILL_GLASS = { radius: 36, frost: 0.28, blur: 2, refraction: 90, bezel: 22, specular: 1, saturation: 1.2 } as const;

/** The photo fades in over a matching gradient, so a slow connection never shows a blank page. */
function Wallpaper() {
  const [loaded, setLoaded] = useState(false);
  return (
    <div aria-hidden="true" className="login-wallpaper">
      <img src={peaks} alt="" decoding="async" data-loaded={loaded} onLoad={() => setLoaded(true)} />
    </div>
  );
}

interface GlassCardProps {
  id: string;
  /** The two halves of the small line at the top of the card. */
  eyebrow: [string, string];
  title: ReactNode;
  onBack?: () => void;
  /** How far through sign-in this is, as dots. A setup message has no such thing. */
  progress?: { at: number; of: number };
  children: ReactNode;
}

function GlassCard({ id, eyebrow, title, onBack, progress, children }: GlassCardProps) {
  return (
    <motion.div className="w-full" {...RISE}>
      <LiquiGlass {...CARD_GLASS} className="w-full" contentClassName="login-card">
        <p className="login-eyebrow">
          {eyebrow[0]}: <span>{eyebrow[1]}</span>
        </p>

        <div className="relative my-[clamp(10px,3vh,30px)] flex w-full justify-center">
          {onBack ? (
            <button type="button" onClick={onBack} aria-label="Change phone number" className="login-back">
              <ChevronLeft className="size-[18px]" aria-hidden="true" />
            </button>
          ) : null}
          <span className="login-disc">
            <LogoGlyph />
            <span className="login-badge">
              <Lock className="size-[13px]" strokeWidth={2.75} aria-hidden="true" />
            </span>
          </span>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={id} {...STEP} className="flex w-full flex-col items-center">
            <h1 className="login-title">{title}</h1>
            <div className="login-copy">{children}</div>
          </motion.div>
        </AnimatePresence>

        {progress ? (
          <div role="img" aria-label={`Step ${progress.at + 1} of ${progress.of}`} className="login-dots">
            {Array.from({ length: progress.of }, (_, i) => (
              <i key={i} data-active={i === progress.at} />
            ))}
          </div>
        ) : null}
      </LiquiGlass>
    </motion.div>
  );
}

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

  // Telegram only reveals a two-step password once the code is in, so that dot appears when it does.
  const view =
    step.name === 'phone'
      ? {
          title: (
            <>
              Your photos,
              <br />
              your Telegram
            </>
          ),
          progress: { at: 0, of: 2 },
          label: 'Enter your Telegram phone number to get a sign-in code.',
          note: null,
          submit: submitPhone,
          action: busy ? 'Sending…' : 'Send code',
          field: {
            value: phone,
            onChange: (e) => setPhone(e.target.value),
            placeholder: '+1 555 123 4567',
            type: 'tel',
            autoComplete: 'tel',
            // Spaces alone would pass `required`, and Telegram can do nothing with them.
            pattern: '.*\\d.*',
            title: 'Your phone number, with its country code',
          } satisfies InputHTMLAttributes<HTMLInputElement>,
        }
      : step.name === 'code'
        ? {
            title: (
              <>
                Check your
                <br />
                Telegram
              </>
            ),
            progress: { at: 1, of: 2 },
            label: `Enter the code Telegram sent ${step.delivery === 'app' ? 'to your app' : 'you'} for ${step.phone}.`,
            note: null,
            submit: submitCode,
            action: busy ? 'Checking…' : 'Continue',
            field: {
              value: code,
              onChange: (e) => setCode(e.target.value.replace(/\D/g, '')),
              placeholder: 'Code',
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              className: 'font-semibold tracking-[0.3em] placeholder:font-medium placeholder:tracking-normal',
            } satisfies InputHTMLAttributes<HTMLInputElement>,
          }
        : {
            title: (
              <>
                One more
                <br />
                step
              </>
            ),
            progress: { at: 2, of: 3 },
            label: 'Enter your two-step verification password.',
            note: step.hint ? `Hint: ${step.hint}` : null,
            submit: submitPassword,
            action: busy ? 'Checking…' : 'Sign in',
            field: {
              value: password,
              onChange: (e) => setPassword(e.target.value),
              placeholder: 'Password',
              type: 'password',
              autoComplete: 'current-password',
            } satisfies InputHTMLAttributes<HTMLInputElement>,
          };

  return (
    <div className="login">
      <Wallpaper />
      <div className="relative flex min-h-dvh flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 sm:px-9 sm:pt-7">
          <span className="login-wordmark">Tele-Photo</span>
          {storage === 'fake' ? <DemoBadge /> : null}
        </header>

        <main className="grid flex-1 grid-cols-[minmax(0,1fr)] place-items-center px-4 py-4">
          {configured ? (
            <form onSubmit={view.submit} className="login-stack">
              {reason ? <p className="login-reason">{reason}</p> : null}

              <GlassCard
                id={step.name}
                eyebrow={['Sign in', 'Telegram']}
                title={view.title}
                progress={view.progress}
                onBack={
                  step.name === 'code'
                    ? () => {
                        setStep({ name: 'phone' });
                        setCode('');
                        setError(null);
                      }
                    : undefined
                }
              >
                <label htmlFor="tp-sign-in">{view.label}</label>
                {view.note ? <p className="mt-1 opacity-85">{view.note}</p> : null}
              </GlassCard>

              <motion.div className="mt-[clamp(10px,1.6vh,16px)] w-full" {...RISE}>
                {/* The focus ring is on the pill, as a ring on the field would be a box inside a capsule. */}
                <LiquiGlass {...PILL_GLASS} className="login-pill lq-round" contentClassName="flex items-center gap-2 p-[7px]">
                  <input
                    {...view.field}
                    // A new element per step, so the browser never offers one step's autofill for another.
                    key={step.name}
                    id="tp-sign-in"
                    autoFocus
                    required
                    className={cn('login-input', view.field.className)}
                  />
                  <Button type="submit" variant="accent" disabled={busy} glass={{ radius: 29 }} className="login-go lq-round">
                    {view.action}
                  </Button>
                </LiquiGlass>
              </motion.div>

              {error ? (
                <motion.p key={error} role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={QUICK} className="login-error">
                  {error}
                </motion.p>
              ) : null}
            </form>
          ) : (
            <div className="login-stack">
              <SetupNeeded />
            </div>
          )}
        </main>

        <footer className="login-footnote">
          Originals are kept at full quality in a private channel on your account. Your browser talks directly to Telegram, and this site never receives your code, password or photos.
        </footer>
      </div>
    </div>
  );
}

function SetupNeeded() {
  return (
    <GlassCard
      id="setup"
      eyebrow={['Setup', 'Needed']}
      title={
        <>
          Almost
          <br />
          ready
        </>
      }
    >
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-left text-[13.5px] leading-snug">
        <li>
          Create an app at{' '}
          <a className="inline-flex items-center gap-0.5 font-semibold underline" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
            my.telegram.org/apps <ExternalLink className="size-3" aria-hidden="true" />
          </a>
          .
        </li>
        <li>
          Set <code className="font-mono text-[12px]">VITE_TELEGRAM_API_ID</code> and <code className="font-mono text-[12px]">VITE_TELEGRAM_API_HASH</code> in your Vercel project's environment variables, or in <code className="font-mono text-[12px]">.env</code> on your own computer.
        </li>
        <li>Build the site again, then reload this page.</li>
      </ol>
    </GlassCard>
  );
}
