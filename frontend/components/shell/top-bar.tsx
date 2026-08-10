'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Menu, Moon, Search, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useChrome } from '@/components/shell/chrome-context';
import { AgySignInDialog } from '@/components/shell/agy-sign-in-dialog';

type GatewayState = {
  ok: boolean | null;
  signedIn: boolean | null;
};

function useGatewayStatus(): GatewayState & { refresh: () => void } {
  const [state, setState] = useState<GatewayState>({ ok: null, signedIn: null });

  const check = useCallback(async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const body = (await response.json()) as { ok?: boolean; signedIn?: boolean };
      setState({ ok: Boolean(body.ok), signedIn: Boolean(body.signedIn) });
    } catch {
      setState({ ok: false, signedIn: false });
    }
  }, []);

  const refresh = useCallback(() => {
    void check();
  }, [check]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await check();
    };
    void run();
    const timer = setInterval(() => {
      void check();
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [check]);

  return { ...state, refresh };
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const dark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      disabled={!mounted}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="hover:bg-sunken text-ink-muted hover:text-ink inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-wait disabled:opacity-50"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {mounted ? (dark ? <Sun className="size-4" /> : <Moon className="size-4" />) : null}
    </button>
  );
}

function AgentStatus({
  ok,
  signedIn,
  onSignIn,
  onLogout,
  loggingOut,
}: {
  ok: boolean | null;
  signedIn: boolean | null;
  onSignIn: () => void;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const offline = ok === false;
  const checking = ok === null;
  const needsSignIn = ok === true && signedIn === false;
  const signedInOk = ok === true && signedIn === true;

  const label = checking
    ? 'Checking…'
    : offline
      ? 'Agent offline'
      : needsSignIn
        ? 'Needs sign-in'
        : 'Signed in';

  const title = checking
    ? 'Checking the Antigravity gateway'
    : offline
      ? 'Antigravity gateway unreachable'
      : needsSignIn
        ? 'Antigravity is reachable but not signed in — click to sign in'
        : 'Antigravity signed in';

  const dotClass = checking
    ? 'bg-ink-muted'
    : offline
      ? 'bg-alert'
      : needsSignIn
        ? 'bg-amber-500'
        : 'bg-signal';

  if (needsSignIn) {
    return (
      <button
        type="button"
        onClick={onSignIn}
        className="text-ink-muted hover:bg-sunken hover:text-ink hidden cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] select-none sm:flex"
        title={title}
        aria-label="Sign in to Antigravity"
      >
        <span className={cn('size-1.5 rounded-full', dotClass)} aria-hidden />
        {label}
      </button>
    );
  }

  if (signedInOk) {
    return (
      <span className="text-ink-muted hidden items-center gap-1 sm:flex">
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 px-2 py-1 text-[12px] select-none"
          title={title}
        >
          <span className={cn('size-1.5 rounded-full', dotClass)} aria-hidden />
          {label}
        </span>
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          className="hover:bg-sunken hover:text-ink cursor-pointer rounded-md px-2 py-1 text-[12px] transition-colors disabled:cursor-wait disabled:opacity-50"
          aria-label="Sign out of Antigravity"
          title="Remove the Antigravity OAuth token from this agent"
        >
          {loggingOut ? 'Signing out…' : 'Log out'}
        </button>
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-live="polite"
      className="text-ink-muted hidden items-center gap-1.5 text-[12px] select-none sm:flex"
      title={title}
    >
      <span className={cn('size-1.5 rounded-full', dotClass)} aria-hidden />
      {label}
    </span>
  );
}

function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export function TopBar() {
  const pathname = usePathname();
  const gateway = useGatewayStatus();
  const { title, status, mobileNavOpen, setMobileNavOpen } = useChrome();
  const projectId = projectIdFromPath(pathname);
  const [signInOpen, setSignInOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast.error(body.error || `Sign-out failed (${response.status})`);
        return;
      }
      toast.success('Signed out of Antigravity');
      gateway.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <header className="desk-chrome border-rule sticky top-0 z-40 border-b">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-5">
        <button
          type="button"
          className="hover:bg-sunken text-ink-muted inline-flex size-8 items-center justify-center rounded-md md:hidden"
          aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
        >
          <Menu className="size-4" />
        </button>

        <Link href="/projects" className="flex items-center gap-2 no-underline md:hidden">
          <span className="bg-signal text-primary-foreground flex size-7 items-center justify-center rounded-md text-[11px] font-semibold">
            CBC
          </span>
        </Link>

        <div className="min-w-0 flex-1">
          {projectId && title ? (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <Link
                href={`/projects/${projectId}`}
                className="text-ink truncate text-[13px] font-medium no-underline hover:underline"
              >
                {title}
              </Link>
              {status ? (
                <span className="text-ink-muted status-fade shrink-0 text-[11px]">{status}</span>
              ) : null}
            </div>
          ) : (
            <p className="text-ink-muted hidden text-[12px] md:block">
              Quote desk — commercial estimating workspace
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
            );
          }}
          className="border-rule text-ink-muted hover:bg-sunken hover:text-ink hidden cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors sm:inline-flex"
          aria-label="Open search"
        >
          <Search className="size-3.5" aria-hidden />
          Search
          <kbd className="bg-sunken rounded px-1 font-mono text-[10px]">⌘K</kbd>
        </button>

        <AgentStatus
          ok={gateway.ok}
          signedIn={gateway.signedIn}
          onSignIn={() => setSignInOpen(true)}
          onLogout={() => void logout()}
          loggingOut={loggingOut}
        />
        <ThemeToggle />
      </div>

      <AgySignInDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onSignedIn={gateway.refresh}
      />
    </header>
  );
}
