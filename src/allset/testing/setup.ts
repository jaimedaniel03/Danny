import { inject } from 'vitest';

const url = inject('allsetDatabaseUrl');
if (url) process.env['DATABASE_URL'] = url;
const adminUrl = inject('allsetAdminUrl');
if (adminUrl) process.env['ALLSET_TEST_ADMIN_URL'] = adminUrl;

// Deterministic, test-only secrets. Real values come from the deployment.
process.env['APP_SECRET'] ??= 'test-only-app-secret-0123456789abcdef-0123456789';
process.env['PUBLIC_BASE_URL'] ??= 'https://allset.test';
