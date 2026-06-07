import { useState } from "react";
import { supabase } from "./supabaseClient";

const T = {
  bg: "#FAFAF8", surface: "#FFFFFF", border: "#E8E6E1",
  text: "#1A1917", textSub: "#6B6760", textMuted: "#A8A49D",
  accent: "#2D5BE3", accentSoft: "#EEF1FC",
  red: "#C0392B", redSoft: "#FDECEA",
  green: "#1A7A4A", greenSoft: "#E8F5EE",
  radius: "14px", radiusSm: "10px",
  shadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 32px rgba(0,0,0,0.08)",
};

export default function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login"); // login | register | reset
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [msg, setMsg]           = useState("");

  const clear = () => { setError(""); setMsg(""); };

  const handleLogin = async () => {
    if (!email || !password) { setError("กรุณากรอก email และรหัสผ่าน"); return; }
    setLoading(true); clear();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message === "Invalid login credentials" ? "Email หรือรหัสผ่านไม่ถูกต้อง" : error.message);
    else onAuth(data.user);
  };

  const handleRegister = async () => {
    if (!email || !password) { setError("กรุณากรอก email และรหัสผ่าน"); return; }
    if (password.length < 6) { setError("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"); return; }
    setLoading(true); clear();
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) setError(error.message);
    else if (data.user && !data.session) {
      setMsg("ส่ง confirmation email แล้วครับ — กรุณายืนยัน email ก่อน login");
      setMode("login");
    } else if (data.user) {
      onAuth(data.user);
    }
  };

  const handleReset = async () => {
    if (!email) { setError("กรุณากรอก email ก่อน"); return; }
    setLoading(true); clear();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setLoading(false);
    if (error) setError(error.message);
    else setMsg("ส่ง reset link ไปที่ email แล้วครับ — กรุณาเช็ค inbox");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      if (mode === "login") handleLogin();
      else if (mode === "register") handleRegister();
      else handleReset();
    }
  };

  return (
    <div style={{
      minHeight: "100vh", background: T.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px 16px",
      fontFamily: "-apple-system,'SF Pro Display','Helvetica Neue',sans-serif",
      WebkitFontSmoothing: "antialiased",
    }}>
      <style>{`*{box-sizing:border-box;margin:0;padding:0;}`}</style>

      <div style={{
        width: "100%", maxWidth: 400,
        background: T.surface, borderRadius: T.radius,
        border: `1px solid ${T.border}`, boxShadow: T.shadow,
        padding: "36px 32px",
      }}>

        {/* Logo / Title */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <img src="/apple-touch-icon.png" alt="Bodii Now"
            style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 12px", display: "block", objectFit: "cover" }} />
          <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>Bodii Now</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            {mode === "login"    && "เข้าสู่ระบบเพื่อดูข้อมูลของคุณ"}
            {mode === "register" && "สร้างบัญชีใหม่ฟรี"}
            {mode === "reset"    && "รีเซ็ตรหัสผ่าน"}
          </div>
        </div>

        {/* Error / Success message */}
        {error && (
          <div style={{ background: T.redSoft, border: `1px solid ${T.red}20`, borderRadius: T.radiusSm, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: T.red }}>
            {error}
          </div>
        )}
        {msg && (
          <div style={{ background: T.greenSoft, border: `1px solid ${T.green}20`, borderRadius: T.radiusSm, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: T.green }}>
            {msg}
          </div>
        )}

        {/* Fields */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>EMAIL</div>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="you@example.com"
            autoComplete="email"
            style={{
              width: "100%", padding: "12px 14px",
              border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
              fontSize: 15, color: T.text, background: T.bg,
              outline: "none", fontFamily: "inherit",
            }}
          />
        </div>

        {mode !== "reset" && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>รหัสผ่าน</div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={mode === "register" ? "อย่างน้อย 6 ตัวอักษร" : "••••••••"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              style={{
                width: "100%", padding: "12px 14px",
                border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                fontSize: 15, color: T.text, background: T.bg,
                outline: "none", fontFamily: "inherit",
              }}
            />
          </div>
        )}

        {/* Primary button */}
        <button
          onClick={mode === "login" ? handleLogin : mode === "register" ? handleRegister : handleReset}
          disabled={loading}
          style={{
            width: "100%", padding: "13px",
            background: loading ? T.border : T.accent,
            color: loading ? T.textMuted : "#fff",
            border: "none", borderRadius: T.radiusSm,
            fontSize: 15, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "inherit", transition: "background 0.2s",
          }}
        >
          {loading ? "กำลังดำเนินการ…" : mode === "login" ? "เข้าสู่ระบบ" : mode === "register" ? "สร้างบัญชี" : "ส่ง Reset Link"}
        </button>

        {/* Mode switchers */}
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          {mode === "login" && (
            <>
              <button onClick={() => { setMode("register"); clear(); }}
                style={{ background: "none", border: "none", fontSize: 13, color: T.accent, cursor: "pointer", fontFamily: "inherit" }}>
                ยังไม่มีบัญชี? สมัครใหม่ฟรี
              </button>
              <button onClick={() => { setMode("reset"); clear(); }}
                style={{ background: "none", border: "none", fontSize: 12, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
                ลืมรหัสผ่าน?
              </button>
            </>
          )}
          {mode !== "login" && (
            <button onClick={() => { setMode("login"); clear(); }}
              style={{ background: "none", border: "none", fontSize: 13, color: T.accent, cursor: "pointer", fontFamily: "inherit" }}>
              ← กลับไป Login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
