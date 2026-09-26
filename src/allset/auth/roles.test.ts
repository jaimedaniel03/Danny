import { describe, expect, it } from 'vitest';
import { can, canAssign, canEditLead, canViewLead, type OwnerPermission } from './roles';

const owner = { id: 'o', role: 'owner' as const };
const staff = { id: 's', role: 'staff' as const };
const other = 'x';

const OWNER_ONLY: OwnerPermission[] = [
  'lead.viewAll', 'lead.delete', 'lead.export', 'lead.reassign', 'staff.manage', 'alerts.manage', 'audit.view', 'launch.view',
];

describe('role matrix', () => {
  it.each(OWNER_ONLY)('grants %s to owners only', (permission) => {
    expect(can(owner, permission)).toBe(true);
    expect(can(staff, permission)).toBe(false);
  });

  it('lets staff see their own and unassigned leads, never a colleague’s', () => {
    expect(canViewLead(staff, { assignedTo: 's' })).toBe(true);
    expect(canViewLead(staff, { assignedTo: null })).toBe(true);
    expect(canViewLead(staff, { assignedTo: other })).toBe(false);
    expect(canViewLead(owner, { assignedTo: other })).toBe(true);
  });

  it('lets staff edit only leads assigned to them', () => {
    expect(canEditLead(staff, { assignedTo: 's' })).toBe(true);
    expect(canEditLead(staff, { assignedTo: null })).toBe(false);
    expect(canEditLead(staff, { assignedTo: other })).toBe(false);
    expect(canEditLead(owner, { assignedTo: null })).toBe(true);
  });

  it('lets staff claim unassigned leads and release their own, nothing else', () => {
    expect(canAssign(staff, { assignedTo: null }, 's')).toBe(true);
    expect(canAssign(staff, { assignedTo: 's' }, null)).toBe(true);
    expect(canAssign(staff, { assignedTo: null }, other)).toBe(false);
    expect(canAssign(staff, { assignedTo: other }, 's')).toBe(false);
    expect(canAssign(staff, { assignedTo: 's' }, other)).toBe(false);
    expect(canAssign(owner, { assignedTo: other }, 's')).toBe(true);
  });
});
