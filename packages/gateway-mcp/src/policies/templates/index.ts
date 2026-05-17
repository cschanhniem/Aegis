/**
 * Deployment template registry.
 *
 * Each template is a complete, immutable TenantConfig. Applying a template
 * deep-merges into the tenant's stored settings; subsequent edits do not
 * follow upstream template changes.
 */

import {
  DeploymentMode,
  TenantConfig,
  TenantConfigSchema,
} from '@agentguard/core-schema';
import { devTemplate, devDescription } from './dev';
import { standardTemplate, standardDescription } from './standard';
import { strictTemplate, strictDescription } from './strict';
import { financialTemplate, financialDescription } from './financial';
import { healthcareTemplate, healthcareDescription } from './healthcare';

export type TemplateName = Exclude<DeploymentMode, 'custom'>;

export interface TemplateMeta {
  name: TemplateName;
  description: string;
  config: TenantConfig;
}

const RAW: Record<TemplateName, { config: TenantConfig; description: string }> =
  {
    dev: { config: devTemplate, description: devDescription },
    standard: { config: standardTemplate, description: standardDescription },
    strict: { config: strictTemplate, description: strictDescription },
    financial: { config: financialTemplate, description: financialDescription },
    healthcare: {
      config: healthcareTemplate,
      description: healthcareDescription,
    },
  };

// Validate every template at module-load time so a bad template fails fast,
// not on first apply.
for (const [name, { config }] of Object.entries(RAW)) {
  const result = TenantConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Template "${name}" failed schema validation: ${JSON.stringify(
        result.error.issues,
      )}`,
    );
  }
}

export function listTemplates(): TemplateMeta[] {
  return (Object.keys(RAW) as TemplateName[]).map((name) => ({
    name,
    description: RAW[name].description,
    config: RAW[name].config,
  }));
}

export function getTemplate(name: TemplateName): TemplateMeta | null {
  const entry = RAW[name];
  if (!entry) return null;
  return { name, description: entry.description, config: entry.config };
}

export const DEFAULT_TEMPLATE: TemplateName = 'standard';
