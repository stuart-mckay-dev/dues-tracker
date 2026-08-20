import { useCallback, useEffect, useState } from "preact/hooks";
import { api, type Bootstrap } from "./api";
import { navigate, useRoute } from "./router";
import { Dashboard } from "./views/Dashboard";
import { Roster } from "./views/Roster";
import { Member } from "./views/Member";
import { ClubLedger } from "./views/ClubLedger";
import { Delinquency } from "./views/Delinquency";
import { Settings } from "./views/Settings";
import { EntrySheet } from "./components/EntrySheet";
import { Toast, useToast } from "./components/Toast";

const TABS = [
  { hash: "#/", name: "dashboard", icon: "🏠", label: "Home" },
  { hash: "#/roster", name: "roster", icon: "👥", label: "Roster" },
  { hash: "#/ledger", name: "ledger", icon: "📒", label: "Ledger" },
  { hash: "#/report", name: "report", icon: "🚩", label: "Behind" },
  { hash: "#/settings", name: "settings", icon: "⚙️", label: "Settings" },
] as const;

const TITLES: Record<string, string> = {
  dashboard: "Club Dues",
  roster: "Roster",
  member: "Member",
  ledger: "Club Ledger",
  report: "Behind on Dues",
  settings: "Settings",
};

export function App() {
  const route = useRoute();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryMemberId, setEntryMemberId] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const toast = useToast();

  useEffect(() => {
    api
      .bootstrap()
      .then(setBoot)
      .catch((err: Error) => setBootError(err.message));
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const openEntry = useCallback((memberId?: string) => {
    setEntryMemberId(memberId);
    setEntryOpen(true);
  }, []);

  if (bootError) {
    return (
      <div class="container">
        <div class="card">
          <div class="card-body">
            <h2>Could not load</h2>
            <p class="muted">{bootError}</p>
            <button class="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
            <div class="hint">
              If your Cloudflare Access session has expired, reloading signs you back in.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!boot) {
    return <div class="empty">Loading…</div>;
  }

  const title =
    route.name === "dashboard" && boot.settings.clubName
      ? boot.settings.clubName
      : TITLES[route.name];

  return (
    <div class="app">
      <header class="topbar">
        {route.name === "member" && (
          <button class="back" onClick={() => history.back()} aria-label="Back">
            ‹
          </button>
        )}
        <h1>{title}</h1>
      </header>

      <main class="container">
        {route.name === "dashboard" && (
          <Dashboard key={refreshKey} boot={boot} onChanged={refresh} toast={toast} />
        )}
        {route.name === "roster" && <Roster key={refreshKey} boot={boot} />}
        {route.name === "member" && (
          <Member
            key={`${route.id}-${refreshKey}`}
            id={route.id}
            boot={boot}
            onAddEntry={() => openEntry(route.id)}
            onChanged={refresh}
            toast={toast}
          />
        )}
        {route.name === "ledger" && <ClubLedger key={refreshKey} />}
        {route.name === "report" && <Delinquency key={refreshKey} boot={boot} />}
        {route.name === "settings" && <Settings boot={boot} toast={toast} />}
      </main>

      {route.name !== "settings" && (
        <button class="fab no-print" onClick={() => openEntry()} aria-label="Record an entry">
          +
        </button>
      )}

      <nav class="tabbar no-print">
        {TABS.map((tab) => (
          <a
            key={tab.hash}
            href={tab.hash}
            aria-current={route.name === tab.name ? "page" : undefined}
          >
            <span class="icon" aria-hidden="true">
              {tab.icon}
            </span>
            {tab.label}
          </a>
        ))}
      </nav>

      {entryOpen && (
        <EntrySheet
          boot={boot}
          memberId={entryMemberId}
          onClose={() => setEntryOpen(false)}
          onSaved={(message) => {
            setEntryOpen(false);
            toast.show(message);
            refresh();
          }}
        />
      )}

      <Toast state={toast} />
    </div>
  );
}

export { navigate };
