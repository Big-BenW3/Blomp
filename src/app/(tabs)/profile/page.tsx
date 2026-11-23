import { auth, signOut } from "@/auth";

export default async function ProfilePage() {
  const session = await auth();
  const user = session!.user;
  const model = process.env.NVIDIA_MODEL?.split("/").pop();
  return (
    <main className="flex flex-col gap-3.5">
      <h1 className="ui-title">Profile</h1>
      <ul className="ui-list">
        <li className="ui-row" style={{ minHeight: 76, gap: 14 }}>
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.image} alt="" width={56} height={56} className="size-14 rounded-full" />
          ) : (
            <span
              className="grid size-14 place-items-center rounded-full text-[22px] font-semibold uppercase"
              style={{ background: "var(--tint)", color: "var(--accent)" }}
              aria-hidden="true"
            >
              {user.login.slice(0, 1)}
            </span>
          )}
          <div className="ui-body">
            <p className="ui-rt" style={{ fontSize: 20 }}>
              {user.name ?? user.login}
            </p>
            <p className="ui-rs">@{user.login}</p>
          </div>
        </li>
      </ul>
      {model ? (
        <ul className="ui-list">
          <li className="ui-row">
            <p className="ui-rt ui-body">AI model</p>
            <span className="ui-rs font-mono" style={{ marginTop: 0 }}>
              {model}
            </span>
          </li>
        </ul>
      ) : null}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <ul className="ui-list">
          <li>
            <button
              type="submit"
              className="ui-row w-full justify-center text-base font-semibold"
              style={{ color: "var(--fail)", background: "transparent", border: 0, font: "inherit", fontWeight: 600 }}
            >
              Sign out
            </button>
          </li>
        </ul>
      </form>
    </main>
  );
}
