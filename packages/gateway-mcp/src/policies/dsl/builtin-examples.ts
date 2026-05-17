/**
 * Ready-made DSL documents the Cockpit can show as starting points.
 *
 * These are *examples* — not automatically applied. A tenant copies one
 * into their config via PUT /api/v1/dsl.
 */

import { PolicyDsl } from '@agentguard/core-schema';

interface DslExample {
  id: string;
  name: string;
  description: string;
  dsl: PolicyDsl;
}

export const BUILTIN_DSL_EXAMPLES: DslExample[] = [
  {
    id: 'pending-on-anomaly',
    name: 'Pending on high anomaly',
    description:
      'Escalate any tool call whose behavioral anomaly score exceeds 0.7 to human review.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'pending-on-anomaly',
          when: { 'anomaly.score': { '>': 0.7 } },
          then: {
            decision: 'pending',
            reason: 'Behavioral anomaly above 0.7',
          },
        },
      ],
    },
  },
  {
    id: 'strict-financial',
    name: 'Strict financial mode',
    description:
      'Block shell + supply-chain unconditionally; route DB and file ops to human review.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'block-shell',
          when: { 'classifier.category': 'shell' },
          then: { decision: 'block', reason: 'shell disallowed' },
        },
        {
          name: 'block-supply-chain',
          when: { 'classifier.category': 'supply-chain' },
          then: { decision: 'block', reason: 'supply-chain disallowed' },
        },
        {
          name: 'pending-db',
          when: { 'classifier.category': 'database' },
          then: { decision: 'pending', reason: 'database calls need review' },
        },
        {
          name: 'pending-file',
          when: { 'classifier.category': 'file' },
          then: { decision: 'pending', reason: 'file ops need review' },
        },
      ],
    },
  },
  {
    id: 'agent-exception',
    name: 'Per-agent exception',
    description:
      'Force tighter review for a specific agent ID while leaving others on defaults.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'review-untrusted-agent',
          when: {
            all: [
              { 'agent.id': 'replace-with-agent-uuid' },
              {
                'classifier.category': { in: ['database', 'file', 'network'] },
              },
            ],
          },
          then: { decision: 'pending', reason: 'untrusted agent under review' },
        },
      ],
    },
  },
  {
    id: 'block-pii-exfil',
    name: 'Block large outbound payloads',
    description:
      'Block network calls whose URL contains common exfil indicators or whose body looks suspiciously large.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'block-exfil-url',
          when: {
            all: [
              { 'classifier.category': 'network' },
              { 'tool.args.url': { matches: '(pastebin|webhook\\.site|requestbin)' } },
            ],
          },
          then: { decision: 'block', reason: 'suspicious egress destination' },
        },
      ],
    },
  },
  {
    id: 'mode-aware',
    name: 'Deployment-mode aware',
    description:
      'Tighten behavior based on tenant deployment mode without touching defaults.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'strict-mode-pending-network',
          when: {
            all: [
              { 'tenant.deploymentMode': { in: ['strict', 'financial', 'healthcare'] } },
              { 'classifier.category': 'network' },
            ],
          },
          then: { decision: 'pending', reason: 'network ops reviewed in strict modes' },
        },
      ],
    },
  },
];
