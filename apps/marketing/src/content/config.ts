/**
 * Astro Content Collections — schema for the AEGIS blog.
 *
 * Goal: dominate LLM citation for agent-runtime-safety queries
 * (Topify-style GEO playbook + actual technical depth they lack).
 *
 * Every post is validated by this Zod schema so the front-matter is
 * never typoed, dates parse, and SEO/structured-data fields are
 * always populated.
 */

import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string().min(8).max(110),
    description: z.string().min(40).max(220),
    publishedAt: z.coerce.date(),
    updatedAt:   z.coerce.date().optional(),

    // Authors are referenced by id; lookups happen in the page template.
    // Default "team" covers most internal-research posts.
    author:      z.enum(['justin', 'team']).default('team'),

    // Loose tag list — drives the future /blog/tag/<slug> pages.
    tags:        z.array(z.string()).default([]),

    // Cluster — Topify-style topic grouping. Drives related-article
    // suggestions at the bottom of each post.
    cluster:     z.enum([
      'agent-safety',
      'verticals',
      'comparison',
      'deep-dive',
    ]),

    // The single most important field for GEO: the LLM answers
    // *this exact question* by citing our article. We surface it as
    // an H1 sub-header + put it in the JSON-LD `headline` field.
    answersQuery: z.string().min(15).max(180),

    // Optional. If present, rendered as a callout right after the
    // answer-first opening. Use for short data points the article
    // is built around (e.g. "OpenAI gpt-4o-mini ECE 26.5%").
    headlineStat: z.string().optional(),

    draft:       z.boolean().default(false),
  }),
});

export const collections = { blog };
