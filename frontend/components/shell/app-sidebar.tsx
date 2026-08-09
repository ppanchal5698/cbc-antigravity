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

const WORK: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/downloads', label: 'Downloads', icon: Download },
];

const REFERENCE: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/shelf', label: 'Shelf', icon: BookOpen },
  { href: '/sheets', label: 'Sheets', icon: FileText },
  { href: '/memory', label: 'Memory', icon: Network },
];

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: typeof WORK;
  pathname: string;
}) {
  return (
    <div className="px-3">
      <p className="t-label mb-1.5 px-2.5">{label}</p>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] no-underline transition-colors',
                  active
                    ? 'bg-signal-wash text-signal font-medium'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink',
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
    <aside className="border-rule bg-panel hidden w-56 shrink-0 flex-col border-r md:flex">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <span className="bg-signal text-primary-foreground flex size-7 items-center justify-center rounded-md text-[11px] font-semibold tracking-wide">
            CBC
          </span>
          <span className="text-[14px] font-semibold tracking-[-0.01em]">Estimating</span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto py-2" aria-label="Primary">
        <NavGroup label="Work" items={WORK} pathname={pathname} />
        <NavGroup label="Reference" items={REFERENCE} pathname={pathname} />
      </nav>
      <div className="border-rule text-ink-muted border-t px-5 py-3 text-[11px] leading-snug">
        Drafts only — estimator reviews before anything leaves CBC.
      </div>
    </aside>
  );
}
