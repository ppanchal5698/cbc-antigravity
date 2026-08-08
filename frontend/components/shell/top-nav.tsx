'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

const SURFACES = [
  { href: '/', label: 'Overview' },
  { href: '/chat', label: 'Chat' },
  { href: '/projects', label: 'Projects' },
  { href: '/shelf', label: 'Shelf' },
  { href: '/sheets', label: 'Sheets' },
  { href: '/memory', label: 'Memory' },
  { href: '/downloads', label: 'Downloads' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Polls the gateway so a dropped Antigravity connection is visible, not silent. */
function useGatewayStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        const body = (await response.json()) as { ok?: boolean };
        if (!cancelled) setOk(Boolean(body.ok));
      } catch {
        if (!cancelled) setOk(false);
      }
    };
    void check();
    const timer = setInterval(check, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return ok;
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      disabled={!mounted}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="t-label hover:text-ink cursor-pointer transition-colors disabled:cursor-wait disabled:opacity-50"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      Theme · {mounted ? (dark ? 'Dark' : 'Light') : '…'}
    </button>
  );
}

function AgentStatus({ ok }: { ok: boolean | null }) {
  const label = ok === null ? 'Agent…' : ok ? 'Agent online' : 'Agent offline';
  return (
    <span
      role="status"
      aria-live="polite"
      className="t-label hidden cursor-default items-center gap-1.5 select-none md:flex"
      title={
        ok === null
          ? 'Checking the Antigravity gateway'
          : ok
            ? 'Antigravity gateway reachable'
            : 'Antigravity gateway unreachable'
      }
    >
      <span
        className={cn(
          'size-1.5',
          ok === null ? 'bg-ink-muted' : ok ? 'bg-signal' : 'bg-alert',
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const gatewayOk = useGatewayStatus();

  return (
    <header className="border-rule bg-paper sticky top-0 z-40 border-b">
      <div className="mx-auto flex h-12 w-full max-w-[1600px] items-stretch gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 no-underline">
          <span className="text-[15px] font-semibold tracking-[-0.02em]">CBC</span>
          <span className="bg-rule h-3.5 w-px" aria-hidden />
          <span className="t-label hidden sm:inline">Estimating</span>
        </Link>

        <nav className="scroll-x flex min-w-0 flex-1 items-stretch gap-5" aria-label="Surfaces">
          {SURFACES.map((surface) => {
            const active = isActive(pathname, surface.href);
            return (
              <Link
                key={surface.href}
                href={surface.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center text-[13px] whitespace-nowrap no-underline transition-colors',
                  active ? 'text-ink font-medium' : 'text-ink-muted hover:text-ink',
                )}
              >
                {surface.label}
                {active ? (
                  <span className="bg-signal absolute inset-x-0 -bottom-px h-0.5" aria-hidden />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-4">
          <AgentStatus ok={gatewayOk} />
          <span className="bg-rule hidden h-3.5 w-px md:block" aria-hidden />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
