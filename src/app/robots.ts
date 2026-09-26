import type { MetadataRoute } from 'next';
import { publicBaseUrl, siteIndexable } from '@/allset/env';
import { isLaunchReady } from '@/allset/content/facts';

/**
 * Before launch (or if any required business fact is unverified), ask every
 * crawler to stay out. After launch, keep them out of the private and
 * token-bearing paths only.
 */
export default function robots(): MetadataRoute.Robots {
  const base = publicBaseUrl() ?? 'http://localhost:3000';
  if (!siteIndexable() || !isLaunchReady()) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api', '/consent'] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
