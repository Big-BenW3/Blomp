import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/repos");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <p className="font-mono text-sm text-accent">blomp</p>
      <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight">
        CI is green.
        <br />
        Is your signup?
      </h1>
      <p className="mt-4 text-sm text-muted">
        Connect GitHub and Kane will open your live site in a real browser, prove which flows work,
        and open a pull request for the ones that don&apos;t.
      </p>
      <form
        className="mt-8"
        action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/repos" });
        }}
      >
        <button
          type="submit"
          className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-black outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Continue with GitHub
        </button>
      </form>
      <p className="mt-4 text-xs text-muted">
        Blomp asks for the <span className="font-mono">repo</span> scope so it can read code and open fix PRs.
      </p>
    </main>
  );
}
