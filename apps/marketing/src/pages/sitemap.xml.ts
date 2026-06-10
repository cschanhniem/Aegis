// Sitemap for SEO. Auto-emits every page under src/pages/*.astro with
// lastmod = build time. Re-built on every Cloudflare Pages deploy.
import type { APIRoute } from 'astro';

const SITE = 'https://aegis.dev';

const pages = [
  { path: '/',         priority: '1.0', changefreq: 'weekly'  },
  { path: '/pricing',  priority: '0.9', changefreq: 'monthly' },
];

export const GET: APIRoute = () => {
  const now = new Date().toISOString().split('T')[0];
  const urls = pages.map(p => `  <url>
    <loc>${SITE}${p.path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
