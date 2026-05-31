/**
 * `financial` deployment template — banking/fintech compliance.
 * Long retention (7y for SOX/SEC), PII enforcement, all layers active.
 */

import { TenantConfig } from '@agentguard/core-schema';

export const financialTemplate: TenantConfig = {
  version: 1,
  deploymentMode: 'financial',
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
    days: 2555, // 7 years (SOX, SEC 17a-4)
    enforcePII: true,
  },
  policyOverrides: {
    shell: { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    'supply-chain': { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    database: { enabled: true, riskLevel: 'CRITICAL', decision: 'pending' },
    file: { enabled: true, riskLevel: 'HIGH', decision: 'pending' },
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
  customDetectors: [],
  customComplianceFrameworks: [],
};

export const financialDescription =
  'Financial services: 7-year retention (SOX/SEC), mandatory PII masking, DB calls require human approval.';
