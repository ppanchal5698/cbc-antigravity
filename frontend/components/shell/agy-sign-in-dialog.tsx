'use client';

import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn?: () => void;
};

type Phase = 'idle' | 'starting' | 'awaiting-code' | 'submitting' | 'done';

export function AgySignInDialog({ open, onOpenChange, onSignedIn }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const start = async () => {
      setPhase('starting');
      setError(null);
      setUrl(null);
      setCode('');
      try {
        const response = await fetch('/api/auth/start', { method: 'POST' });
        const body = (await response.json()) as {
          url?: string;
          signedIn?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error || `Sign-in failed (${response.status})`);
          setPhase('idle');
          return;
        }
        if (body.signedIn) {
          setPhase('done');
          onSignedIn?.();
          toast.success('Antigravity is already signed in');
          onOpenChange(false);
          return;
        }
        if (!body.url) {
          setError('No OAuth URL returned from the agent');
          setPhase('idle');
          return;
        }
        setUrl(body.url);
        setPhase('awaiting-code');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('idle');
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
    // Only re-run when the dialog opens — not when parent callbacks identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [open]);

  const close = async (next: boolean) => {
    if (!next && (phase === 'starting' || phase === 'awaiting-code' || phase === 'submitting')) {
      void fetch('/api/auth/cancel', { method: 'POST' }).catch(() => {});
    }
    if (!next) {
      setPhase('idle');
      setUrl(null);
      setCode('');
      setError(null);
    }
    onOpenChange(next);
  };

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Authorization URL copied');
    } catch {
      toast.error('Could not copy URL');
    }
  };

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Paste the authorization code from Google');
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const response = await fetch('/api/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const body = (await response.json()) as {
        signedIn?: boolean;
        error?: string;
      };
      if (!response.ok || !body.signedIn) {
        setError(body.error || `Could not complete sign-in (${response.status})`);
        setPhase('awaiting-code');
        return;
      }
      setPhase('done');
      toast.success('Antigravity signed in');
      onSignedIn?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('awaiting-code');
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>Sign in to Antigravity</DialogTitle>
          <DialogDescription>
            Open the Google authorization URL, approve access, then paste the code
            back here. Credentials stay in the agent container volume.
          </DialogDescription>
        </DialogHeader>

        {phase === 'starting' ? (
          <div className="text-ink-muted flex items-center gap-2 text-[13px]">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Starting sign-in session…
          </div>
        ) : null}

        {url ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-muted text-[12px]">Authorization URL</p>
            <div className="bg-sunken border-rule rounded-md border p-2">
              <p className="text-ink break-all font-mono text-[11px] leading-relaxed">{url}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => window.open(url, '_blank')}>
                <ExternalLink className="size-3.5" aria-hidden />
                Open in browser
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyUrl()}>
                <Copy className="size-3.5" aria-hidden />
                Copy URL
              </Button>
            </div>
          </div>
        ) : null}

        {phase === 'awaiting-code' || phase === 'submitting' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="agy-auth-code" className="text-ink-muted text-[12px]">
              Authorization code
            </label>
            <Input
              id="agy-auth-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code from Google"
              autoComplete="off"
              spellCheck={false}
              disabled={phase === 'submitting'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
        ) : null}

        {error ? (
          <p className="text-alert text-[12px]" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void close(false)}>
            Cancel
          </Button>
          {(phase === 'awaiting-code' || phase === 'submitting') && (
            <Button type="button" disabled={phase === 'submitting' || !code.trim()} onClick={() => void submit()}>
              {phase === 'submitting' ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Completing…
                </>
              ) : (
                'Submit code'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
