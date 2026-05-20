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
  {
    id: 'block-unsafe-code-gen',
    name: 'Block unsafe code generation',
    description:
      'Refuse to dispatch a tool call when CodeShield flagged the agent-generated code as CRITICAL (exec / eval / leaked secrets / rm -rf /). Findings come from POST /api/v1/code-shield/scan, populated by the Python SDK helper or any client that scans before dispatch.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'block-on-critical-code',
          when: { 'code_shield.worst': 'CRITICAL' },
          then: {
            decision: 'block',
            reason: 'unsafe code generation flagged by CodeShield',
          },
        },
        {
          name: 'pending-on-high-code',
          when: { 'code_shield.worst': 'HIGH' },
          then: {
            decision: 'pending',
            reason: 'high-severity code finding — human review required',
          },
        },
      ],
    },
  },
  {
    id: 'pause-on-alignment-drift',
    name: 'Pause on agent alignment drift',
    description:
      'Hold tool calls for human review when the agent\'s chain-of-thought has drifted from its declared goal, or its alignment score is below 0.5. Signal comes from POST /api/v1/alignment/check, populated by the LangChain AlignmentCallback or a custom CoT capture.',
    dsl: {
      version: 1,
      rules: [
        {
          name: 'pause-on-drift',
          when: {
            any: [
              { 'alignment.drifted': true },
              { 'alignment.score': { '<': 0.5 } },
            ],
          },
          then: {
            decision: 'pending',
            reason: 'agent reasoning diverged from declared goal',
          },
        },
      ],
    },
  },
];
