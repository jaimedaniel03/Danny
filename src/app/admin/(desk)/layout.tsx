import type { ReactNode } from 'react';
import Link from 'next/link';
import { Mark } from '@/components/brand/Mark';
import { AdminNav } from '@/components/admin/AdminNav';
import { requireActor } from '@/allset/auth/session-cookie';
import { can } from '@/allset/auth/roles';
import { signOutAction } from '@/allset/admin/actions';

/**
 * The signed-in shell. Checking the session here gives a fast redirect, but
 * it is not the control: every page and action checks again on its own.
 */
export default async function DeskLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();
  const items = [
    { href: '/admin', label: 'Today' },
    { href: '/admin/leads', label: 'Leads' },
    ...(can(actor, 'staff.manage') ? [{ href: '/admin/team', label: 'Team' }] : []),
    ...(can(actor, 'alerts.manage') ? [{ href: '/admin/alerts', label: 'Alerts' }] : []),
    ...(can(actor, 'audit.view') ? [{ href: '/admin/audit', label: 'Audit log' }] : []),
    ...(can(actor, 'launch.view') ? [{ href: '/admin/launch', label: 'Launch checklist' }] : []),
    { href: '/admin/account', label: 'Account' },
  ];

  return (
    <>
      <a href="#admin-main" className="skip-link">
        Skip to main content
      </a>
      <header className="admin-bar">
        <div className="container admin-bar__inner">
          <Link href="/admin" className="target admin-bar__brand">
            <Mark size={30} tone="paper" />
            Lead desk
          </Link>
          <AdminNav items={items} />
          <div className="admin-user">
            <span>
              {actor.displayName} · {actor.role === 'owner' ? 'Owner' : 'Staff'}
            </span>
            <form action={signOutAction}>
              <button type="submit" className="btn btn--outline-light">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="admin-main" tabIndex={-1} className="admin-main">
        <div className="container">{children}</div>
      </main>
    </>
  );
}
