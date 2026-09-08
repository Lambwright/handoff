import { useEffect, useRef, useState } from "react";

// Same suite app-switcher the other apps carry (ported from TALLY's, which
// ported it from scout-intake's).
function appLinks() {
  return [
    { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
    { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
    { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
    { name: "TALLY", url: "https://lambwright.github.io/tally/" },
    { name: "HANDOFF", url: "https://lambwright.github.io/handoff/", current: true },
  ];
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
              {appLinks().map((app) => (
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
