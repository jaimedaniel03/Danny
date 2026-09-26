#!/usr/bin/env bash
# End-to-end run: fresh database → production build → Playwright.
#   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/e2e/run.sh [playwright args]
set -euo pipefail

: "${TEST_DATABASE_ADMIN_URL:?Set TEST_DATABASE_ADMIN_URL to a superuser URL on a disposable Postgres}"
PORT="${E2E_PORT:-3100}"

E2E_DATABASE_URL="$(node scripts/e2e/prepare-db.mjs)"
export E2E_DATABASE_URL
export DATABASE_URL="$E2E_DATABASE_URL"
export APP_SECRET="e2e-only-app-secret-0123456789abcdef0123456789"
export PUBLIC_BASE_URL="http://localhost:${PORT}"
export ADMIN_SETUP_TOKEN="e2e-only-setup-token-0123456789abcdef"
export E2E_SETUP_TOKEN="$ADMIN_SETUP_TOKEN"
export CRON_SECRET="e2e-only-cron-secret-0123456789"
# Email deliberately unconfigured: the suite proves failures are visible.
unset RESEND_API_KEY NOTIFY_FROM RESEND_WEBHOOK_SECRET SITE_INDEXABLE

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  rm -rf .next
  npx next build
fi
npx playwright test "$@"
