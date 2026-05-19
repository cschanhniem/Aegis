/**
 * Single source of truth for /writing entries.
 * Imported by writing/index.astro for the list page and rss.xml.ts for the feed.
 */

export interface Post {
  slug: string;
  title: string;
  date: string; // ISO date
  description: string;
}

export const posts: Post[] = [
  {
    slug: 'aegis-fail-safe-dsl',
    title: 'Why the AEGIS Policy DSL refuses to relax defaults',
    date: '2026-05-18',
    description:
      'The single design decision that decides whether your agent-security product survives a SOC 2 audit.',
  },
  {
    slug: 'guardrail-landscape-2026',
    title: 'The agent-guardrail landscape, 2026',
    date: '2026-05-15',
    description:
      'Lakera at Cisco. Protect AI at Palo Alto. Meta open-sourced its own. The shape of the market, and where open-source still has a seat.',
  },
];

export const sortedPosts = [...posts].sort(
  (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
);
