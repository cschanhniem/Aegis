/**
 * Tool-scope detector — enforces an agent's declared tool allow-list.
 *
 * Once an operator registers an agent with `declared_tools: [...]`, every
 * tool call that agent makes is checked against that list. Calls to tools
 * NOT on the list emit a critical signal that the decision merger turns
 * into a block.
 *
 * Coverage: AAT-T2001 (Out-of-Scope Tool Invocation) — primary detector.
 * The anomaly model already partially detects "tool never seen before in
 * baseline"; this detector is the EXPLICIT, declared, operator-controlled
 * counterpart. Operator-declared scope ≠ ML-learned baseline:
 *
 *   - declared_tools is auditable / reviewable / changeable in one PATCH
 *   - anomaly takes minutes-to-hours to learn a new tool is "normal"
 *   - declared scope ships strict-by-default; anomaly ships permissive
 *
 * Three quiet states (no signal emitted):
 *   - agent has no declared_tools (no scope means no scope check)
 *   - agent is unregistered (audit attribution is weak; scope is N/A)
 *   - the called tool IS in the declared list (the happy path)
 */

import { Detector, DetectorContext, Signal } from '@agentguard/core-schema';
import { AgentRegistryService } from '../../services/agent-registry';

const NAME = 'aegis.builtin.tool-scope';
const VERSION = '1.0.0';

export class ToolScopeDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'meta' as const;
  readonly coverage = ['AAT-T2001', 'AAT-T3001'] as const;

  constructor(private registry: AgentRegistryService) {}

  evaluate(ctx: DetectorContext): Signal[] {
    const agent = this.registry.get(ctx.agent.id);
    if (!agent) return [];
    if (agent.status !== 'active') return [];      // unregistered / suspended → other gates handle
    const declared = agent.declared_tools;
    if (!declared || declared.length === 0) return [];

    if (declared.includes(ctx.tool.name)) return [];

    // Tool is OUT of declared scope.
    return [{
      detector: NAME,
      version: VERSION,
      severity: 'critical',
      category: 'agent.out-of-scope-tool',
      message: `agent '${agent.name ?? agent.id}' invoked '${ctx.tool.name}' which is not in its declared scope`,
      evidence: {
        agent_id: agent.id,
        agent_name: agent.name,
        invoked_tool: ctx.tool.name,
        declared_tools: declared,
      },
      ontology: ['AAT-T2001', 'AAT-T3001'],
    }];
  }
}
