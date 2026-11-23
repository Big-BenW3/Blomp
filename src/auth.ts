import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { encryptSecret } from "@/lib/security/crypto";

// `repo` lets Blomp read code and open fix PRs on the user's behalf.
const SCOPE = "read:user user:email repo";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers: [GitHub({ authorization: { params: { scope: SCOPE } } })],
  callbacks: {
    async jwt({ token, account, profile }) {
      // Runs with `account` only at sign-in: store the user and their encrypted GitHub token.
      if (account?.provider === "github" && account.access_token && profile) {
        const gh = profile as { id: number | string; login: string; avatar_url?: string };
        const secret = process.env.AUTH_SECRET;
        if (!secret) throw new Error("AUTH_SECRET is not set");
        const values = {
          githubId: Number(gh.id),
          login: gh.login,
          avatarUrl: gh.avatar_url ?? null,
          accessTokenEnc: encryptSecret(account.access_token, secret),
        };
        const [row] = await getDb()
          .insert(users)
          .values(values)
          .onConflictDoUpdate({
            target: users.githubId,
            set: { login: values.login, avatarUrl: values.avatarUrl, accessTokenEnc: values.accessTokenEnc },
          })
          .returning({ id: users.id });
        token.userId = row.id;
        token.login = gh.login;
      }
      return token;
    },
    session({ session, token }) {
      if (token.userId) session.user.id = token.userId as string;
      if (token.login) session.user.login = token.login as string;
      return session;
    },
  },
});
