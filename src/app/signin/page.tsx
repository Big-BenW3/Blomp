import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { GitHub } from "@/components/icons";
import { Logo } from "@/components/logo";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/repos");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col px-6 pt-[env(safe-area-inset-top)] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-12 text-center">
        <Logo size={84} />
        <h1 className="mt-3 text-[34px] font-bold tracking-tight">Blomp</h1>
        <p className="max-w-[270px] text-base leading-relaxed text-muted">
          Kane proves your live site works. Blomp fixes it when it doesn&apos;t.
        </p>
      </div>
      <form
        className="flex flex-col items-center gap-3"
        action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/repos" });
        }}
      >
        <button type="submit" className="ui-btn">
          <GitHub />
          Continue with GitHub
        </button>
        <p className="max-w-[280px] text-center text-xs leading-relaxed text-muted">
          Blomp uses GitHub to find your repos and open fixes you approve.
        </p>
      </form>
    </main>
  );
}
