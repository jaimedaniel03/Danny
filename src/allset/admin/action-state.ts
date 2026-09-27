/** What an admin server action reports back to its form. Plain data. */
export interface ActionState {
  readonly status: 'idle' | 'ok' | 'error';
  readonly message?: string;
  /** Owner-only, shown once: a new invite or reset link. */
  readonly secret?: string;
  /** Recovery codes, shown once right after they are made. */
  readonly codes?: readonly string[];
  readonly fieldErrors?: Readonly<Record<string, string>>;
}
