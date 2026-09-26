import { useId } from 'react';

const TICK = 'M12.5 26.5 L20 34 L42.5 7.5';

interface MarkProps {
  readonly size?: number;
  readonly tone?: 'ink' | 'paper';
  readonly className?: string | undefined;
}

/**
 * The All Set Check mark: a checkbox whose coral tick breaks out past the
 * corner. Decorative wherever it sits next to the name, so it is hidden from
 * assistive tech; the adjacent text carries the meaning.
 */
export function Mark({ size = 40, tone = 'ink', className }: MarkProps) {
  const mask = useId().replace(/:/g, '');
  const box = tone === 'ink' ? 'var(--ink)' : 'var(--paper)';
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path d={TICK} fill="none" stroke="#000" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <rect x="5" y="11" width="30" height="30" rx="7" fill="none" stroke={box} strokeWidth="3.5" mask={`url(#${mask})`} />
      <path d={TICK} fill="none" stroke="var(--coral)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline tick for lists. Decorative. */
export function Tick({ className }: { readonly className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3.5 10.5 L8 15 L17 4.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Arrow({ className }: { readonly className?: string | undefined }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="M2 9h13M10 4l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
