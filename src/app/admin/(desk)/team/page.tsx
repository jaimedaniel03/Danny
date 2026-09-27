import type { Metadata } from 'next';
import { requireOwnerPage } from '@/allset/auth/session-cookie';
import { FlashStatus } from '@/components/admin/FlashStatus';
import { db } from '@/allset/db/client';
import { listStaff } from '@/allset/auth/accounts';
import { ActionForm, Submit } from '@/components/admin/ActionForm';
import { SecretForm } from '@/components/admin/SecretResult';
import { formatDateTime } from '@/components/admin/format';
import { activeAction, inviteAction, resetMfaAction, resetPasswordAction, roleAction } from '@/allset/admin/actions';

export const metadata: Metadata = { title: 'Team' };

const NOTICES: Record<string, string> = {
  'mfa-reset': 'Two-step sign-in was reset. They were signed out everywhere and will set it up again at their next sign-in.',
};

interface Props {
  readonly searchParams: Promise<{ notice?: string | string[] }>;
}

export default async function TeamPage({ searchParams }: Props) {
  const actor = await requireOwnerPage('staff.manage', '/admin/team');
  const { notice } = await searchParams;
  const noticeText = typeof notice === 'string' ? NOTICES[notice] : undefined;
  const staff = await listStaff(db(), actor);

  return (
    <>
      <h1 className="admin-title">Team</h1>
      <p className="admin-sub">
        Owners manage accounts, alerts, exports and deletions. Staff see requests assigned to them and
        requests nobody has claimed. Every change here is recorded in the audit log.
      </p>
      {noticeText ? <FlashStatus message={noticeText} /> : null}

      <section className="panel" aria-labelledby="invite-title">
        <h2 id="invite-title" className="panel__title">
          Add someone
        </h2>
        <p className="fine-print">
          You’ll get a one-time link to send them. They choose their own password; you never see it.
        </p>
        <SecretForm action={inviteAction} label="Invite a team member">
          <div className="filters">
            <div className="field">
              <label className="field__label" htmlFor="invite-name">
                Name
              </label>
              <input id="invite-name" name="displayName" className="input" autoComplete="off" required />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="invite-email">
                Email
              </label>
              <input id="invite-email" name="email" type="email" className="input" autoComplete="off" required />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="invite-role">
                Role
              </label>
              <select id="invite-role" name="role" className="select" defaultValue="staff">
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <div>
            <button type="submit" className="btn btn--primary">
              Create account and get link
            </button>
          </div>
        </SecretForm>
      </section>

      <section aria-labelledby="people-title">
        <h2 id="people-title" className="panel__title">
          People
        </h2>
        <ul role="list" className="stack">
          {staff.map((member) => {
            const self = member.id === actor.id;
            return (
              <li key={member.id} className="panel">
                <h3 className="panel__title">
                  {member.displayName} {self ? <span className="muted">(you)</span> : null}
                </h3>
                <dl className="dl">
                  <dt>Email</dt>
                  <dd>{member.email}</dd>
                  <dt>Role</dt>
                  <dd>{member.role === 'owner' ? 'Owner' : 'Staff'}</dd>
                  <dt>Status</dt>
                  <dd>
                    {!member.isActive ? 'Deactivated' : member.pendingInvite ? 'Invited — hasn’t set a password yet' : 'Active'}
                  </dd>
                  <dt>Two-step sign-in</dt>
                  <dd>{member.mfaEnabled ? 'On' : 'Not set up yet (required at next sign-in)'}</dd>
                  <dt>Last sign-in</dt>
                  <dd>{member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}</dd>
                  <dt>Open leads</dt>
                  <dd>{member.openLeads}</dd>
                </dl>
                {self ? null : (
                  <div className="inline-form">
                    {member.isActive ? (
                      <>
                        <ActionForm action={roleAction} aria-label={`Change role for ${member.displayName}`}>
                          <input type="hidden" name="staffId" value={member.id} />
                          <input type="hidden" name="role" value={member.role === 'owner' ? 'staff' : 'owner'} />
                          <Submit variant="secondary">{member.role === 'owner' ? 'Make staff' : 'Make owner'}</Submit>
                        </ActionForm>
                        <SecretForm action={resetPasswordAction} label={`Reset password for ${member.displayName}`}>
                          <input type="hidden" name="staffId" value={member.id} />
                          <div>
                            <button type="submit" className="btn btn--secondary">
                              Issue reset link
                            </button>
                          </div>
                        </SecretForm>
                        {member.mfaEnabled ? (
                          <ActionForm action={resetMfaAction} aria-label={`Reset two-step sign-in for ${member.displayName}`}>
                            <input type="hidden" name="staffId" value={member.id} />
                            <Submit variant="secondary" pendingLabel="Resetting…">
                              Reset two-step sign-in
                            </Submit>
                          </ActionForm>
                        ) : null}
                        <ActionForm action={activeAction} aria-label={`Deactivate ${member.displayName}`}>
                          <input type="hidden" name="staffId" value={member.id} />
                          <input type="hidden" name="active" value="false" />
                          <Submit variant="danger">Deactivate</Submit>
                        </ActionForm>
                      </>
                    ) : (
                      <ActionForm action={activeAction} aria-label={`Reactivate ${member.displayName}`}>
                        <input type="hidden" name="staffId" value={member.id} />
                        <input type="hidden" name="active" value="true" />
                        <Submit variant="secondary">Reactivate</Submit>
                      </ActionForm>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
