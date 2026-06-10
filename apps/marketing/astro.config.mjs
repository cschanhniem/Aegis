// AEGIS marketing site — aegis.dev
//
// Distinct from apps/homepage (Justin's personal site at aojieyuan.com)
// and apps/compliance-cockpit (the per-tenant customer app at
// app.aegis.dev). Public-marketing only: landing, pricing, security,
// blog, signup CTA.
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://aegis.dev',
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
});
