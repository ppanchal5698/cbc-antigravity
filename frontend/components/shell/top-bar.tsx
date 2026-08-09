'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Menu, Moon, Search, Sun, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const MOBILE_NAV = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/chat', label: 'Chat' },
  { href: '/downloads', label: 'Downloads' },
  { href: '/shelf', label: 'Shelf' },
  { href: '/sheets', label: 'Sheets' },
  { href: '/memory', label: 'Memory' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

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
  // The resolved theme is only known in the browser, so the button renders inert until
  // hydration. `useSyncExternalStore` says exactly that - server snapshot false, client
  // snapshot true - without a setState-in-effect that only ever fires once.
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

function AgentStatus({ ok }: { ok: boolean | null }) {
  const label = ok === null ? 'Checking…' : ok ? 'Agent online' : 'Agent offline';
  return (
    <span
      role="status"
      aria-live="polite"
      className="text-ink-muted hidden items-center gap-1.5 text-[12px] select-none sm:flex"
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
          'size-1.5 rounded-full',
          ok === null ? 'bg-ink-muted' : ok ? 'bg-signal' : 'bg-alert',
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}

function projectContext(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export function TopBar() {
  const pathname = usePathname();
  const gatewayOk = useGatewayStatus();
  const [mobileOpen, setMobileOpen] = useState(false);
  const projectId = projectContext(pathname);

  return (
    <header className="border-rule bg-panel sticky top-0 z-40 border-b">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-5">
        <button
          type="button"
          className="hover:bg-sunken text-ink-muted inline-flex size-8 items-center justify-center rounded-md md:hidden"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMobileOpen((o) => !o)}
        >
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>

        <Link href="/" className="flex items-center gap-2 no-underline md:hidden">
          <span className="bg-signal text-primary-foreground flex size-7 items-center justify-center rounded-md text-[11px] font-semibold">
            CBC
          </span>
        </Link>

        <div className="min-w-0 flex-1">
          {projectId ? (
            <p className="text-ink-muted truncate text-[12px]">
              Project{' '}
              <Link
                href={`/projects/${projectId}`}
                className="text-ink font-medium no-underline hover:underline"
              >
                <span className="font-mono text-[12px]">{projectId.slice(0, 8)}…</span>
              </Link>
            </p>
          ) : (
            <p className="text-ink-muted hidden text-[12px] md:block">Commercial estimating workspace</p>
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

        <AgentStatus ok={gatewayOk} />
        <ThemeToggle />
      </div>

      {mobileOpen ? (
        <nav className="border-rule bg-panel border-t px-3 py-2 md:hidden" aria-label="Mobile">
          <ul className="space-y-0.5">
            {MOBILE_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-2 text-[13px] no-underline',
                      active ? 'bg-signal-wash text-signal font-medium' : 'text-ink-muted',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
