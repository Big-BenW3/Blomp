import { auth, signOut } from "@/auth";

export default async function ProfilePage() {
  const session = await auth();
  const user = session!.user;
  return (
    <main>
      <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
      <div className="mt-6 flex items-center gap-4 rounded-2xl border border-border bg-surface p-4">
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" width={56} height={56} className="size-14 rounded-full" />
        ) : (
          <div className="size-14 rounded-full bg-border" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold">{user.name ?? user.login}</p>
          <p className="truncate font-mono text-sm text-muted">@{user.login}</p>
        </div>
      </div>
      <form
        className="mt-6"
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="w-full rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
