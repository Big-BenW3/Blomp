import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { decryptSecret } from "@/lib/security/crypto";

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "blomp" });
}

/** Octokit acting as the signed-in user, using the GitHub token stored (encrypted) at sign-in. */
export async function getUserOctokit(userId: string): Promise<Octokit> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const [row] = await getDb().select({ enc: users.accessTokenEnc }).from(users).where(eq(users.id, userId));
  if (!row) throw new Error("user not found");
  return makeOctokit(decryptSecret(row.enc, secret));
}

/** True when GitHub says the token is bad or revoked, so the UI can ask the user to sign in again. */
export function isAuthError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 401;
}
