/**
 * `strict` deployment template — high-sensitivity workloads.
 * All three layers always on, low thresholds, ambiguous cases route to humans.
 */

import { TenantConfig } from '@agentguard/core-schema';

export const strictTemplate: TenantConfig = {
  version: 1,
  deploymentMode: 'strict',
  layers: {
    l1: { enabled: true },
    l2: { enabled: true, threshold: 0.5 },
    l3: { enabled: true },
  },
  thresholds: {
    anomalyScore: 0.6,
    pendingTimeoutSec: 600,
  },
  retention: {
    days: 180,
    enforcePII: true,
  },
  policyOverrides: {
    shell: { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    'supply-chain': { enabled: true, riskLevel: 'CRITICAL', decision: 'block' },
    database: { enabled: true, riskLevel: 'HIGH', decision: 'pending' },
    file: { enabled: true, riskLevel: 'HIGH', decision: 'pending' },
    network: { enabled: true, riskLevel: 'MEDIUM', decision: 'pending' },
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

export const strictDescription =
  'High-sensitivity: all layers on, aggressive thresholds, human review for HIGH+, PII masking, 180-day retention.';
