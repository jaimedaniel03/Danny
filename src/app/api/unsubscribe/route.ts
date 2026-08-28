/**
 * Email unsubscribe.
 *
 * Handles both shapes, and both are required:
 *
 *  - **GET** — someone clicked the link in the footer. Returns a plain
 *    confirmation page.
 *  - **POST** — RFC 8058 one-click unsubscribe, fired by Gmail/Yahoo from their
 *    own UI via the `List-Unsubscribe-Post` header. Returns 200 with no body.
 *    Bulk senders who do not honour this get throttled by the mailbox
 *    providers, which is a faster and more painful consequence than the statute.
 *
 * The suppression is written on the GET too, not just the POST. Making someone
 * click a second "confirm" button is a dark pattern, it is arguably not the
 * "clear and conspicuous" mechanism CAN-SPAM requires, and every extra step is
 * one more chance the opt-out silently fails and they report you as spam
 * instead — which costs far more than the unsubscribe would have.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { verifyUnsubscribeToken } from '@/channels/email';

export const runtime = 'nodejs';

async function suppress(token: string): Promise<boolean> {
  const verdict = verifyUnsubscribeToken(token);
  if (!verdict.valid) return false;

  const { suppressEmail } = await import('@/db/suppressions');
  await suppressEmail({
    emailAddress: verdict.emailAddress,
    contactId: verdict.contactId,
    reason: 'Unsubscribe link',
    source: 'email_unsubscribe',
  });
  return true;
}

/** RFC 8058 one-click. Mailbox providers call this directly; no body expected. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('t');
  if (!token) return new NextResponse(null, { status: 400 });

  try {
    const ok = await suppress(token);
    // 200 either way: a mailbox provider retrying against an invalid token
    // gains nothing, and a non-200 here counts against sender reputation.
    if (!ok) console.warn('[unsubscribe] invalid token on one-click POST');
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    console.error('[unsubscribe] one-click failed', err);
    return new NextResponse(null, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('t');

  let ok = false;
  if (token) {
    try {
      ok = await suppress(token);
    } catch (err) {
      console.error('[unsubscribe] failed', err);
    }
  }

  const agency = process.env['AGENCY_LEGAL_NAME'] ?? 'this agency';
  const body = ok
    ? {
        heading: 'You’re unsubscribed',
        message: `You won’t receive any more emails from ${agency}. If this was a mistake, just reply to any earlier email and we’ll add you back.`,
      }
    : {
        heading: 'We couldn’t process that',
        message: `This unsubscribe link isn’t valid. Reply to any email from ${agency} with the word “unsubscribe” and we’ll take care of it by hand.`,
      };

  return new NextResponse(page(body.heading, body.message), {
    status: ok ? 200 : 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Never index or cache an unsubscribe result — the URL identifies a person.
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}

function page(heading: string, message: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f7fa;color:#15181e;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:1.5rem}
  .card{max-width:30rem;background:#fff;border:1px solid #dde3eb;border-radius:6px;padding:2rem 1.75rem}
  h1{margin:0 0 .75rem;font-size:1.35rem;line-height:1.25}
  p{margin:0;color:#3d4653}
  @media (prefers-color-scheme:dark){
    body{background:#0d1015;color:#e7eaef}
    .card{background:#14181f;border-color:#262c36}
    p{color:#b4bdc9}
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${esc(heading)}</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}
