'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A confirmation that has to be heard as well as seen. It renders an empty
 * live region first and fills it after mount (screen readers announce a
 * change, not content that was already there), then moves keyboard focus to
 * it: the control the person used is gone, so focus would otherwise fall
 * back to the top of the page. Without JavaScript the message still renders.
 */
export function FlashStatus({ message }: { readonly message: string }) {
  const [text, setText] = useState('');
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setMounted(true);
    const id = window.setTimeout(() => {
      setText(message);
      ref.current?.focus();
    }, 50);
    return () => window.clearTimeout(id);
  }, [message]);

  return (
    <p ref={ref} tabIndex={-1} className="notice notice--success" role="status" aria-live="polite">
      {mounted ? text : message}
    </p>
  );
}
