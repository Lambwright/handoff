import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import Dashboard from "./components/Dashboard.jsx";
import BidPicker from "./components/BidPicker.jsx";
import PurgatoryGate from "./components/PurgatoryGate.jsx";
import Assignment from "./components/Assignment.jsx";
import HandoffBrief from "./components/HandoffBrief.jsx";
import Admin from "./components/Admin.jsx";

function parseHash(hash) {
  const h = hash.replace(/^#/, "") || "/";
  let m;
  if ((m = h.match(/^\/project\/([^/]+)\/gate$/))) return { view: "gate", id: m[1] };
  if ((m = h.match(/^\/project\/([^/]+)\/assignment$/))) return { view: "assignment", id: m[1] };
  if ((m = h.match(/^\/project\/([^/]+)\/brief$/))) return { view: "brief", id: m[1] };
  if (h === "/bids") return { view: "bids" };
  if (h === "/admin") return { view: "admin" };
  return { view: "dashboard" };
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [actor, setActor] = useState(null);
  const [route, setRoute] = useState(parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const bootstrap = useCallback(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthState("out");
      return;
    }
    verify(token).then((data) => {
      if (!data.valid) {
        setAuthState("out");
        return;
      }
      setUser(data.user);
      // /me resolves the HANDOFF-side role (or null if none assigned yet) —
      // separate from Einbau ID validity, which /auth/verify already confirmed.
      api
        .me()
        .then((meData) => {
          setActor(meData.actor || null);
          setAuthState("in");
        })
        .catch(() => {
          setActor(null);
          setAuthState("in");
        });
    });
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  function handleLoggedIn() {
    bootstrap();
  }
  function handleLogout() {
    doLogout();
    setUser(null);
    setActor(null);
    setAuthState("out");
  }

  if (authState === "checking") {
    return (
      <div className="login-screen">
        <span className="spinner-inline">Checking session…</span>
      </div>
    );
  }
  if (authState === "out") {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  if (!actor) {
    return (
      <>
        <Header user={user} actor={null} currentHash="" onLogout={handleLogout} />
        <div className="container">
          <div className="card">
            <div className="card-title">No HANDOFF role yet</div>
            <p>
              You're logged in as <strong>{user.displayName || user.username}</strong>, but an admin hasn't given you a HANDOFF role
              (estimator / assignment / pm / admin) yet. Ask an admin to add you in Admin → Users.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header user={user} actor={actor} currentHash={window.location.hash || "#/"} onLogout={handleLogout} />
      <div className="container">
        {route.view === "dashboard" && <Dashboard actor={actor} />}
        {route.view === "bids" && <BidPicker />}
        {route.view === "gate" && <PurgatoryGate projectId={route.id} />}
        {route.view === "assignment" && <Assignment projectId={route.id} />}
        {route.view === "brief" && <HandoffBrief projectId={route.id} />}
        {route.view === "admin" && <Admin actor={actor} />}
      </div>
    </>
  );
}
