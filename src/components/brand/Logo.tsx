import Link from 'next/link';
import { Mark } from './Mark';
import styles from './Logo.module.css';

interface LogoProps {
  readonly tone?: 'ink' | 'paper';
  readonly href?: string;
}

export function Logo({ tone = 'ink', href = '/' }: LogoProps) {
  return (
    <Link href={href} className={`${styles.logo} ${tone === 'paper' ? styles.paper : ''}`}>
      <Mark size={36} tone={tone} className={styles.mark} />
      <span className={styles.word}>All Set Check</span>
      {href === '/' ? <span className="visually-hidden">, home</span> : null}
    </Link>
  );
}
