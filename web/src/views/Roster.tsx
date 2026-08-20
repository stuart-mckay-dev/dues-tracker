import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type Bootstrap, type RosterEntry } from "../api";
import { MemberRow } from "../components/MemberRow";
import { AddMemberSheet } from "../components/AddMemberSheet";

type Filter = "all" | "behind" | "ahead" | "exempt";

export function Roster({ boot }: { boot: Bootstrap }) {
  const [members, setMembers] = useState<RosterEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);

  function load(archived = showArchived) {
    api
      .members(archived)
      .then((r) => setMembers(r.members))
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, [showArchived]);

  const visible = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      if (q && !`${m.displayName} ${m.nickname ?? ""}`.toLowerCase().includes(q)) return false;
      switch (filter) {
        case "behind":
          return m.standing.flag !== "ok";
        case "ahead":
          return m.standing.state === "current" && m.standing.creditCents > 0;
        case "exempt":
          return !m.accruesDues;
        default:
          return true;
      }
    });
  }, [members, query, filter]);

  if (error) return <div class="empty">{error}</div>;
  if (!members) return <div class="empty">Loading…</div>;

  return (
    <>
      <div class="search">
        <input
          type="search"
          placeholder="Search members…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="segmented" style="margin-bottom:12px">
        {(
          [
            ["all", `All ${members.length}`],
            ["behind", "Behind"],
            ["ahead", "Paid ahead"],
            ["exempt", "Exempt"],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
      </div>

      <div class="card">
        <div class="card-body tight">
          {visible.length === 0 ? (
            <div class="empty">
              {members.length === 0 ? "No members yet — add your first one below." : "No matches."}
            </div>
          ) : (
            <ul class="rows">
              {visible.map((m) => (
                <MemberRow key={m.id} entry={m} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div class="btn-row">
        <button class="btn primary grow" onClick={() => setAdding(true)}>
          Add member
        </button>
        <button class="btn" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      </div>

      <div class="spacer" />

      {adding && (
        <AddMemberSheet
          boot={boot}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </>
  );
}
