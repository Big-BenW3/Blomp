"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, Search } from "@/components/icons";
import { scoreZone } from "@/lib/kane/score";

export interface RepoItem {
  owner: string;
  name: string;
  site: string | null;
  score: number | null;
}

export function RepoList({ items }: { items: RepoItem[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(needle)) : items;
  }, [items, q]);

  return (
    <>
      <label className="ui-search">
        <Search size={17} />
        <input
          type="search"
          className="ui-input"
          placeholder="Search"
          aria-label="Search your repos"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No repos match &ldquo;{q.trim()}&rdquo;.</p>
      ) : (
        <ul className="ui-list split">
          {shown.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <Link href={`/repos/${r.owner}/${r.name}`} className="ui-row">
                <span className="ui-avatar" aria-hidden="true">
                  {r.name.slice(0, 1)}
                </span>
                <div className="ui-body">
                  <p className="ui-rt">{r.name}</p>
                  <p className="ui-rs">{r.site ?? "No live site yet"}</p>
                </div>
                {r.score !== null ? (
                  <span className="ui-score" style={{ color: `var(--${scoreZone(r.score)})` }} aria-label={`Last score ${r.score}`}>
                    {r.score}
                  </span>
                ) : null}
                <ChevronRight size={16} className="shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-center text-xs text-muted">
        {items.length} {items.length === 1 ? "repo" : "repos"} on GitHub
      </p>
    </>
  );
}
