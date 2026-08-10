'use client';

import { useEffect } from 'react';
import { Failure } from '@/components/shell/state';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <Failure
        className="w-full max-w-md"
        title="Something went wrong on this desk."
        detail={error.message}
      />
      <button
        type="button"
        onClick={reset}
        className="bg-signal text-primary-foreground hover:bg-signal/90 cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium"
      >
        Try again
      </button>
    </div>
  );
}
