import { Logo } from '@/components/brand/Logo';
import { SiteNav } from './SiteNav';
import styles from './SiteHeader.module.css';

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={`container ${styles.bar}`}>
        <Logo />
        <SiteNav />
      </div>
    </header>
  );
}
