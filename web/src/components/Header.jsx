import { useEffect, useRef, useState } from "react";

// Same suite switcher every other app carries — keep the list and the
// visibility rule below identical across apps.
const APP_LINKS = [
  { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
  { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
  { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
  { name: "TALLY", url: "https://lambwright.github.io/tally/" },
  { name: "HANDOFF", url: "https://lambwright.github.io/handoff/" },
  { name: "LEDGER", url: "https://lambwright.github.io/ledger/" },
  { name: "CRM", url: "https://lambwright.github.io/crm/" },
];
const HELM_LINK = { name: "HELM", url: "https://lambwright.github.io/helm/" };
const CURRENT_APP = "HANDOFF";

// Only apps this user can open, then HELM always last (it's where settings
// live). No apps granted = nothing but this app and HELM (access fails
// closed — see auth-worker/README.md).
function appLinks(user) {
  const apps = (Array.isArray(user?.apps) ? user.apps : []).map((a) => String(a).toUpperCase());
  const allowed = (name) => apps.includes(name);
  return [...APP_LINKS.filter((a) => a.name === CURRENT_APP || allowed(a.name)), HELM_LINK].map((a) => ({
    ...a,
    current: a.name === CURRENT_APP,
  }));
}

const NAV = [
  { hash: "#/", label: "Dashboard" },
  { hash: "#/bids", label: "Start a Handoff", roles: ["estimator", "admin"] },
];

// `embed` (Procore Full Screen tool): drop the cross-app switcher — Procore
// owns the chrome and jumping to PUNCH/SCOUT/etc from inside it makes no sense.
// `minimal` (project-level tool): also drop the nav — it's a single scoped view.
export default function Header({ user, actor, currentHash, onLogout, embed = false, minimal = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const role = actor?.role;
  const canAdmin = role === "admin";
  const canAssign = role === "assignment" || role === "admin";

  return (
    <div className="header">
      <div>
        <div className="header-badge app-switcher" ref={ref}>
          <span
            className="header-badge-name"
            style={{ cursor: embed ? "default" : "pointer" }}
            onClick={(e) => {
              if (embed) return;
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            HANDOFF{!embed && <span className="app-switcher-caret">▾</span>}
          </span>
          <span className="header-badge-sub">Bid Board → Portfolio Handoff</span>
          {!embed && <span className="header-brand-tag">An Einbau Product</span>}
          {open && !embed && (
            <div className="app-switcher-menu">
              {appLinks(user).map((app) => (
                <a className={`app-switcher-item${app.current ? " current" : ""}`} href={app.url} key={app.name}>
                  {app.name}
                </a>
              ))}
            </div>
          )}
        </div>
        {actor && !minimal && (
          <nav className="header-nav">
            {NAV.filter((n) => !n.roles || n.roles.includes(role)).map((n) => (
              <a key={n.hash} className={currentHash.startsWith(n.hash) && (n.hash !== "#/" || currentHash === "#/") ? "current" : ""} href={n.hash}>
                {n.label}
              </a>
            ))}
            {(canAssign || canAdmin) && (
              <a className={currentHash.startsWith("#/admin") ? "current" : ""} href="#/admin">
                {canAdmin ? "Admin" : "PM Affinity"}
              </a>
            )}
          </nav>
        )}
      </div>
      {user && (
        <div className="header-user">
          <div style={{ textAlign: "right" }}>
            <div className="header-username">{user.displayName || user.username}</div>
            {role && <div className="header-role">{role}</div>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
