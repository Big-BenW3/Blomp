import { auth, signOut } from "@/auth";
import { AppearanceSettings } from "@/components/appearance-settings";
import { ChevronRight } from "@/components/icons";
import { getProfileStats } from "@/lib/profile/stats";

export const dynamic = "force-dynamic";

const GITHUB_APPS = "https://github.com/settings/applications";

function Value({ children, tone }: { children: React.ReactNode; tone?: "pass" | "warn" }) {
  const color = tone === "pass" ? "var(--pass)" : tone === "warn" ? "var(--warn)" : "var(--muted)";
  return (
    <span className="shrink-0 text-[14px]" style={{ color }}>
      {children}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <p className="ui-eyebrow">{title}</p>
      {children}
    </section>
  );
}

export default async function ProfilePage() {
  const session = await auth();
  const user = session!.user;
  const stats = await getProfileStats(user.id);
  const since = stats.memberSince?.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <main className="flex flex-col gap-5">
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
        <li className="ui-stats" style={{ borderTop: "1px solid var(--sep)" }}>
          <div className="ui-stat">
            <b>{stats.repos}</b>
            <span>Repos</span>
          </div>
          <div className="ui-stat">
            <b>{stats.scans}</b>
            <span>Scans</span>
          </div>
          <div className="ui-stat">
            <b>{stats.passed}</b>
            <span>Flows passed</span>
          </div>
        </li>
      </ul>

      <Section title="Account">
        <ul className="ui-list split">
          <li>
            <a href={`https://github.com/${user.login}`} target="_blank" rel="noopener noreferrer" className="ui-row">
              <p className="ui-rt ui-body">GitHub</p>
              <Value tone="pass">Connected</Value>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </a>
          </li>
          {since ? (
            <li className="ui-row">
              <p className="ui-rt ui-body">Member since</p>
              <Value>{since}</Value>
            </li>
          ) : null}
        </ul>
      </Section>

      <Section title="Appearance">
        <AppearanceSettings />
      </Section>

      <Section title="Privacy">
        <ul className="ui-list">
          <li>
            <a href={GITHUB_APPS} target="_blank" rel="noopener noreferrer" className="ui-row">
              <div className="ui-body">
                <p className="ui-rt">GitHub access</p>
                <p className="ui-rs">Review or revoke what Blomp can reach</p>
              </div>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </a>
          </li>
        </ul>
      </Section>

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
      <p className="ui-note text-center">Blomp 0.1 · Built for the KaneCLI hackathon</p>
    </main>
  );
}
