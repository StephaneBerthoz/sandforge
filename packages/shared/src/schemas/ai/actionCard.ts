import { z } from 'zod';

export const ActionKindSchema = z.enum([
  'copy-soql', // copy SOQL to clipboard, no approval
  'open-file', // VSCode opens file at line, no approval
  'run-anonymous', // execute Anonymous Apex — REQUIRES approval
  'apply-fix', // edit a file with proposed change — REQUIRES approval
  'manual', // no auto-execute path; user must do it themselves
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionProposalSchema = z
  .object({
    label: z.string().min(1).max(120),
    kind: ActionKindSchema,
    payload: z.string().max(8000).optional(),
    requiresApproval: z.boolean(),
    riskNote: z.string().max(300).optional(),
  })
  .strict();
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const DiagnoseErrorContextSchema = z
  .object({
    kind: z.enum(['bulk-job', 'apex-deploy', 'metadata-deploy', 'test-run', 'soql-analysis', 'generic']),
    jobId: z.string().optional(),
    file: z.string().optional(),
    errorMessage: z.string().min(1).max(8000),
    debugLogTail: z.string().max(20_000).optional(),
    classifierVerdict: z.string().max(2000).optional(),
  })
  .strict();
export type DiagnoseErrorContext = z.infer<typeof DiagnoseErrorContextSchema>;
