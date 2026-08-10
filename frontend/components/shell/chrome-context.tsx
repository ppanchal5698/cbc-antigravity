'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type ChromeContext = {
  title: string | null;
  status: string | null;
  mobileNavOpen: boolean;
  setChrome: (next: { title?: string | null; status?: string | null }) => void;
  setMobileNavOpen: (open: boolean) => void;
};

const Ctx = createContext<ChromeContext | null>(null);

export function ChromeProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const setChrome = useCallback((next: { title?: string | null; status?: string | null }) => {
    if ('title' in next) setTitle(next.title ?? null);
    if ('status' in next) setStatus(next.status ?? null);
  }, []);

  const value = useMemo(
    () => ({ title, status, mobileNavOpen, setChrome, setMobileNavOpen }),
    [title, status, mobileNavOpen, setChrome],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChrome() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useChrome must be used within ChromeProvider');
  return ctx;
}

/** Sets top-bar context while mounted; clears on unmount. */
export function useSetChrome(title: string | null, status?: string | null) {
  const { setChrome } = useChrome();
  useEffect(() => {
    setChrome({ title, status: status ?? null });
    return () => setChrome({ title: null, status: null });
  }, [title, status, setChrome]);
}
