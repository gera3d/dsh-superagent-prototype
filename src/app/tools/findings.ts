/** Observation is data only. Neither this tool nor model advice can confirm work. */
import { FindingIntakeSchema, findingDecision } from '../finding.ts'
import { z } from 'zod'
import type { FindingRuntime } from '../finding-runtime.ts'
import { tool, type Tool } from './tool.ts'

export function findingTools(findings?: FindingRuntime, reference = 'native-model-session'): Tool[] {
  if (!findings) return []
  return [tool({
    name: 'orchestrator_finding_observe',
    description: 'Record a bounded finding for Senior Developer advice and operator triage. Observation only: never starts work or grants authority.',
    // Keep model-facing schema compact; the exact same strict intake validator still owns every field.
    schema: z.object({ observation_json: z.string().describe('JSON: dedupKey,title,problem,scope,owner,kind (fix|verification),requirements[],repository,occurrence {id,reference,evidence,at?}; optional existingDeliveryId,sourceIssue,sessionId. No actor or actions.') }).strict(),
    execute: async ({ observation_json }) => {
      const finding = findings.observe(FindingIntakeSchema.parse(JSON.parse(observation_json)), { source: 'model', reference })
      // Advice/dispatch has its own durable state; observations never confirm a choice.
      void findings.request().catch(() => {})
      return { finding, item: findingDecision(finding), execution_authorized: false }
    },
  })]
}
