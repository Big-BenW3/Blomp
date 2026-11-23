/** What a server action tells its form: nothing yet (null), or a result with a short message to show. */
export type ActionState = { ok: boolean; message?: string } | null;
