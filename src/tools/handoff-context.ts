import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { extractStructuredHandoff, HANDOFF_OPEN, HANDOFF_CLOSE, type StructuredHandoff } from '../handoff-compaction.js';
export function createHandoffContextTool(stage: (summary: StructuredHandoff, resume: boolean) => void | false): AgentTool<any> {
 return {
  name: 'handoff_context', label: 'Hand off context',
  description: 'Save a concise continuity summary and rotate into fresh context at the end of this tool sequence. Use when the user requests a handoff, or when a long task needs a fresh context. Write the summary from the current conversation; do not reread all history. Completed work must not be repeated. No more tools should follow this call.',
  parameters: Type.Object({
   label: Type.String(),
   summary: Type.String({ maxLength: 12000, description: 'Concise handoff: goal, constraints, completed work, decisions, uncertainties, exact necessary references, and next steps. No raw tool output or secrets.' }),
   nextSteps: Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 12 })], { description: "Next actions as plain text or a list. An empty string or list means no remaining steps." }),
   continue: Type.Boolean({ description: 'Continue unfinished work after rotation; false means wait for the user.' }),
  }),
  execute: async (_id, args: any) => {
   const nextSteps = typeof args.nextSteps === 'string' ? (args.nextSteps.trim() ? [args.nextSteps.trim()] : []) : args.nextSteps;
   if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 12000 || !Array.isArray(nextSteps) || nextSteps.length > 12 || nextSteps.some(step => typeof step !== 'string')) throw new Error('Provide a bounded nonempty handoff and next steps');
   const summary = { version: 1, goal: args.summary, constraints: [], completed: [], inProgress: [], nextSteps, decisions: [], provenance: [], uncertainties: [], superseded: [], toolReceipts: [], routing: {channel: '', replyTarget: null} };
   const parsed = extractStructuredHandoff(`${HANDOFF_OPEN}${JSON.stringify(summary)}${HANDOFF_CLOSE}`);
   if (!parsed) throw new Error('Invalid continuity summary');
   if (stage(parsed.handoff, args.continue === true) === false) return {
    content: [{ type: 'text', text: 'The requested context handoff already completed in this run. No additional rotation was performed. Returning control to the user.' }],
    details: {}, terminate: true,
   };
   return { content: [{type:'text',text:'Handoff staged. The harness will archive and rotate at the safe turn boundary.'}], details: {}, terminate: true };
  },
 };
}
