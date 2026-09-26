import type { FaqItem } from '@/allset/content/faqs';
import styles from './Faq.module.css';

/**
 * Native <details> accordions: keyboard and screen-reader support come from
 * the browser, and every answer is reachable with scripts off.
 */
export function Faq({ items }: { readonly items: readonly FaqItem[] }) {
  return (
    <div className={styles.list}>
      {items.map((item) => (
        <details key={item.id} className={styles.item} id={`faq-${item.id}`}>
          <summary className={styles.question}>
            <span>{item.question}</span>
            <span className={styles.icon} aria-hidden="true" />
          </summary>
          <div className={styles.answer}>{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
