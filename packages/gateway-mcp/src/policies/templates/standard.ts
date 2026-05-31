/**
 * `standard` deployment template — default for new tenants.
 * L1 + L2 always run; L3 only escalates pending cases.
 */

import { TenantConfig } from '@agentguard/core-schema';

export const standardTemplate: TenantConfig = {
  version: 1,
  deploymentMode: 'standard',
  layers: {
    l1: { enabled: true },
    l2: { enabled: true, threshold: 0.7 },
    l3: { enabled: true },
  },
  thresholds: {
    anomalyScore: 0.8,
    pendingTimeoutSec: 300,
  },
  retention: {
    days: 90,
    enforcePII: false,
  },
  policyOverrides: {
    shell: { enabled: true, riskLevel: 'HIGH', decision: 'block' },
    'supply-chain': { enabled: true, riskLevel: 'HIGH', decision: 'block' },
    database: { enabled: true, riskLevel: 'MEDIUM' },
    file: { enabled: true, riskLevel: 'MEDIUM' },
    network: { enabled: true, riskLevel: 'LOW' },
    'prompt-injection': { enabled: true, riskLevel: 'HIGH', decision: 'block' },
  },
  sla: {
    targetP50Ms: 50,
    targetP95Ms: 200,
  },
  sinks: [],
  customDetectors: [],
  customComplianceFrameworks: [],
};

export const standardDescription =
  'Default profile: L1 + L2 always on, L3 escalates ambiguous cases, 90-day retention.';
