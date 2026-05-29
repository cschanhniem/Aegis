/**
 * `healthcare` deployment template — HIPAA-aware configuration.
 * 6-year retention (HIPAA 164.316), full audit trail, all layers active.
 */

import { TenantConfig } from '@agentguard/core-schema';

export const healthcareTemplate: TenantConfig = {
  version: 1,
  deploymentMode: 'healthcare',
  layers: {
    l1: { enabled: true },
    l2: { enabled: true, threshold: 0.5 },
    l3: { enabled: true },
  },
  thresholds: {
    anomalyScore: 0.6,
    pendingTimeoutSec: 900,
  },
  retention: {
    days: 2190, // 6 years (HIPAA 164.316(b)(2)(i))
    enforcePII: true,
  },
  policyOverrides: {
    shell: { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    'supply-chain': { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    database: { enabled: true, riskLevel: 'CRITICAL', decision: 'pending' },
    file: { enabled: true, riskLevel: 'CRITICAL', decision: 'pending' },
    network: { enabled: true, riskLevel: 'HIGH', decision: 'pending' },
    'prompt-injection': {
      enabled: true,
      riskLevel: 'CRITICAL',
      decision: 'block',
    },
  },
  sla: {
    targetP50Ms: 80,
    targetP95Ms: 300,
  },
  sinks: [],
};

export const healthcareDescription =
  'HIPAA-aware: 6-year retention (164.316), mandatory PII masking, file + DB ops require human approval.';
