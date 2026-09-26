/**
 * Who may do what. Pure functions, so the whole matrix is unit-tested, and
 * every data-access function takes an Actor and asks these before touching a
 * row — the UI hiding a button is a convenience, never the control.
 *
 *            view lead      edit lead       assign            delete/export/staff/alerts/audit
 *  owner     all            all             anyone            yes
 *  staff     own + unassigned  own only     claim unassigned  no
 *                                           or release own
 */

export type Role = 'owner' | 'staff';

export interface Actor {
  readonly id: string;
  readonly role: Role;
  readonly displayName: string;
  readonly email: string;
  readonly sessionId: string;
}

export type OwnerPermission =
  | 'lead.viewAll'
  | 'lead.delete'
  | 'lead.export'
  | 'lead.reassign'
  | 'staff.manage'
  | 'alerts.manage'
  | 'audit.view'
  | 'launch.view';

export function can(actor: Pick<Actor, 'role'>, permission: OwnerPermission): boolean {
  switch (permission) {
    case 'lead.viewAll':
    case 'lead.delete':
    case 'lead.export':
    case 'lead.reassign':
    case 'staff.manage':
    case 'alerts.manage':
    case 'audit.view':
    case 'launch.view':
      return actor.role === 'owner';
  }
}

export interface LeadAccess {
  readonly assignedTo: string | null;
}

export function canViewLead(actor: Pick<Actor, 'id' | 'role'>, lead: LeadAccess): boolean {
  return actor.role === 'owner' || lead.assignedTo === null || lead.assignedTo === actor.id;
}

export function canEditLead(actor: Pick<Actor, 'id' | 'role'>, lead: LeadAccess): boolean {
  return actor.role === 'owner' || lead.assignedTo === actor.id;
}

export function canAssign(actor: Pick<Actor, 'id' | 'role'>, lead: LeadAccess, target: string | null): boolean {
  if (actor.role === 'owner') return true;
  // Staff may claim an unassigned lead for themselves…
  if (lead.assignedTo === null && target === actor.id) return true;
  // …or hand their own lead back to the unassigned pool.
  if (lead.assignedTo === actor.id && target === null) return true;
  return false;
}

export class PermissionError extends Error {
  constructor(message = 'You don’t have permission to do that.') {
    super(message);
    this.name = 'PermissionError';
  }
}
