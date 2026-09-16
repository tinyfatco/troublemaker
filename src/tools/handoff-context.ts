import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { extractStructuredHandoff, HANDOFF_OPEN, HANDOFF_CLOSE, type StructuredHandoff } from '../handoff-compaction.js';

export function parseHandoffContextArguments(
 args: unknown,
 routing: StructuredHandoff['routing'] = { channel: '', replyTarget: null },
): { handoff: StructuredHandoff; resume: boolean } {
 if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid continuity arguments');
 const value = args as Record<string, unknown>;
 const nextSteps = typeof value.nextSteps === 'string'
  ? (value.nextSteps.trim() ? [value.nextSteps.trim()] : [])
  : value.nextSteps;
 if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 12000
  || !Array.isArray(nextSteps) || nextSteps.length > 12 || nextSteps.some(step => typeof step !== 'string')) {
  throw new Error('Provide a bounded nonempty handoff and next steps');
 }
 const summary = { version: 1, goal: value.summary, constraints: [], completed: [], inProgress: [], nextSteps,
  decisions: [], provenance: [], uncertainties: [], superseded: [], toolReceipts: [], routing };
 const parsed = extractStructuredHandoff(`${HANDOFF_OPEN}${JSON.stringify(summary)}${HANDOFF_CLOSE}`, routing);
 if (!parsed) throw new Error('Invalid continuity summary');
 return { handoff: parsed.handoff, resume: value.continue === true };
}

export function createHandoffContextTool(stage: (summary: StructuredHandoff, resume: boolean) => void | false): AgentTool<any> {
 return {
  name: 'handoff_context', label: 'Hand off context',
  description: 'Save a concise continuity summary and rotate into fresh context at the end of this tool sequence. Use when the user requests a handoff, or when a long task needs a fresh context. Write the summary from the current conversation; do not reread all history. Completed work must not be repeated. No more tools should follow this call.',
  parameters: Type.Object({
   label: Type.Optional(Type.String()),
   summary: Type.String({ maxLength: 12000, description: 'Concise handoff: goal, constraints, completed work, decisions, uncertainties, exact necessary references, and next steps. No raw tool output or secrets.' }),
   nextSteps: Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 12 })], { description: "Next actions as plain text or a list. An empty string or list means no remaining steps." }),
   continue: Type.Boolean({ description: 'Continue unfinished work after rotation; false means wait for the user.' }),
  }),
  execute: async (_id, args: any) => {
   const parsed = parseHandoffContextArguments(args);
   if (stage(parsed.handoff, parsed.resume) === false) return {
    content: [{ type: 'text', text: 'The requested context handoff already completed in this run. No additional rotation was performed. Returning control to the user.' }],
    details: {}, terminate: true,
   };
   return { content: [{type:'text',text:'Handoff staged. The harness will archive and rotate at the safe turn boundary.'}], details: {}, terminate: true };
  },
 };
}

/** Private completions are never published or executed as general tool calls.
 * Accept presentation variations, but require one unambiguous validated summary.
 */
export function parsePrivateCheckpointResponse(
 content: readonly { type: string; name?: string; arguments?: unknown; text?: string }[],
 routing: StructuredHandoff['routing'],
): { handoff: StructuredHandoff; resume: boolean } {
 const calls = content.filter(part => part.type === 'toolCall' && part.name === 'handoff_context');
 const candidates: unknown[] = calls.map(part => part.arguments);
 if (!calls.length) {
  const text = content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim();
  // Recover JSON emitted as text; never turn arbitrary prose or reasoning into state.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const values = fenced.length ? fenced.map(match => match[1]) : [text];
  for (const value of values) {
   try { candidates.push(JSON.parse(value)); } catch { /* Not a structured checkpoint. */ }
  }
 }
 const parsed = candidates.flatMap(candidate => {
  try {
   const value = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
   return [parseHandoffContextArguments(value, routing)];
  } catch { return []; }
 });
 if (!parsed.length) throw new Error('Private checkpoint did not contain a usable summary and next steps');
 const unique = new Map(parsed.map(value => [JSON.stringify(value), value]));
 if (unique.size !== 1) throw new Error('Private checkpoint contained conflicting summaries');
 return parsed[0];
}
