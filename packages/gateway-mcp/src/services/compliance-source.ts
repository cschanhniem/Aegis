/**
 * ComplianceControlSource — single read-side merge of built-in frameworks
 * with tenant-registered custom frameworks. Compliance API + bundle
 * generator both go through this so neither has to know whether a given
 * framework id is built-in or operator-registered.
 *
 * Lookup precedence: built-in > tenant custom. Reserved IDs are rejected
 * at the API layer (PUT /api/v1/compliance/frameworks), so collisions
 * shouldn't happen in practice — the precedence is just a safety belt.
 */

import {
  CustomComplianceFramework,
} from '@agentguard/core-schema';
import {
  ComplianceControl,
  Framework,
  builtinControlsFor,
  isBuiltinFramework,
  listBuiltinFrameworks,
} from './compliance-controls';
import { TenantConfigService } from './tenant-config';

export interface FrameworkSummary {
  id: string;
  name: string;
  control_count: number;
  source: 'builtin' | 'custom';
}

export class ComplianceControlSource {
  constructor(private tenantConfig: TenantConfigService) {}

  list(orgId: string): FrameworkSummary[] {
    const out: FrameworkSummary[] = listBuiltinFrameworks().map(id => ({
      id,
      name: BUILTIN_NAMES[id],
      control_count: builtinControlsFor(id).length,
      source: 'builtin' as const,
    }));
    const customs = this.tenantConfig.get(orgId).customComplianceFrameworks ?? [];
    for (const fw of customs) {
      out.push({
        id: fw.id,
        name: fw.name,
        control_count: fw.controls.length,
        source: 'custom',
      });
    }
    return out;
  }

  exists(orgId: string, framework: string): boolean {
    return isBuiltinFramework(framework) || this.findCustom(orgId, framework) !== undefined;
  }

  controlsFor(orgId: string, framework: Framework): ReadonlyArray<ComplianceControl> {
    if (isBuiltinFramework(framework as string)) {
      return builtinControlsFor(framework as any);
    }
    const custom = this.findCustom(orgId, framework as string);
    if (!custom) return [];
    return custom.controls.map(c => ({
      framework: custom.id as any,
      id: c.id,
      title: c.title,
      summary: c.summary,
      evidenceSpec: c.evidenceSpec,
    }));
  }

  private findCustom(orgId: string, id: string): CustomComplianceFramework | undefined {
    return (this.tenantConfig.get(orgId).customComplianceFrameworks ?? []).find(f => f.id === id);
  }
}

const BUILTIN_NAMES: Record<string, string> = {
  'soc2':        'SOC 2',
  'iso27001':    'ISO 27001:2022',
  'nist-ai-rmf': 'NIST AI RMF',
  'eu-ai-act':   'EU AI Act',
};
