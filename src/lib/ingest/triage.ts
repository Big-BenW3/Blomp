import { z } from "zod";

/** Kane's own root-cause analysis of a failed run. `category` separates real app bugs from broken flows. */
export const triageSchema = z.object({
  title: z.string().max(300).optional(),
  category: z.string().max(100).optional(),
  rootCause: z.string().max(2000).optional(),
  severity: z.string().max(50).optional(),
  suggestedFix: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  errorMessage: z.string().max(2000).optional(),
});

export type Triage = z.infer<typeof triageSchema>;

/** True when Kane blames the app (worth a fix PR) rather than the flow definition or the environment. */
export function isAppIssue(t: Triage | null | undefined): boolean {
  return Boolean(t?.category?.startsWith("application_issue"));
}
