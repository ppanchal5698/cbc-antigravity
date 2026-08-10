'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessageSquare,
  FolderKanban,
  Download,
  BookOpen,
  FileText,
  Network,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChrome } from '@/components/shell/chrome-context';

export const WORK: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/downloads', label: 'Downloads', icon: Download },
  { href: '/', label: 'Overview', icon: LayoutDashboard },
];

export const REFERENCE: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/shelf', label: 'Shelf', icon: BookOpen },
  { href: '/sheets', label: 'Sheets', icon: FileText },
  { href: '/memory', label: 'Memory', icon: Network },
];

export function isNavActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavGroup({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label: string;
  items: typeof WORK;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="px-2.5">
      <p className="t-label mb-1.5 px-2.5">{label}</p>
      <ul className="relative space-y-0.5">
        {items.map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="relative">
              {active ? (
                <span
                  className="bg-signal absolute top-1 bottom-1 left-0 w-[3px] rounded-r-sm transition-transform duration-150"
                  aria-hidden
                />
              ) : null}
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] no-underline transition-colors duration-100',
                  active
                    ? 'bg-signal-wash text-signal font-medium'
                    : 'text-ink-muted hover:bg-sunken/80 hover:text-ink',
                )}
              >
                <Icon className="size-4 shrink-0 opacity-80" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="desk-chrome border-rule hidden w-[14.5rem] shrink-0 flex-col border-r md:flex">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Link href="/projects" className="flex items-center gap-2.5 no-underline">
          <span className="bg-signal text-primary-foreground flex size-7 items-center justify-center rounded-md text-[11px] font-semibold tracking-wide">
            CBC
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Estimating</span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto py-2" aria-label="Primary">
        <NavGroup label="Work" items={WORK} pathname={pathname} />
        <NavGroup label="Reference" items={REFERENCE} pathname={pathname} />
      </nav>
      <div className="border-rule text-ink-muted border-t px-4 py-3 text-[11px] leading-snug">
        Drafts only — estimator reviews before anything leaves CBC.
      </div>
    </aside>
  );
}

/** Off-canvas drawer for mobile — shares nav with the desktop sidebar. */
export function MobileNavDrawer() {
  const pathname = usePathname();
  const { mobileNavOpen, setMobileNavOpen } = useChrome();

  if (!mobileNavOpen) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
        aria-label="Close menu"
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className="desk-chrome border-rule absolute top-0 bottom-0 left-0 flex w-[16rem] flex-col border-r shadow-[var(--elev-overlay)]">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Link
            href="/projects"
            onClick={() => setMobileNavOpen(false)}
            className="flex items-center gap-2.5 no-underline"
          >
            <span className="bg-signal text-primary-foreground flex size-7 items-center justify-center rounded-md text-[11px] font-semibold tracking-wide">
              CBC
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Estimating</span>
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto py-2" aria-label="Mobile">
          <NavGroup
            label="Work"
            items={WORK}
            pathname={pathname}
            onNavigate={() => setMobileNavOpen(false)}
          />
          <NavGroup
            label="Reference"
            items={REFERENCE}
            pathname={pathname}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </nav>
        <div className="border-rule text-ink-muted border-t px-4 py-3 text-[11px] leading-snug">
          Drafts only — estimator reviews before anything leaves CBC.
        </div>
      </aside>
    </div>
  );
}
