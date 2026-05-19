import type { APIContext } from 'astro';
import { sortedPosts } from '@/data/posts';

/**
 * Hand-rolled sitemap (5–10 URLs total — not worth pulling in
 * @astrojs/sitemap). Posts are auto-included via the shared data module.
 */
export async function GET(context: APIContext) {
  const site = context.site?.toString().replace(/\/$/, '') ?? 'https://aojieyuan.com';
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls: { loc: string; lastmod?: string; priority?: number }[] = [
    { loc: `${site}/`, lastmod: today, priority: 1.0 },
    { loc: `${site}/writing`, lastmod: today, priority: 0.8 },
    { loc: `${site}/now`, lastmod: today, priority: 0.7 },
  ];

  const postUrls = sortedPosts.map((p) => ({
    loc: `${site}/writing/${p.slug}/`,
    lastmod: p.date,
    priority: 0.6,
  }));

  const urls = [...staticUrls, ...postUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    ${u.priority !== undefined ? `<priority>${u.priority.toFixed(1)}</priority>` : ''}
  </url>`,
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
