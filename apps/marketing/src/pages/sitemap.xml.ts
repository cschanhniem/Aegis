// Sitemap for SEO. Auto-emits every page under src/pages/*.astro with
// lastmod = build time. Re-built on every Cloudflare Pages deploy.
import type { APIRoute } from 'astro';

const SITE = 'https://aegis.dev';

const pages = [
  { path: '/',                       priority: '1.0', changefreq: 'weekly'  },
  { path: '/pricing',                priority: '0.9', changefreq: 'monthly' },
  { path: '/download',               priority: '0.9', changefreq: 'weekly'  },
  { path: '/signup',                 priority: '0.9', changefreq: 'monthly' },
  { path: '/login',                  priority: '0.5', changefreq: 'monthly' },
  { path: '/features/scanner',           priority: '0.9', changefreq: 'monthly' },
  { path: '/features/policy-generator',  priority: '0.9', changefreq: 'monthly' },
  { path: '/features/predeploy',         priority: '0.9', changefreq: 'monthly' },
  { path: '/features/customize',         priority: '0.9', changefreq: 'monthly' },
  { path: '/docs',                   priority: '0.8', changefreq: 'weekly'  },
  { path: '/docs/self-host',         priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/sdk',               priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/api',               priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/policy-templates',  priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/ontology',          priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/compliance',        priority: '0.7', changefreq: 'monthly' },
  { path: '/security',               priority: '0.8', changefreq: 'monthly' },
  { path: '/status',                 priority: '0.6', changefreq: 'daily'   },
  { path: '/privacy',                priority: '0.4', changefreq: 'yearly'  },
  { path: '/terms',                  priority: '0.4', changefreq: 'yearly'  },
  { path: '/dpa',                    priority: '0.4', changefreq: 'yearly'  },
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
