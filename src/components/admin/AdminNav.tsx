'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  readonly href: string;
  readonly label: string;
}

export function AdminNav({ items }: { readonly items: readonly Item[] }) {
  const pathname = usePathname() ?? '/admin';
  return (
    <nav aria-label="Lead desk" className="admin-nav">
      {items.map((item) => {
        const current = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? 'page' : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
