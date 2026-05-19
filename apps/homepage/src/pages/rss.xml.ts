import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { sortedPosts } from '@/data/posts';

export async function GET(context: APIContext) {
  return rss({
    title: 'Aojie Yuan — Writing',
    description:
      "Notes on agent safety, runtime systems, and the messy middle of ML engineering.",
    site: context.site ?? 'https://aojieyuan.com',
    items: sortedPosts.map((post) => ({
      title: post.title,
      pubDate: new Date(post.date),
      description: post.description,
      link: `/writing/${post.slug}/`,
    })),
    customData: '<language>en-us</language>',
  });
}
