import { FACTS, BRAND_NAME } from '@/allset/content/facts';
import { publicBaseUrl } from '@/allset/env';

/**
 * Structured data that asserts only what is verified. Until a legal entity
 * and licenses are on record, this is a plain Organization with a name and a
 * URL — not an InsuranceAgency, which would claim a status we can't show.
 */
export function organizationJsonLd(): Record<string, unknown> {
  const base = publicBaseUrl() ?? 'http://localhost:3000';
  const licensed = FACTS.legalEntity !== null && FACTS.licenses.length > 0;
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': licensed ? 'InsuranceAgency' : 'Organization',
    name: BRAND_NAME,
    url: base,
    logo: `${base}/brand/icon-512.png`,
  };
  if (FACTS.legalEntity) data['legalName'] = FACTS.legalEntity.value.name;
  if (FACTS.contact.phone) data['telephone'] = FACTS.contact.phone.value;
  if (FACTS.contact.email) data['email'] = FACTS.contact.email.value;
  if (licensed && FACTS.serviceArea) {
    data['areaServed'] = FACTS.serviceArea.value.states.map((s) => ({ '@type': 'State', name: s }));
  }
  return data;
}

export function JsonLd({ data }: { readonly data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify output with "<" escaped cannot break out of the script element.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
