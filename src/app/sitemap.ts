import type { MetadataRoute } from 'next';
import { publicBaseUrl } from '@/allset/env';

const ROUTES = [
  { path: '/', priority: 1 },
  { path: '/coverage', priority: 0.9 },
  { path: '/contact', priority: 0.8 },
  { path: '/story', priority: 0.6 },
  { path: '/team', priority: 0.6 },
  { path: '/privacy', priority: 0.3 },
  { path: '/terms', priority: 0.3 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicBaseUrl() ?? 'http://localhost:3000';
  const lastModified = new Date('2026-09-26');
  return ROUTES.map((route) => ({
    url: `${base}${route.path === '/' ? '' : route.path}`,
    lastModified,
    changeFrequency: 'monthly',
    priority: route.priority,
  }));
}
