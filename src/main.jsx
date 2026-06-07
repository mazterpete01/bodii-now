import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { supabase } from "./supabaseClient";
import App from "./App";
import AuthScreen from "./AuthScreen";

function Root() {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // ── Check existing session on first load ──────────────────────
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // ── Listen for login / logout events ─────────────────────────
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontFamily: "-apple-system,sans-serif", color: "#A8A49D", fontSize: 14,
        background: "#FAFAF8",
      }}>
        กำลังโหลด…
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuth={setUser} />;
  }

  return (
    <App
      userId={user.id}
      userEmail={user.email}
      onLogout={handleLogout}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
