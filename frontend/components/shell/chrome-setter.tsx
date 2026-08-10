'use client';

import { useSetChrome } from '@/components/shell/chrome-context';

/** Bridges server-rendered project pages into the top-bar chrome context. */
export function ChromeSetter({
  title,
  status,
}: {
  title: string;
  status?: string | null;
}) {
  useSetChrome(title, status);
  return null;
}
