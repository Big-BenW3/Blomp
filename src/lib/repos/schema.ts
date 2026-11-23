import { z } from "zod";

export const MAX_ENABLED_FLOWS = 5;
export const MAX_TOTAL_FLOWS = 10;

/** One flow as posted by the edit screen. `id` is absent for flows the user just added. */
export const flowFormSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(3, "Give each flow a name (3+ characters)").max(60),
  objective: z.string().trim().min(10, "Describe what Kane should do (10+ characters)").max(1000),
  path: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[^\s]*$/, "Path must start with / and contain no spaces"),
  enabled: z.boolean(),
});

export const flowsFormSchema = z
  .array(flowFormSchema)
  .max(MAX_TOTAL_FLOWS, `At most ${MAX_TOTAL_FLOWS} flows per repo`)
  .refine((flows) => flows.filter((f) => f.enabled).length <= MAX_ENABLED_FLOWS, {
    message: `Turn off flows until at most ${MAX_ENABLED_FLOWS} are on`,
  });

export type FlowForm = z.infer<typeof flowFormSchema>;

/** Repo names as they appear in URLs: GitHub owner and repo names only. */
export const repoParamSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});
