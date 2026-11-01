import { parseTaskSpec, type TaskSpec } from "../schema.ts";



/** A valid 3-node chain: audit → design → impl (the V1 acceptance shape). */
export const CHAIN = {
  id: 'demo',
  title: 'Demo chain',
  goal: 'audit then design then implement',
  nodes: [
    { id: 'audit', prompt: 'Audit the code' },
    { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
    { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
  ],
  outputs: { result: '${nodes.impl.output}' },
};


export function parsed(): TaskSpec {
  const r = parseTaskSpec(CHAIN);
  if (!r.success) throw new Error('fixture should parse');
  return r.data;
}
