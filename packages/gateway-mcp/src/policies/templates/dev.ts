/**
 * `dev` deployment template — lowest overhead, for local development.
 * L1 rules only; L2/L3 disabled; short retention.
 */

import { TenantConfig } from '@agentguard/core-schema';

export const devTemplate: TenantConfig = {
  version: 1,
  deploymentMode: 'dev',
  layers: {
    l1: { enabled: true },
    l2: { enabled: false },
    l3: { enabled: false },
  },
  thresholds: {
    anomalyScore: 0.9,
    pendingTimeoutSec: 60,
  },
  retention: {
    days: 7,
    enforcePII: false,
  },
  policyOverrides: {
    shell: { enabled: true, riskLevel: 'HIGH', decision: 'block' },
    'supply-chain': { enabled: true, riskLevel: 'HIGH', decision: 'block' },
    database: { enabled: true, riskLevel: 'MEDIUM' },
    file: { enabled: false },
    network: { enabled: false },
    'prompt-injection': { enabled: true, riskLevel: 'MEDIUM' },
  },
  sinks: [],
  customDetectors: [],
  customComplianceFrameworks: [],
};

export const devDescription =
  'Local development: L1 rules only, blocks shell + supply-chain, 7-day retention. Minimal CPU/cost.';
