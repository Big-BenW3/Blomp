import { signOut } from "@/auth";

/** Shown when GitHub rejects the stored token (revoked, or "Expire user access tokens" is on). */
export function ReconnectCard() {
  return (
    <main className="flex flex-col gap-3.5">
      <div className="ui-list mt-10 px-6 py-8 text-center">
        <p className="text-base font-semibold">GitHub needs you to sign in again</p>
        <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">Your GitHub connection has expired or was revoked.</p>
        <form
          className="mt-5"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button type="submit" className="ui-btn">
            Sign in again
          </button>
        </form>
      </div>
    </main>
  );
}
