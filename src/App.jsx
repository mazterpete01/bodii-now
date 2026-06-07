import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";

// ─── Design Tokens (Apple style — unchanged) ──────────────────────
const T = {
  bg: "#FAFAF8", surface: "#FFFFFF", surfaceAlt: "#F5F4F1",
  border: "#E8E6E1", borderLight: "#F0EEE9",
  text: "#1A1917", textSub: "#6B6760", textMuted: "#A8A49D",
  accent: "#2D5BE3", accentSoft: "#EEF1FC",
  green: "#1A7A4A", greenSoft: "#E8F5EE",
  amber: "#B45309", amberSoft: "#FEF3C7",
  red: "#C0392B", redSoft: "#FDECEA",
  radius: "14px", radiusSm: "10px",
  shadow: "0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)",
  shadowMd: "0 2px 8px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.06)",
};

// ─── Storage helpers (user-scoped) ───────────────────────────────
const STORE         = "vt_v2";
const INJ_STORE     = "vt_inj_v2";
const WEEKLY_STORE  = "vt_weekly_v2";
const PROFILE_STORE = "vt_profile_v1";

// currentUserId is set by App on mount — isolates each user's data
let _uid = "";
function setCurrentUser(uid) { _uid = uid || ""; }
function k(base) { return _uid ? `${_uid}__${base}` : base; }

function getDB()      { try { return JSON.parse(localStorage.getItem(k(STORE)) || "{}"); }  catch { return {}; } }
function setDB(db)    { localStorage.setItem(k(STORE), JSON.stringify(db)); }
function getInj()     { try { return JSON.parse(localStorage.getItem(k(INJ_STORE)) || "[]"); } catch { return []; } }
function setInj(arr)  { localStorage.setItem(k(INJ_STORE), JSON.stringify(arr)); }
function getProfile() { try { return JSON.parse(localStorage.getItem(k(PROFILE_STORE)) || "null"); } catch { return null; } }
function setProfile(p){ localStorage.setItem(k(PROFILE_STORE), JSON.stringify(p)); }

// ─── Supabase Cloud Sync ─────────────────────────────────────
const _ct = {};
function debounceCloud(key, fn, ms = 1500) { clearTimeout(_ct[key]); _ct[key] = setTimeout(fn, ms); }

async function cloudSaveDay(uid, dayKey, data) {
  try { await supabase.from("daily_records").upsert({ user_id: uid, day_key: dayKey, data, updated_at: new Date().toISOString() }, { onConflict: "user_id,day_key" }); } catch(e) { console.warn("cloud save day:", e.message); }
}
async function cloudSaveProfile(uid, profile) {
  try { await supabase.from("user_profiles").upsert({ user_id: uid, profile, updated_at: new Date().toISOString() }, { onConflict: "user_id" }); } catch(e) { console.warn("cloud save profile:", e.message); }
}
async function cloudSaveInj(uid, records) {
  try { await supabase.from("injection_records").upsert({ user_id: uid, records, updated_at: new Date().toISOString() }, { onConflict: "user_id" }); } catch(e) { console.warn("cloud save inj:", e.message); }
}
async function cloudSaveWeekly(uid, notes) {
  try { await supabase.from("weekly_notes").upsert({ user_id: uid, notes, updated_at: new Date().toISOString() }, { onConflict: "user_id" }); } catch(e) { console.warn("cloud save weekly:", e.message); }
}
async function cloudPullAll(uid) {
  try {
    const [days, prof, inj, wk] = await Promise.all([
      supabase.from("daily_records").select("day_key, data").eq("user_id", uid),
      supabase.from("user_profiles").select("profile").eq("user_id", uid).maybeSingle(),
      supabase.from("injection_records").select("records").eq("user_id", uid).maybeSingle(),
      supabase.from("weekly_notes").select("notes").eq("user_id", uid).maybeSingle(),
    ]);
    if (days.data?.length) localStorage.setItem(k(STORE), JSON.stringify(Object.fromEntries(days.data.map(r => [r.day_key, r.data]))));
    if (prof.data?.profile) localStorage.setItem(k(PROFILE_STORE), JSON.stringify(prof.data.profile));
    if (inj.data?.records) localStorage.setItem(k(INJ_STORE), JSON.stringify(inj.data.records));
    if (wk.data?.notes) localStorage.setItem(k(WEEKLY_STORE), JSON.stringify(wk.data.notes));
  } catch(e) { console.warn("Cloud pull failed, using local cache:", e.message); }
}
async function uploadPhoto(uid, dayKey, side, file) {
  const path = `${uid}/${dayKey}/${side}`;
  const { error } = await supabase.storage.from("progress-photos").upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return supabase.storage.from("progress-photos").getPublicUrl(path).data.publicUrl;
}

// ─── BMR & Macro Calculator ──────────────────────────────────
function calcBMR(gender, weight, height, age) {
  if (!weight || !height || !age) return null;
  const w = parseFloat(weight), h = parseFloat(height), a = parseFloat(age);
  if (gender === "male") return Math.round(10 * w + 6.25 * h - 5 * a + 5);
  return Math.round(10 * w + 6.25 * h - 5 * a - 161);
}
function calcTDEE(bmr, activity) {
  if (!bmr) return null;
  const map = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  return Math.round(bmr * (map[activity] || 1.375));
}
function calcMacros(kcal, ratioP, ratioC, ratioF) {
  return {
    protein: Math.round((kcal * ratioP / 100) / 4),
    carb:    Math.round((kcal * ratioC / 100) / 4),
    fat:     Math.round((kcal * ratioF / 100) / 9),
  };
}
function buildCLItems(profile) {
  const bw = profile?.startWeight || 0;
  const proMin = bw ? Math.round(bw * 1.0) : null;
  const proMax = bw ? Math.round(bw * 1.5) : null;
  const proLabel = proMin
    ? `ทานโปรตีนขั้นต่ำ ${proMin}–${proMax}g (1.0–1.5× น้ำหนักตัว)`
    : "ทานโปรตีนขั้นต่ำ — (กรอกน้ำหนักในโปรไฟล์เพื่อดูค่า)";

  if (!profile) return [
    { key: "kcal_ok",  label: "Calories อยู่ในกรอบเป้าหมาย" },
    { key: "pro_bw",   label: proLabel },
    { key: "water_ok", label: "น้ำ ≥ 2,000 ml" },
    { key: "veg_ok",   label: "มีผักอย่างน้อย 2 มื้อ" },
    { key: "no_fried", label: "ไม่มีของทอด" },
    { key: "no_sweet", label: "ไม่มีน้ำหวาน / ชานม" },
    { key: "no_alc",   label: "ไม่มีแอลกอฮอล์" },
    { key: "steps_ok", label: "Steps ถึงเป้าหมาย" },
    { key: "sleep_ok", label: "นอนถึงเป้าหมาย" },
    { key: "ex_ok",    label: "ออกกำลังกายตามแผน" },
  ];
  const g = profile.goals;
  return [
    { key: "kcal_ok",  label: `Calories ไม่เกิน ${g.kcalTarget?.toLocaleString()} kcal` },
    { key: "pro_bw",   label: proLabel },
    { key: "water_ok", label: `น้ำ ≥ ${(g.waterTarget||2000).toLocaleString()} ml` },
    { key: "veg_ok",   label: "มีผักอย่างน้อย 2 มื้อ" },
    { key: "no_fried", label: "ไม่มีของทอด" },
    { key: "no_sweet", label: "ไม่มีน้ำหวาน / ชานม" },
    { key: "no_alc",   label: "ไม่มีแอลกอฮอล์" },
    { key: "steps_ok", label: `Steps ≥ ${(g.stepsTarget||7000).toLocaleString()}` },
    { key: "sleep_ok", label: `นอน ≥ ${g.sleepTarget||6.5} ชม.` },
    { key: "ex_ok",    label: "ออกกำลังกายตามแผน" },
  ];
}
function dateKey(d) {
  const dt = d || new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 800);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// getCLItems() เป็น function ไม่ใช่ constant
// เพื่อให้ sync กับ profile ที่อัปเดตทันที ไม่ต้อง reload
function getCLItems() { return buildCLItems(getProfile()); }
const EX_GROUPS = [
  { group: "Cardio กลางแจ้ง",      types: ["วิ่งกลางแจ้ง","เดินเร็วกลางแจ้ง","ปั่นจักรยานกลางแจ้ง","ว่ายน้ำ","กระโดดเชือก","เล่นกีฬา"] },
  { group: "Cardio เครื่อง/ในร่ม", types: ["วิ่งลู่ (Treadmill)","เครื่องปั่นจักรยาน (Bike)","Elliptical","Rowing Machine","Stair Climber"] },
  { group: "Weight Training",       types: ["Full Body","Upper Body","Lower Body","Push","Pull","Legs","Core/Abs"] },
  { group: "Mind-Body/ยืดหยุ่น",   types: ["Yoga","Pilates","Stretching"] },
  { group: "High Intensity",        types: ["HIIT","Crossfit","Circuit Training"] },
  { group: "อื่นๆ",                 types: ["เดินทั่วไป","อื่นๆ"] },
];
const INJ_SITES = ["หน้าท้อง ซ้าย","หน้าท้อง ขวา","หน้าท้อง กลาง","ต้นขา ซ้าย","ต้นขา ขวา","ต้นแขน ซ้าย","ต้นแขน ขวา"];

// ═══════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════
const Card = ({ children, style = {} }) => (
  <div style={{ background: T.surface, borderRadius: T.radius, border: `1px solid ${T.border}`, boxShadow: T.shadow, padding: "20px", ...style }}>
    {children}
  </div>
);
const Lbl = ({ children }) => (
  <div style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: T.textMuted, marginBottom: "7px" }}>{children}</div>
);
const SectionTitle = ({ children, sub }) => (
  <div style={{ marginBottom: "20px" }}>
    <h2 style={{ fontSize: "20px", fontWeight: 700, color: T.text, margin: 0 }}>{children}</h2>
    {sub && <p style={{ fontSize: "13px", color: T.textSub, margin: "3px 0 0" }}>{sub}</p>}
  </div>
);
const StatusBadge = ({ status }) => {
  const m = { good: { label: "On Track", color: T.green, bg: T.greenSoft }, warn: { label: "Review", color: T.amber, bg: T.amberSoft }, alert: { label: "Alert", color: T.red, bg: T.redSoft } };
  const s = m[status] || m.good;
  return <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 9px", borderRadius: "20px", background: s.bg, color: s.color, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{s.label}</span>;
};
const CustomTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "9px 13px", boxShadow: T.shadowMd, fontSize: "12px" }}>
      <div style={{ color: T.textSub, marginBottom: "3px" }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color || T.text, fontWeight: 600 }}>{p.name}: {p.value}</div>)}
    </div>
  );
};

const Sheet = ({ open, onClose, title, children }) => {
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);
  if (!open) return null;
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 8000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{
        width: "100%", maxWidth: 640, background: T.surface,
        borderRadius: `${T.radius} ${T.radius} 0 0`,
        border: `1px solid ${T.border}`, borderBottom: "none",
        boxShadow: T.shadowMd,
        maxHeight: "88vh", overflowY: "auto",
        animation: "slideUp 0.26s cubic-bezier(0.32,0.72,0,1)",
        paddingBottom: "env(safe-area-inset-bottom, 16px)",
      }}>
        <style>{`@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
        <div style={{ width: 36, height: 3, background: T.border, borderRadius: 2, margin: "12px auto 0" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 10px", borderBottom: `1px solid ${T.borderLight}` }}>
          <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: T.textSub }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: T.textMuted, cursor: "pointer", lineHeight: 1, padding: 0 }}>✕</button>
        </div>
        <div style={{ padding: "16px 20px" }}>{children}</div>
      </div>
    </div>
  );
};

const FieldGroup = ({ children }) => (
  <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, marginBottom: 12, overflow: "hidden" }}>
    {children}
  </div>
);
const FieldRow = ({ label, unit, children }) => (
  <div style={{ display: "flex", alignItems: "center", padding: "0 16px", borderBottom: `1px solid ${T.borderLight}` }}>
    <span style={{ fontSize: 14, color: T.text, minWidth: 110, flexShrink: 0, padding: "12px 0" }}>{label}</span>
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
      {children}
      {unit && <span style={{ fontSize: 12, color: T.textMuted, flexShrink: 0 }}>{unit}</span>}
    </div>
  </div>
);

// ── KEY CHANGE: type="text" for all inputs ──────────────────
const FieldInput = ({ value, onChange, type = "text", placeholder = "" }) => (
  <input
    value={value}
    onChange={onChange}
    type="text"
    placeholder={placeholder}
    autoComplete="off"
    autoCorrect="off"
    autoCapitalize="none"
    spellCheck="false"
    style={{
      border: "none", background: "none", fontFamily: "inherit",
      fontSize: 16, color: T.text, outline: "none",
      padding: "12px 0", textAlign: "right", width: "100%",
    }}
  />
);

const FieldSelect = ({ value, onChange, options }) => (
  <select value={value} onChange={onChange}
    style={{ border: "none", background: "none", fontFamily: "inherit", fontSize: 14, color: T.text, outline: "none", padding: "12px 0", textAlign: "right", appearance: "none", cursor: "pointer" }}>
    {options.map(o => <option key={o} value={o}>{o}</option>)}
  </select>
);

const SheetBtns = ({ onCancel, onConfirm, confirmLabel = "บันทึก" }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 8 }}>
    <button onClick={onCancel} style={{ padding: "12px", border: `1px solid ${T.border}`, background: T.surface, borderRadius: T.radiusSm, fontSize: 14, color: T.textSub, cursor: "pointer", fontFamily: "inherit" }}>ยกเลิก</button>
    <button onClick={onConfirm} style={{ padding: "12px", border: "none", background: T.accent, color: "#fff", borderRadius: T.radiusSm, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{confirmLabel}</button>
  </div>
);

const Toggle = ({ value, onChange, label }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.borderLight}` }}>
    <span style={{ fontSize: 11, color: T.text }}>{label}</span>
    <div onClick={() => onChange(!value)} style={{ width: 42, height: 25, borderRadius: 13, background: value ? T.accent : T.border, position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 19 : 3, width: 19, height: 19, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
    </div>
  </div>
);

const Slider = ({ label, value, onChange, min = 0, max = 10, color = T.accent }) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Lbl>{label}</Lbl>
        <span style={{ fontSize: 17, fontWeight: 700, color, minWidth: 28, textAlign: "right" }}>{value}</span>
      </div>
      <input type="range" min={min} value={value} onChange={onChange}
        style={{ width: "100%", height: 3, appearance: "none", WebkitAppearance: "none", borderRadius: 2, outline: "none", cursor: "pointer", background: `linear-gradient(to right, ${color} ${pct}%, ${T.border} ${pct}%)` }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        <span style={{ fontSize: 10, color: T.textMuted }}>{min}</span>
        <span style={{ fontSize: 10, color: T.textMuted }}>{max}</span>
      </div>
    </div>
  );
};

const MetricTile = ({ label, value, unit, target, onAdd, addBtns, progress }) => (
  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: "16px 18px", boxShadow: T.shadow }}>
    <Lbl>{label}</Lbl>
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "4px 0 10px" }}>
      <span style={{ fontFamily: "monospace", fontSize: 30, fontWeight: 300, color: T.text, lineHeight: 1 }}>{value.toLocaleString()}</span>
      <span style={{ fontSize: 13, color: T.textMuted }}>{unit}</span>
    </div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {addBtns.map(b => (
        <button key={b.label} onClick={() => onAdd(b.val)} style={{ flex: 1, padding: "7px 0", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: T.surfaceAlt, fontSize: 12, color: T.textSub, cursor: "pointer", fontFamily: "monospace", fontWeight: 500 }}>{b.label}</button>
      ))}
    </div>
    <div style={{ height: 2, background: T.borderLight, borderRadius: 1 }}>
      <div style={{ height: "100%", width: `${Math.min(100, progress)}%`, background: T.accent, borderRadius: 1, transition: "width 0.3s" }} />
    </div>
    <div style={{ fontSize: 10, color: T.textMuted, textAlign: "right", marginTop: 4 }}>{value.toLocaleString()} / {target.toLocaleString()} {unit}</div>
  </div>
);

const MacroBar = ({ kcal, protein, carb, fat }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, background: T.border, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, overflow: "hidden", marginTop: 12 }}>
    {[
      { label: "kcal", val: Math.round(kcal), color: T.accent },
      { label: "Protein g", val: Math.round(protein), color: T.green },
      { label: "Carb g", val: Math.round(carb), color: T.amber },
      { label: "Fat g", val: Math.round(fat), color: T.red },
    ].map(c => (
      <div key={c.label} style={{ background: T.surface, padding: "10px 6px", textAlign: "center" }}>
        <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 300, color: c.color }}>{c.val}</div>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginTop: 3 }}>{c.label}</div>
      </div>
    ))}
  </div>
);

const MealCard = ({ meal, onAddFood, onRemoveFood, onRemoveMeal }) => {
  const tot = meal.items.reduce((s, i) => ({ kcal: s.kcal + (+i.kcal || 0), pro: s.pro + (+i.pro || 0), carb: s.carb + (+i.carb || 0), fat: s.fat + (+i.fat || 0) }), { kcal: 0, pro: 0, carb: 0, fat: 0 });
  return (
    <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, marginBottom: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: T.text, flex: 1 }}>{meal.name}</span>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: T.textMuted }}>{Math.round(tot.kcal)} kcal</span>
        <button onClick={onRemoveMeal} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
      </div>
      <div style={{ padding: "6px 14px" }}>
        {meal.items.length === 0 && <div style={{ fontSize: 12, color: T.textMuted, padding: "6px 0" }}>ยังไม่มีเมนู</div>}
        {meal.items.map((item, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${T.borderLight}` }}>
            <span style={{ fontSize: 13, color: T.textSub, flex: 1 }}>{item.food}</span>
            <span style={{ fontFamily: "monospace", fontSize: 10, color: T.textMuted, margin: "0 8px", whiteSpace: "nowrap" }}>{item.kcal} kcal · P{item.pro} C{item.carb} F{item.fat}</span>
            <button onClick={() => onRemoveFood(idx)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          </div>
        ))}
        <button onClick={onAddFood} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 0", fontSize: 11, color: T.textMuted, cursor: "pointer", background: "none", border: "none", borderTop: `1px dashed ${T.border}`, marginTop: 4, width: "100%", textAlign: "left", fontFamily: "inherit", letterSpacing: "0.06em" }}>
          <span style={{ fontSize: 14 }}>+</span> เพิ่มเมนูในมื้อนี้
        </button>
      </div>
    </div>
  );
};

const ExCard = ({ ex, onRemove }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, marginBottom: 6 }}>
    <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: T.accentSoft, color: T.accent, whiteSpace: "nowrap" }}>{ex.type}</span>
    <span style={{ flex: 1, fontSize: 13, color: T.textSub }}>{ex.detail || "—"}{ex.dur ? ` · ${ex.dur} นาที` : ""}</span>
    {ex.kcal ? <span style={{ fontSize: 11, color: T.green, background: T.greenSoft, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>−{(+ex.kcal).toLocaleString()} kcal</span> : null}
    <button onClick={onRemove} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
  </div>
);

const InjCard = ({ inj, onRemove }) => {
  const nauseaColor = v => { const n = +v || 0; return n >= 7 ? T.red : n >= 4 ? T.amber : T.green; };
  return (
    <Card style={{ marginBottom: 12, padding: "16px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{inj.name}</span>
          <span style={{ fontSize: 12, color: T.textMuted, marginLeft: 10 }}>{inj.date} · {inj.time}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: T.accentSoft, color: T.accent }}>{inj.dose} mg</span>
          <button onClick={onRemove} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>ตำแหน่ง: {inj.site} · น้ำหนักก่อนฉีด: {inj.weightBefore || "—"} kg</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {[["Nausea 24h", inj.n24], ["Nausea 48h", inj.n48], ["Nausea 72h", inj.n72]].map(([lbl, v]) => (
          <div key={lbl} style={{ textAlign: "center", background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "10px 6px" }}>
            <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 300, color: nauseaColor(v) }}>{v || "—"}</div>
            <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{lbl}</div>
          </div>
        ))}
      </div>
      {inj.note && <div style={{ marginTop: 10, fontSize: 12, color: T.textSub, padding: "8px 12px", background: T.surfaceAlt, borderRadius: T.radiusSm }}>{inj.note}</div>}
    </Card>
  );
};

// ═══════════════════════════════════════════════════════════════
// NAV
// ═══════════════════════════════════════════════════════════════
const NAV = [
  { id: "daily",   label: "กรอกข้อมูล", icon: "✦" },
  { id: "review",  label: "Review",      icon: "◈" },
  { id: "inj",     label: "ฉีดยา",       icon: "◉" },
  { id: "data",    label: "Data",        icon: "◷" },
  { id: "profile", label: "My Profile",  icon: "◎" },
];
const Sidebar = ({ active, onNav }) => (
  <div style={{ width: 210, minHeight: "100vh", background: T.surface, borderRight: `1px solid ${T.border}`, padding: "28px 14px", display: "flex", flexDirection: "column", position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 100, boxSizing: "border-box" }}>
    <div style={{ padding: "0 8px 28px", display: "flex", alignItems: "center", gap: 9 }}>
      <img src="/apple-touch-icon.png" alt="logo" style={{ width: 32, height: 32, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
      <div style={{ lineHeight: 1.1 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: "#2D5BE3" }}>Bodii</span>
        <span style={{ fontSize: 17, fontWeight: 700, color: "#0E1726" }}> Now</span>
      </div>
    </div>
    <nav style={{ flex: 1 }}>
      {NAV.map(item => {
        const active_ = active === item.id;
        return (
          <button key={item.id} onClick={() => onNav(item.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "10px 11px", borderRadius: 9, border: "none", background: active_ ? T.accentSoft : "transparent", color: active_ ? T.accent : T.textSub, cursor: "pointer", fontSize: 13, fontWeight: active_ ? 600 : 400, marginBottom: 2, textAlign: "left", transition: "all 0.15s", WebkitTapHighlightColor: "transparent" }}>
            <span style={{ fontSize: 15 }}>{item.icon}</span>{item.label}
          </button>
        );
      })}
    </nav>
    <div style={{ padding: "14px 10px 0", borderTop: `1px solid ${T.border}`, fontSize: 11, color: T.textMuted }}>
      <div style={{ fontWeight: 600, color: T.textSub }}>{new Date().toLocaleDateString("th-TH", { weekday: "long" })}</div>
      <div>{new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long" })}</div>
    </div>
  </div>
);
const BottomBar = ({ active, onNav }) => (
  <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200, background: "rgba(255,255,255,0.92)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", borderTop: `1px solid ${T.border}`, display: "flex", paddingBottom: "env(safe-area-inset-bottom, 8px)" }}>
    {NAV.map(item => {
      const active_ = active === item.id;
      return (
        <button key={item.id} onClick={() => onNav(item.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "10px 4px 6px", border: "none", background: "transparent", cursor: "pointer", color: active_ ? T.accent : T.textMuted, WebkitTapHighlightColor: "transparent" }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
          <span style={{ fontSize: 9, fontWeight: active_ ? 700 : 500, letterSpacing: "0.03em" }}>{item.label}</span>
        </button>
      );
    })}
  </div>
);

// ═══════════════════════════════════════════════════════════════
// PAGE: DAILY INPUT
// ═══════════════════════════════════════════════════════════════
function DailyPage({ currentDate, onSave }) {
  const key = dateKey(currentDate);
  const db = getDB();
  const saved = db[key] || {};

  const [weight, setWeight] = useState(saved.weight || "");
  const [waist, setWaist] = useState(saved.waist || "");
  const [hip, setHip] = useState(saved.hip || "");
  const [thigh, setThigh] = useState(saved.thigh || "");
  const [bf, setBf] = useState(saved.bf || "");
  const [muscle, setMuscle] = useState(saved.muscle || "");

  const [meals, setMeals] = useState(saved.meals || []);
  const [exercises, setExercises] = useState(saved.exercises || []);
  const [water, setWater] = useState(saved.water || 0);
  const [steps, setSteps] = useState(saved.steps || 0);

  const [hunger, setHunger] = useState(saved.hunger ?? 5);
  const [fullness, setFullness] = useState(saved.fullness ?? 5);
  const [energy, setEnergy] = useState(saved.energy ?? 7);
  const [stress, setStress] = useState(saved.stress ?? 3);
  const [sleep, setSleep] = useState(saved.sleep || "");

  const [nausea, setNausea] = useState(saved.nausea ?? 0);
  const [dizzy, setDizzy] = useState(saved.dizzy ?? 0);
  const [pain, setPain] = useState(saved.pain ?? 0);
  const [constipation, setConstipation] = useState(saved.constipation || "");
  const [vomit, setVomit] = useState(saved.vomit || "");
  const [bm, setBm] = useState(saved.bm || "");
  const [symNote, setSymNote] = useState(saved.symNote || "");

  const [checks, setChecks] = useState(saved.checks || {});
  const [dayNote, setDayNote] = useState(saved.dayNote || "");
  const [photos, setPhotos] = useState(saved.photos || {});

  const [savedToast, setSavedToast] = useState(false);
  const [foodSheet, setFoodSheet] = useState(false);
  const [curMealId, setCurMealId] = useState(null);
  const [foodForm, setFoodForm] = useState({ food: "", kcal: "", pro: "", carb: "", fat: "" });

  const [exSheet, setExSheet] = useState(false);
  const [exForm, setExForm] = useState({ type: "วิ่งกลางแจ้ง", detail: "", dur: "", kcal: "", rpe: "" });

  let mealIdRef = useRef(meals.length ? Math.max(...meals.map(m => m.id)) + 1 : 1);
  let exIdRef = useRef(exercises.length ? Math.max(...exercises.map(e => e.id)) + 1 : 1);

  const isFirstRender = useRef(true);
  useEffect(() => {
    const data = { weight, waist, hip, thigh, bf, muscle, meals, exercises, water, steps, hunger, fullness, energy, stress, sleep, nausea, dizzy, pain, constipation, vomit, bm, symNote, checks, dayNote, photos };
    const db = getDB(); db[key] = data; setDB(db);
    onSave && onSave();
    // Cloud sync (debounced 1.5s to avoid hammering on every keystroke)
    if (_uid) debounceCloud(`day_${key}`, () => cloudSaveDay(_uid, key, data), 1500);
    if (!isFirstRender.current) {
      setSavedToast(true);
      clearTimeout(window._saveToastTimer);
      window._saveToastTimer = setTimeout(() => setSavedToast(false), 1500);
    }
    isFirstRender.current = false;
  }, [weight, waist, hip, thigh, bf, muscle, meals, exercises, water, steps, hunger, fullness, energy, stress, sleep, nausea, dizzy, pain, constipation, vomit, bm, symNote, checks, dayNote, photos]);

  const macros = meals.reduce((s, m) => {
    m.items.forEach(i => { s.kcal += (+i.kcal || 0); s.pro += (+i.pro || 0); s.carb += (+i.carb || 0); s.fat += (+i.fat || 0); });
    return s;
  }, { kcal: 0, pro: 0, carb: 0, fat: 0 });
  const exKcal = exercises.reduce((s, e) => s + (+e.kcal || 0), 0);
  const netKcal = Math.round(macros.kcal - exKcal);
  const compliance = getCLItems().filter(i => checks[i.key]).length;

  const addMeal = () => {
    const id = mealIdRef.current++;
    setMeals(prev => [...prev, { id, name: `มื้อที่ ${prev.length + 1}`, items: [] }]);
  };
  const openFoodSheet = (mealId) => { setCurMealId(mealId); setFoodForm({ food: "", kcal: "", pro: "", carb: "", fat: "" }); setFoodSheet(true); };
  const confirmFood = () => {
    if (!foodForm.food.trim()) return;
    setMeals(prev => prev.map(m => m.id === curMealId ? { ...m, items: [...m.items, { ...foodForm }] } : m));
    setFoodSheet(false);
  };
  const removeFood = (mealId, idx) => setMeals(prev => prev.map(m => m.id === mealId ? { ...m, items: m.items.filter((_, i) => i !== idx) } : m));
  const removeMeal = (id) => setMeals(prev => prev.filter(m => m.id !== id));

  const openExSheet = () => { setExForm({ type: EX_GROUPS[0].types[0], detail: "", dur: "", kcal: "", rpe: "" }); setExSheet(true); };
  const confirmEx = () => { setExercises(prev => [...prev, { id: exIdRef.current++, ...exForm }]); setExSheet(false); };
  const removeEx = (id) => setExercises(prev => prev.filter(e => e.id !== id));

  const addWater = (n) => setWater(v => Math.max(0, v + n));
  const addSteps = (n) => setSteps(v => Math.max(0, v + n));
  const toggleCheck = (key) => setChecks(prev => ({ ...prev, [key]: !prev[key] }));

  const handlePhoto = async (side, e) => {
    const file = e.target.files[0]; if (!file) return;
    if (_uid) {
      try {
        const url = await uploadPhoto(_uid, key, side, file);
        setPhotos(prev => ({ ...prev, [side]: url }));
        return;
      } catch(err) { console.warn("Photo upload failed, using local fallback:", err.message); }
    }
    // Fallback: base64 (offline / no uid)
    const reader = new FileReader();
    reader.onload = ev => setPhotos(prev => ({ ...prev, [side]: ev.target.result }));
    reader.readAsDataURL(file);
  };

  const sectionStyle = { marginBottom: 20 };
  const sectionHeaderStyle = { fontSize: 13, fontWeight: 600, color: T.textSub, marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${T.borderLight}` };

  // ── Shared plain-text input style ────────────────────────────
  const plainInput = {
    flex: 1, border: "none", background: "none",
    fontFamily: "monospace", fontSize: 22, fontWeight: 300,
    color: T.text, outline: "none", padding: 0, width: "100%",
  };

  return (
    <div>
      {/* Auto-save toast */}
      {savedToast && (
        <div style={{ position:"fixed", bottom:80, left:"50%", transform:"translateX(-50%)", background:"#1a1a2e", color:"#fff", fontSize:12, padding:"8px 18px", borderRadius:20, zIndex:9999, boxShadow:"0 4px 12px rgba(0,0,0,0.2)", pointerEvents:"none", opacity:0.9 }}>
          ✓ บันทึกแล้ว
        </div>
      )}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text, margin: 0 }}>กรอกข้อมูล</h2>
        <p style={{ fontSize: 13, color: T.textSub, margin: "3px 0 0" }}>
          {currentDate.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      <div style={{ background: T.accent, borderRadius: T.radius, padding: "12px 18px", marginBottom: 20, display: "flex", gap: 0, overflow: "hidden" }}>
        {[
          { label: "Score", val: `${compliance}/10` },
          { label: "kcal", val: Math.round(macros.kcal) },
          { label: "Protein", val: `${Math.round(macros.pro)}g` },
          { label: "Water", val: `${water}ml` },
          { label: "Net kcal", val: netKcal > 0 ? `+${netKcal}` : netKcal },
        ].map((c, i) => (
          <div key={c.label} style={{ flex: 1, textAlign: "center", borderRight: i < 4 ? `1px solid rgba(255,255,255,0.15)` : "none", padding: "0 8px" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", letterSpacing: "0.07em", textTransform: "uppercase" }}>{c.label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 600, color: "#fff", marginTop: 2 }}>{c.val}</div>
          </div>
        ))}
      </div>

      {/* ── A: น้ำหนัก & สัดส่วน ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>⬡ น้ำหนัก & สัดส่วนร่างกาย</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "น้ำหนัก", unit: "kg", val: weight, set: setWeight, ph: "ชั่งตอนเช้าหลังห้องน้ำ" },
            { label: "รอบเอว", unit: "cm", val: waist, set: setWaist, ph: "วัดระดับสะดือ" },
            { label: "รอบสะโพก", unit: "cm", val: hip, set: setHip, ph: "วัดจุดกว้างที่สุด" },
            { label: "รอบต้นขา", unit: "cm", val: thigh, set: setThigh, ph: "วัดกึ่งกลางต้นขา" },
            { label: "Body Fat %", unit: "%", val: bf, set: setBf, ph: "จากเครื่องวัด InBody" },
            { label: "Skeletal Muscle", unit: "kg", val: muscle, set: setMuscle, ph: "จากเครื่องวัด InBody" },
          ].map(f => (
            <div key={f.label}>
              <Lbl>{f.label}</Lbl>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "8px 12px" }}>
                {/* type="text" — plain keyboard */}
                <input value={f.val} onChange={e => f.set(e.target.value)} type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck="false" placeholder={f.ph}
                  style={plainInput} />
                <span style={{ fontSize: 12, color: T.textMuted, flexShrink: 0 }}>{f.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── B: มื้ออาหาร ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>◈ มื้ออาหาร & โภชนาการ</div>
        {meals.map(meal => (
          <MealCard key={meal.id} meal={meal}
            onAddFood={() => openFoodSheet(meal.id)}
            onRemoveFood={(idx) => removeFood(meal.id, idx)}
            onRemoveMeal={() => removeMeal(meal.id)} />
        ))}
        <button onClick={addMeal} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 0", fontSize: 11, color: T.textMuted, cursor: "pointer", background: "none", border: "none", borderTop: `1px dashed ${T.border}`, marginTop: 4, width: "100%", textAlign: "left", fontFamily: "inherit", letterSpacing: "0.06em" }}>
          <span style={{ fontSize: 14 }}>+</span> เพิ่มมื้ออาหาร
        </button>
        <MacroBar kcal={macros.kcal} protein={macros.pro} carb={macros.carb} fat={macros.fat} />
      </Card>

      {/* ── C: ออกกำลังกาย ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>◷ การออกกำลังกาย</div>
        {exercises.map(ex => <ExCard key={ex.id} ex={ex} onRemove={() => removeEx(ex.id)} />)}
        <button onClick={openExSheet} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 0", fontSize: 11, color: T.textMuted, cursor: "pointer", background: "none", border: "none", borderTop: `1px dashed ${T.border}`, marginTop: 4, width: "100%", textAlign: "left", fontFamily: "inherit", letterSpacing: "0.06em" }}>
          <span style={{ fontSize: 14 }}>+</span> เพิ่มการออกกำลังกาย
        </button>
        {exKcal > 0 && (
          <div style={{ textAlign: "right", marginTop: 10, fontSize: 13, color: T.green, fontFamily: "monospace", fontWeight: 600 }}>รวมแคลเผา: {exKcal.toLocaleString()} kcal</div>
        )}
      </Card>

      {/* ── D: น้ำ + ก้าวเดิน ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
        <MetricTile label="น้ำดื่ม" value={water} unit="ml" target={2500}
          progress={(water / 2500) * 100} onAdd={addWater}
          addBtns={[{ label: "+150", val: 150 }, { label: "+250", val: 250 }, { label: "+500", val: 500 }]} />
        <MetricTile label="ก้าวเดิน" value={steps} unit="steps" target={10000}
          progress={(steps / 10000) * 100} onAdd={addSteps}
          addBtns={[{ label: "+500", val: 500 }, { label: "+1k", val: 1000 }, { label: "+5k", val: 5000 }]} />
      </div>

      {/* ── E: ความรู้สึก ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>◉ ความรู้สึก & พฤติกรรม</div>
        <Slider label="ความหิว (Hunger)" value={hunger} onChange={e => setHunger(+e.target.value)} color={T.amber} />
        <Slider label="ความอิ่มแน่น (Fullness)" value={fullness} onChange={e => setFullness(+e.target.value)} color={T.accent} />
        <Slider label="พลังงาน (Energy)" value={energy} onChange={e => setEnergy(+e.target.value)} color={T.green} />
        <Slider label="ความเครียด (Stress)" value={stress} onChange={e => setStress(+e.target.value)} color={T.amber} />
        <div style={{ marginTop: 6 }}>
          <Lbl>ชั่วโมงนอน</Lbl>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "8px 12px", maxWidth: 160 }}>
            <input value={sleep} onChange={e => setSleep(e.target.value)} type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck="false" placeholder="จำนวนชม."
              style={plainInput} />
            <span style={{ fontSize: 12, color: T.textMuted }}>ชม.</span>
          </div>
        </div>
      </Card>

      {/* ── F: อาการ ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>⚠ ติดตามอาการ</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {[
            { label: "คลื่นไส้ (Nausea)", val: nausea, set: setNausea, unit: "/10", max: 10, ph: "0 = ไม่มี" },
            { label: "เวียนหัว (Dizziness)", val: dizzy, set: setDizzy, unit: "/10", max: 10, ph: "0 = ไม่มี" },
            { label: "ปวดท้อง (Pain)", val: pain, set: setPain, unit: "/10", max: 10, ph: "0 = ไม่มี" },
            { label: "ท้องผูก (ติดกี่วัน)", val: constipation, set: setConstipation, unit: "วัน", max: 14, ph: "จำนวนวัน" },
            { label: "อาเจียน", val: vomit, set: setVomit, unit: "ครั้ง", max: 10, ph: "จำนวนครั้ง" },
          ].map(f => {
            const n = +f.val || 0;
            const col = f.max === 10 && n >= 7 ? T.red : f.max === 10 && n >= 4 ? T.amber : T.text;
            return (
              <div key={f.label} style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "12px 14px" }}>
                <Lbl>{f.label}</Lbl>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <input value={f.val} onChange={e => f.set(e.target.value)} type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck="false" placeholder={f.ph}
                    style={{ fontFamily: "monospace", fontSize: 26, fontWeight: 300, color: col, border: "none", background: "none", outline: "none", padding: 0, width: "100%" }} />
                  <span style={{ fontSize: 11, color: T.textMuted }}>{f.unit}</span>
                </div>
              </div>
            );
          })}
          <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "12px 14px" }}>
            <Lbl>ขับถ่าย</Lbl>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {["ปกติ", "ไม่ถ่าย", "ท้องเสีย"].map(v => (
                <button key={v} onClick={() => setBm(bm === v ? "" : v)} style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${bm === v ? T.accent : T.border}`, background: bm === v ? T.accentSoft : T.surface, color: bm === v ? T.accent : T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: bm === v ? 600 : 400 }}>{v}</button>
              ))}
            </div>
          </div>
        </div>
        {nausea >= 7 && <div style={{ background: T.redSoft, borderRadius: T.radiusSm, padding: "9px 13px", fontSize: 13, color: T.red, marginBottom: 12, fontWeight: 500 }}>⚠ คลื่นไส้สูง — พิจารณาปรึกษาแพทย์</div>}
        <Lbl>หมายเหตุ / อาการอื่นๆ</Lbl>
        <textarea value={symNote} onChange={e => setSymNote(e.target.value)} rows={2} placeholder="อาการอื่นๆ หรือข้อสังเกตเพิ่มเติม..."
          style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, fontSize: 14, color: T.text, background: T.surfaceAlt, resize: "vertical", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
      </Card>

      {/* ── G: Checklist ── */}
      <Card style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${T.borderLight}` }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.textSub }}>Checklist</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: compliance >= 8 ? T.green : compliance >= 6 ? T.amber : T.red }}>
            {compliance}<span style={{ fontSize: 13, color: T.textMuted, fontWeight: 400 }}>/10</span>
          </span>
        </div>
        {getCLItems().map(item => <Toggle key={item.key} label={item.label} value={!!checks[item.key]} onChange={() => toggleCheck(item.key)} />)}
      </Card>

      {/* ── H: Progress Photo ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>◷ Progress Photo</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
          {[["front", "หน้าตรง"], ["side", "ด้านข้าง"], ["back", "ด้านหลัง"]].map(([side, label]) => (
            <div key={side} onClick={() => document.getElementById(`photo-${side}`).click()}
              style={{ aspectRatio: "3/4", background: T.surfaceAlt, border: `1px dashed ${T.border}`, borderRadius: T.radiusSm, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden", position: "relative" }}>
              {photos[side]
                ? <img src={photos[side]} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
                : <><span style={{ fontSize: 22, color: T.textMuted }}>+</span><span style={{ fontSize: 10, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 4 }}>{label}</span></>
              }
              <input id={`photo-${side}`} type="file" accept="image/*" style={{ display: "none" }} onChange={e => handlePhoto(side, e)} />
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: T.textMuted, padding: "9px 12px", background: T.surfaceAlt, borderRadius: T.radiusSm, lineHeight: 1.8 }}>
          ถ่ายตอนเช้า · แสงเดิมทุกครั้ง · ชุดเดิม · ระยะห่างเดิม · ทำทุก 2 สัปดาห์
        </div>
      </Card>

      {/* ── I: Day Note ── */}
      <Card style={sectionStyle}>
        <div style={sectionHeaderStyle}>✎ บันทึกประจำวัน</div>
        <textarea value={dayNote} onChange={e => setDayNote(e.target.value)} rows={3} placeholder="สิ่งที่อยากจำ สังเกต หรือรู้สึกวันนี้..."
          style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, fontSize: 14, color: T.text, background: T.surfaceAlt, resize: "vertical", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
      </Card>

      {/* ═══ SLIDE-UP SHEETS ══════════════════════════════════════ */}
      <Sheet open={foodSheet} onClose={() => setFoodSheet(false)} title={`เพิ่มเมนู — ${meals.find(m => m.id === curMealId)?.name || ""}`}>
        <FieldGroup>
          <FieldRow label="ชื่ออาหาร">
            <FieldInput value={foodForm.food} onChange={e => setFoodForm(p => ({ ...p, food: e.target.value }))} placeholder="ชื่อเมนูที่กิน" />
          </FieldRow>
          <FieldRow label="พลังงาน" unit="kcal">
            <FieldInput value={foodForm.kcal} onChange={e => setFoodForm(p => ({ ...p, kcal: e.target.value }))} placeholder="ดูจากฉลาก / แอป" />
          </FieldRow>
          <FieldRow label="Protein" unit="g">
            <FieldInput value={foodForm.pro} onChange={e => setFoodForm(p => ({ ...p, pro: e.target.value }))} placeholder="โปรตีน (กรัม)" />
          </FieldRow>
          <FieldRow label="Carb" unit="g">
            <FieldInput value={foodForm.carb} onChange={e => setFoodForm(p => ({ ...p, carb: e.target.value }))} placeholder="คาร์โบไฮเดรต (กรัม)" />
          </FieldRow>
          <FieldRow label="Fat" unit="g">
            <FieldInput value={foodForm.fat} onChange={e => setFoodForm(p => ({ ...p, fat: e.target.value }))} placeholder="ไขมัน (กรัม)" />
          </FieldRow>
        </FieldGroup>
        <SheetBtns onCancel={() => setFoodSheet(false)} onConfirm={confirmFood} confirmLabel="เพิ่มเมนูนี้" />
      </Sheet>

      <Sheet open={exSheet} onClose={() => setExSheet(false)} title="เพิ่มการออกกำลังกาย">
        <FieldGroup>
          <FieldRow label="ประเภท">
            <select value={exForm.type} onChange={e => setExForm(p => ({ ...p, type: e.target.value }))}
              style={{ border:"none", background:"none", fontFamily:"inherit", fontSize:14, color:T.text, outline:"none", padding:"12px 0", textAlign:"right", appearance:"none", WebkitAppearance:"none", cursor:"pointer", maxWidth:200 }}>
              {EX_GROUPS.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.types.map(t => <option key={t} value={t}>{t}</option>)}
                </optgroup>
              ))}
            </select>
            <span style={{ fontSize: 12, color: T.textMuted }}>›</span>
          </FieldRow>
          <FieldRow label="รายละเอียด">
            <FieldInput value={exForm.detail} onChange={e => setExForm(p => ({ ...p, detail: e.target.value }))} placeholder="ระบุกิจกรรม เช่น วิ่งรอบสวน" />
          </FieldRow>
          <FieldRow label="ระยะเวลา" unit="นาที">
            <FieldInput value={exForm.dur} onChange={e => setExForm(p => ({ ...p, dur: e.target.value }))} placeholder="จำนวนนาที" />
          </FieldRow>
          <FieldRow label="แคลเผา" unit="kcal">
            <FieldInput value={exForm.kcal} onChange={e => setExForm(p => ({ ...p, kcal: e.target.value }))} placeholder="ดูจาก Apple Watch / Garmin" />
          </FieldRow>
          <FieldRow label="RPE" unit="/10">
            <FieldInput value={exForm.rpe} onChange={e => setExForm(p => ({ ...p, rpe: e.target.value }))} placeholder="ความหนัก 1(เบา) - 10(หนักมาก)" />
          </FieldRow>
        </FieldGroup>
        <SheetBtns onCancel={() => setExSheet(false)} onConfirm={confirmEx} confirmLabel="เพิ่มการออกกำลังกาย" />
      </Sheet>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAGE: REVIEW — ภาพรวมพัฒนาการทั้งหมด (Dashboard + Weekly รวมกัน)
// ═══════════════════════════════════════════════════════════════
function ReviewPage() {
  const db = getDB();
  const profile = getProfile();
  const goals = profile?.goals || {};
  const [period, setPeriod] = useState(7);
  const [notes, setNotes] = useState(() => { try { return JSON.parse(localStorage.getItem(k(WEEKLY_STORE)) || "{}"); } catch { return {}; } });
  const saveNotes = (n) => { setNotes(n); localStorage.setItem(k(WEEKLY_STORE), JSON.stringify(n)); if (_uid) debounceCloud("weekly", () => cloudSaveWeekly(_uid, n), 1500); };

  const getDays = (n) => {
    const result = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = dateKey(d);
      result.push({ key, date: d, r: db[key] || null });
    }
    return result;
  };
  const days = getDays(period);
  const recs = days.filter(d => d.r);
  const avg  = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const fmt  = (v, dec = 1) => v !== null && v !== undefined ? (+v).toFixed(dec) : "—";

  // weight
  const weightRecs = recs.filter(d => d.r.weight);
  const weights    = weightRecs.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), weight: +d.r.weight }));
  const wFirst     = weights.length ? weights[0].weight : null;
  const wLast      = weights.length ? weights[weights.length-1].weight : null;
  const wDelta     = wFirst && wLast ? wLast - wFirst : null;
  const avgW       = avg(weights.map(d => d.weight));
  const goalW      = +profile?.goalWeight || null;
  const startW     = +profile?.startWeight || null;
  const wProgress  = goalW && startW && wLast && startW !== goalW
    ? Math.min(100, Math.max(0, Math.round(((startW - wLast) / (startW - goalW)) * 100))) : null;

  // calories & macro
  const kcalData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), kcal: d.r ? Math.round((d.r.meals||[]).reduce((s, m) => s + m.items.reduce((ss, i) => ss + (+i.kcal||0), 0), 0)) : null }));
  const macroData = days.map(d => {
    if (!d.r) return { day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), pro: null, carb: null, fat: null };
    const t = (d.r.meals||[]).reduce((s, m) => { m.items.forEach(i => { s.pro += +i.pro||0; s.carb += +i.carb||0; s.fat += +i.fat||0; }); return s; }, { pro:0, carb:0, fat:0 });
    return { day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), pro: Math.round(t.pro), carb: Math.round(t.carb), fat: Math.round(t.fat) };
  });
  const avgK = avg(kcalData.filter(d => d.kcal).map(d => d.kcal));
  const avgP = avg(macroData.filter(d => d.pro).map(d => d.pro));
  const pros = recs.map(d => (d.r.meals||[]).reduce((s, m) => s + m.items.reduce((ss, i) => ss + (+i.pro||0), 0), 0));
  const proTarget = goals.proteinTarget || 90;
  const proHit = recs.filter((d, i) => pros[i] >= proTarget).length;

  // steps, exercise
  const stepsData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), steps: d.r ? +d.r.steps||null : null }));
  const avgS = avg(stepsData.filter(d => d.steps).map(d => d.steps));
  const exDaysCount = recs.filter(d => d.r?.exercises?.length > 0).length;
  const exData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), exKcal: d.r ? (d.r.exercises||[]).reduce((s, e) => s + (+e.kcal||0), 0)||null : null }));

  // body composition
  const waistData = weightRecs.filter(d => d.r.waist).map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), waist: +d.r.waist }));
  const bfData = weightRecs.filter(d => d.r.bf).map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), bf: +d.r.bf, muscle: +d.r.muscle||null }));

  // wellbeing
  const feelData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), energy: d.r ? (+d.r.energy??null) : null, stress: d.r ? (+d.r.stress??null) : null, sleep: d.r?.sleep ? +d.r.sleep : null }));
  const symData  = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), nausea: d.r ? (+d.r.nausea??null) : null, pain: d.r ? (+d.r.pain??null) : null }));
  const avgNau   = avg(recs.filter(d => d.r.nausea !== undefined).map(d => +d.r.nausea||0));

  // checklist
  const compData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), score: d.r?.checks ? getCLItems().filter(i => d.r.checks[i.key]).length : null }));
  const avgComp  = avg(compData.filter(d => d.score !== null).map(d => d.score));
  const clStats  = getCLItems().map(item => ({ label: item.label, hit: recs.filter(d => d.r.checks?.[item.key]).length, total: recs.length }));

  // targets
  const kcalTgt  = goals.kcalTarget  || 1300;
  const stepsTgt = goals.stepsTarget || 7000;
  const exTgt    = goals.exDaysTarget || 3;

  const kpis = [
    { label: "น้ำหนัก",      val: wLast  ? `${fmt(wLast,1)} kg`  : "—", delta: wDelta !== null ? `${wDelta > 0 ? "+" : ""}${fmt(wDelta,1)} kg` : null, deltaColor: wDelta !== null && wDelta <= 0 ? T.green : T.red, status: wDelta !== null && wDelta <= -0.2 ? "good" : "warn" },
    { label: "Avg Calories",  val: avgK   ? `${Math.round(avgK)} kcal` : "—", status: avgK && avgK >= kcalTgt*0.85 && avgK <= kcalTgt*1.1 ? "good" : "warn" },
    { label: "Avg Protein",   val: avgP   ? `${Math.round(avgP)}g` : "—", status: avgP && avgP >= proTarget ? "good" : "warn" },
    { label: "Avg Steps",     val: avgS   ? Math.round(avgS).toLocaleString() : "—", status: avgS && avgS >= stepsTgt ? "good" : "warn" },
    { label: "Training Days", val: `${exDaysCount}/${days.length}`, status: exDaysCount >= Math.round(exTgt * period / 7) ? "good" : "warn" },
    { label: "Compliance",    val: avgComp ? `${fmt(avgComp,1)}/10` : "—", status: avgComp && avgComp >= 8 ? "good" : "warn" },
  ];

  const DECISIONS = [
    { cond: "ลด 0.4–0.9 kg/week + ไม่เพลีย", action: "ทำแผนเดิมต่อ ✓", type: "good" },
    { cond: "ลดน้อยกว่า 0.3 kg/week ติด 2 สัปดาห์", action: "ลด 100 kcal หรือเพิ่ม steps 1,500 ก้าว/วัน", type: "warn" },
    { cond: "ลดเกิน 1.2 kg/week + เพลียมาก", action: "เพิ่มอาหาร 100–150 kcal/วัน ทันที", type: "alert" },
    { cond: "คลื่นไส้ ≥7/10 ติดหลายวัน", action: "ลดไขมันต่อมื้อ + แบ่งมื้อเล็กลง + แจ้งแพทย์", type: "alert" },
    { cond: "ท้องผูก ≥ 3 วันติดกัน", action: "เพิ่มน้ำ + ผัก + เดิน + ปรึกษาแพทย์ถ้าไม่ดีขึ้น", type: "warn" },
  ];
  const decCol = { good: [T.greenSoft, T.green], warn: [T.amberSoft, T.amber], alert: [T.redSoft, T.red] };

  const CC = { width: "100%", height: 160 };
  const chartCard = (title, content) => (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.accent, marginBottom: 14, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 }}>{title}</div>
      {content}
    </Card>
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <div>
          <h2 style={{ fontSize:20, fontWeight:700, color:T.text, margin:0 }}>Review</h2>
          <p style={{ fontSize:13, color:T.textSub, margin:"3px 0 0" }}>{recs.length} วันที่มีข้อมูล จากทั้งหมด {period} วัน</p>
        </div>
        <div style={{ display:"flex", gap:6, background:T.surfaceAlt, borderRadius:T.radiusSm, padding:3 }}>
          {[7, 14, 30, 90].map(n => (
            <button key={n} onClick={() => setPeriod(n)} style={{ padding:"6px 14px", borderRadius:7, border:"none", background:period===n ? T.surface : "transparent", color:period===n ? T.text : T.textMuted, fontSize:12, fontWeight:period===n ? 600 : 400, cursor:"pointer", boxShadow:period===n ? T.shadow : "none" }}>{n}วัน</button>
          ))}
        </div>
      </div>

      {/* Goal Progress */}
      {wProgress !== null && (
        <Card style={{ marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:T.text }}>เป้าหมายน้ำหนัก</div>
              <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>เริ่ม {startW} kg → ตอนนี้ {fmt(wLast,1)} kg → เป้า {goalW} kg</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:"monospace", fontSize:24, fontWeight:700, color:wProgress>=100 ? T.green : T.accent }}>{wProgress}%</div>
              <div style={{ fontSize:10, color:T.textMuted }}>เสร็จแล้ว</div>
            </div>
          </div>
          <div style={{ height:6, background:T.borderLight, borderRadius:3 }}>
            <div style={{ height:"100%", width:`${wProgress}%`, background:wProgress>=100 ? T.green : T.accent, borderRadius:3, transition:"width 0.5s" }} />
          </div>
          {profile?.goalDate && <div style={{ fontSize:11, color:T.textMuted, marginTop:8 }}>Target date: {profile.goalDate}{wDelta < 0 ? ` · ลดไปแล้ว ${Math.abs(wDelta).toFixed(1)} kg` : ""}</div>}
        </Card>
      )}

      {/* KPI Grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:16 }}>
        {kpis.map((k,i) => (
          <Card key={i} style={{ padding:"14px 16px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
              <Lbl>{k.label}</Lbl><StatusBadge status={k.status} />
            </div>
            <div style={{ fontSize:20, fontWeight:700, color:T.text, lineHeight:1 }}>{k.val}</div>
            {k.delta && <div style={{ fontSize:11, color:k.deltaColor, marginTop:3, fontWeight:600 }}>{k.delta}</div>}
          </Card>
        ))}
      </div>

      {/* KPI vs Target */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:T.accent, marginBottom:14, borderLeft:`3px solid ${T.accent}`, paddingLeft:10 }}>KPI vs Target</div>
        {[
          { label:"น้ำหนักเปลี่ยน",    target:"ลด 0.4–0.9 kg/week", actual:wDelta!==null?`${wDelta>0?"+":""}${fmt(wDelta,1)} kg`:"—", ok:wDelta!==null&&wDelta<=-0.2&&wDelta>=-1.5 },
          { label:"Avg Calories",       target:`${kcalTgt.toLocaleString()} kcal`, actual:avgK?`${Math.round(avgK)} kcal`:"—", ok:avgK&&avgK>=kcalTgt*0.85&&avgK<=kcalTgt*1.1 },
          { label:"Avg Protein",        target:`≥ ${proTarget}g/วัน`, actual:avgP?`${Math.round(avgP)}g`:"—", ok:avgP&&avgP>=proTarget },
          { label:`Protein ≥${proTarget}g`, target:`≥ ${Math.round(recs.length*0.7)} วัน`, actual:`${proHit}/${recs.length}`, ok:proHit>=Math.round(recs.length*0.7) },
          { label:"Avg Steps",          target:`≥ ${stepsTgt.toLocaleString()}`, actual:avgS?Math.round(avgS).toLocaleString():"—", ok:avgS&&avgS>=stepsTgt },
          { label:"Training Days",      target:`${exTgt} วัน/สัปดาห์`, actual:`${exDaysCount}/${days.length}`, ok:exDaysCount>=Math.round(exTgt*period/7) },
          { label:"Compliance Score",   target:"≥ 8/10", actual:avgComp?`${fmt(avgComp,1)}/10`:"—", ok:avgComp&&avgComp>=8 },
          { label:"Avg Nausea",         target:"≤ 5/10", actual:avgNau!==null?`${fmt(avgNau,1)}/10`:"—", ok:avgNau===null||avgNau<=5 },
        ].map((r,i,arr) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:i<arr.length-1?`1px solid ${T.borderLight}`:"none", gap:12 }}>
            <div>
              <div style={{ fontSize:13, color:T.text, fontWeight:500 }}>{r.label}</div>
              <div style={{ fontSize:11, color:T.textMuted, marginTop:1 }}>{r.target}</div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
              <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:600 }}>{r.actual}</span>
              <span style={{ fontSize:10, fontWeight:700, padding:"3px 9px", borderRadius:20, background:r.ok?T.greenSoft:T.amberSoft, color:r.ok?T.green:T.amber }}>{r.ok?"✓":"!"}</span>
            </div>
          </div>
        ))}
      </Card>

      {/* Checklist Hit Rate */}
      {recs.length > 0 && (
        <Card style={{ marginBottom:16 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:T.accent, marginBottom:14, borderLeft:`3px solid ${T.accent}`, paddingLeft:10 }}>Checklist — อัตราผ่าน {period} วัน</div>
          {clStats.map((c,i) => {
            const pct = c.total ? Math.round((c.hit/c.total)*100) : 0;
            return (
              <div key={i} style={{ marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:12, color:T.text }}>{c.label}</span>
                  <span style={{ fontSize:11, fontFamily:"monospace", color:pct>=80?T.green:pct>=50?T.amber:T.red, fontWeight:700 }}>{c.hit}/{c.total} ({pct}%)</span>
                </div>
                <div style={{ height:4, background:T.borderLight, borderRadius:2 }}>
                  <div style={{ height:"100%", width:`${pct}%`, background:pct>=80?T.green:pct>=50?T.amber:T.red, borderRadius:2, transition:"width 0.3s" }} />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* Decision Rules */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:T.accent, marginBottom:14, borderLeft:`3px solid ${T.accent}`, paddingLeft:10 }}>Decision Rules</div>
        {DECISIONS.map((d,i) => (
          <div key={i} style={{ padding:"10px 14px", marginBottom:8, borderRadius:T.radiusSm, background:decCol[d.type][0], borderLeft:`3px solid ${decCol[d.type][1]}` }}>
            <div style={{ fontSize:11, color:decCol[d.type][1], marginBottom:3 }}>If: {d.cond}</div>
            <div style={{ fontSize:13, fontWeight:600, color:T.text }}>→ {d.action}</div>
          </div>
        ))}
      </Card>

      {/* Charts */}
      {chartCard("น้ำหนัก (kg)", <ResponsiveContainer {...CC}><AreaChart data={weights}><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={T.accent} stopOpacity={0.15}/><stop offset="95%" stopColor={T.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false} domain={["auto","auto"]}/><Tooltip content={<CustomTip/>}/><Area type="monotone" dataKey="weight" stroke={T.accent} strokeWidth={2} fill="url(#wg)" dot={{r:3,fill:T.accent,strokeWidth:0}} connectNulls/></AreaChart></ResponsiveContainer>)}
      {chartCard("Calories รายวัน", <ResponsiveContainer {...CC}><BarChart data={kcalData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="kcal" fill={T.accent} radius={[3,3,0,0]} opacity={0.85}/></BarChart></ResponsiveContainer>)}
      {chartCard("Macro — Protein / Carb / Fat (g)", <ResponsiveContainer {...CC}><BarChart data={macroData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Bar dataKey="pro" name="Protein" fill={T.green} stackId="a"/><Bar dataKey="carb" name="Carb" fill={T.amber} stackId="a"/><Bar dataKey="fat" name="Fat" fill={T.red} stackId="a" radius={[3,3,0,0]}/></BarChart></ResponsiveContainer>)}
      {chartCard("ก้าวเดินรายวัน", <ResponsiveContainer {...CC}><BarChart data={stepsData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="steps" name="Steps" fill={T.green} radius={[3,3,0,0]} opacity={0.8}/></BarChart></ResponsiveContainer>)}
      {chartCard("Exercise Burned (kcal)", <ResponsiveContainer {...CC}><BarChart data={exData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="exKcal" name="Burned kcal" fill={T.green} radius={[3,3,0,0]} opacity={0.75}/></BarChart></ResponsiveContainer>)}
      {waistData.length > 1 && chartCard("รอบเอว (cm)", <ResponsiveContainer {...CC}><LineChart data={waistData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false} domain={["auto","auto"]}/><Tooltip content={<CustomTip/>}/><Line type="monotone" dataKey="waist" stroke={T.red} strokeWidth={2} dot={{r:3,fill:T.red,strokeWidth:0}} connectNulls/></LineChart></ResponsiveContainer>)}
      {bfData.length > 1 && chartCard("Body Fat % & Muscle Mass", <ResponsiveContainer {...CC}><LineChart data={bfData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="bf" name="Body Fat %" stroke={T.amber} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="muscle" name="Muscle (kg)" stroke={T.green} strokeWidth={2} dot={{r:3}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Energy · Stress · นอน (ชม.)", <ResponsiveContainer {...CC}><LineChart data={feelData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="energy" name="Energy" stroke={T.green} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="stress" name="Stress" stroke={T.red} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="sleep" name="นอน (ชม.)" stroke={T.accent} strokeWidth={2} dot={{r:3}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Nausea & Pain (/10)", <ResponsiveContainer {...CC}><LineChart data={symData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="nausea" name="Nausea" stroke={T.amber} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="pain" name="Pain" stroke={T.red} strokeWidth={2} dot={{r:3}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Compliance Score (/10)", <ResponsiveContainer {...CC}><BarChart data={compData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="score" name="Compliance" fill={T.accent} radius={[3,3,0,0]} opacity={0.85}/></BarChart></ResponsiveContainer>)}

      {/* Notes */}
      <Card>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:T.accent, marginBottom:14, borderLeft:`3px solid ${T.accent}`, paddingLeft:10 }}>บันทึก Review</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          {[["good","สิ่งที่ดีช่วงนี้"],["improve","สิ่งที่ต้องปรับ"],["plan","แผนถัดไป"],["note","หมายเหตุ"]].map(([k,label]) => (
            <div key={k}>
              <Lbl>{label}</Lbl>
              <textarea value={notes[k]||""} onChange={e=>saveNotes({...notes,[k]:e.target.value})} rows={3} placeholder={`${label}...`}
                style={{ width:"100%", padding:"10px 12px", border:`1px solid ${T.border}`, borderRadius:T.radiusSm, fontSize:14, color:T.text, background:T.surfaceAlt, resize:"vertical", fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── DashPage stub (not in NAV, kept for reference) ──────────
function DashPage() {
  const [period, setPeriod] = useState(14);
  const db = getDB();

  const getDays = (n) => {
    const result = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const r = db[key] || null;
      result.push({ key, date: d, r });
    }
    return result;
  };

  const days = getDays(period);
  const recs = days.filter(d => d.r);

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const fmt = (v, dec = 1) => v !== null ? v.toFixed(dec) : "—";

  const weights = recs.filter(d => d.r.weight).map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), weight: +d.r.weight }));
  const kcalData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), kcal: d.r ? Math.round(d.r.meals?.reduce((s, m) => s + m.items.reduce((ss, i) => ss + (+i.kcal || 0), 0), 0) || 0) : null }));
  const macroData = days.map(d => {
    if (!d.r) return { day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), pro: null, carb: null, fat: null };
    const t = (d.r.meals || []).reduce((s, m) => { m.items.forEach(i => { s.pro += +i.pro || 0; s.carb += +i.carb || 0; s.fat += +i.fat || 0; }); return s; }, { pro: 0, carb: 0, fat: 0 });
    return { day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), pro: Math.round(t.pro), carb: Math.round(t.carb), fat: Math.round(t.fat) };
  });
  const stepsData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), steps: d.r ? +d.r.steps || null : null }));
  const waistData = recs.filter(d => d.r.waist).map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), waist: +d.r.waist }));
  const feelData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), energy: d.r ? +d.r.energy ?? null : null, stress: d.r ? +d.r.stress ?? null : null }));
  const symData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), nausea: d.r ? +d.r.nausea ?? null : null, pain: d.r ? +d.r.pain ?? null : null }));
  const compData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), score: d.r?.checks ? getCLItems().filter(i => d.r.checks[i.key]).length : null }));
  const bfData = recs.filter(d => d.r.bf).map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), bf: +d.r.bf, muscle: +d.r.muscle || null }));
  const exData = days.map(d => ({ day: d.date.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit" }), exKcal: d.r ? (d.r.exercises || []).reduce((s, e) => s + (+e.kcal || 0), 0) || null : null }));

  const avgW = avg(weights.map(d => d.weight));
  const wDelta = weights.length >= 2 ? weights[weights.length - 1].weight - weights[0].weight : null;
  const avgK = avg(kcalData.filter(d => d.kcal).map(d => d.kcal));
  const avgP = avg(macroData.filter(d => d.pro).map(d => d.pro));
  const avgS = avg(stepsData.filter(d => d.steps).map(d => d.steps));
  const exDays = recs.filter(d => d.r?.exercises?.length > 0).length;
  const avgComp = avg(compData.filter(d => d.score !== null).map(d => d.score));

  const kpis = [
    { label: "Avg Weight", val: avgW ? `${fmt(avgW)} kg` : "—", delta: wDelta !== null ? `${wDelta > 0 ? "+" : ""}${wDelta.toFixed(1)} kg` : null, deltaColor: wDelta !== null && wDelta <= 0 ? T.green : T.red, status: wDelta !== null && wDelta >= -1.2 && wDelta <= -0.3 ? "good" : "warn" },
    { label: "Avg Calories", val: avgK ? `${Math.round(avgK)} kcal` : "—", status: "good" },
    { label: "Avg Protein", val: avgP ? `${Math.round(avgP)}g` : "—", status: avgP && avgP >= 90 ? "good" : "warn" },
    { label: "Avg Steps", val: avgS ? Math.round(avgS).toLocaleString() : "—", status: avgS && avgS >= 7000 ? "good" : "warn" },
    { label: "Training Days", val: `${exDays}/${days.length}`, status: exDays >= 2 ? "good" : "warn" },
    { label: "Compliance", val: avgComp ? fmt(avgComp) : "—", status: avgComp && avgComp >= 8 ? "good" : "warn" },
  ];

  const chartCard = (title, content) => (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.accent, marginBottom: 14, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 }}>{title}</div>
      {content}
    </Card>
  );
  const CL = { width: "100%", height: 160 };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <SectionTitle sub={`${period} วันล่าสุด`}>Dashboard</SectionTitle>
        <div style={{ display: "flex", gap: 6, background: T.surfaceAlt, borderRadius: T.radiusSm, padding: 3 }}>
          {[7, 14, 30, 90].map(n => (
            <button key={n} onClick={() => setPeriod(n)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: period === n ? T.surface : "transparent", color: period === n ? T.text : T.textMuted, fontSize: 12, fontWeight: period === n ? 600 : 400, cursor: "pointer", boxShadow: period === n ? T.shadow : "none" }}>{n}วัน</button>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        {kpis.map((k, i) => (
          <Card key={i} style={{ padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <Lbl>{k.label}</Lbl>
              <StatusBadge status={k.status} />
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.text, lineHeight: 1 }}>{k.val}</div>
            {k.delta && <div style={{ fontSize: 12, color: k.deltaColor, marginTop: 3, fontWeight: 600 }}>{k.delta}</div>}
          </Card>
        ))}
      </div>
      {chartCard("น้ำหนัก (kg)", <ResponsiveContainer {...CL}><AreaChart data={weights}><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={T.accent} stopOpacity={0.15}/><stop offset="95%" stopColor={T.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false} domain={["auto","auto"]}/><Tooltip content={<CustomTip/>}/><Area type="monotone" dataKey="weight" stroke={T.accent} strokeWidth={2} fill="url(#wg)" dot={{r:3,fill:T.accent,strokeWidth:0}} connectNulls/></AreaChart></ResponsiveContainer>)}
      {chartCard("Calories รายวัน (kcal)", <ResponsiveContainer {...CL}><BarChart data={kcalData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="kcal" fill={T.accent} radius={[3,3,0,0]} opacity={0.85}/></BarChart></ResponsiveContainer>)}
      {chartCard("Macro รายวัน — Protein / Carb / Fat (g)", <ResponsiveContainer {...CL}><BarChart data={macroData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Bar dataKey="pro" name="Protein" fill={T.green} stackId="a"/><Bar dataKey="carb" name="Carb" fill={T.amber} stackId="a"/><Bar dataKey="fat" name="Fat" fill={T.red} stackId="a" radius={[3,3,0,0]}/></BarChart></ResponsiveContainer>)}
      {chartCard("ก้าวเดินรายวัน", <ResponsiveContainer {...CL}><BarChart data={stepsData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="steps" name="Steps" fill={T.green} radius={[3,3,0,0]} opacity={0.8}/></BarChart></ResponsiveContainer>)}
      {chartCard("Exercise Burned (kcal)", <ResponsiveContainer {...CL}><BarChart data={exData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="exKcal" name="Burned kcal" fill={T.green} radius={[3,3,0,0]} opacity={0.75}/></BarChart></ResponsiveContainer>)}
      {chartCard("รอบเอว (cm)", <ResponsiveContainer {...CL}><LineChart data={waistData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false} domain={["auto","auto"]}/><Tooltip content={<CustomTip/>}/><Line type="monotone" dataKey="waist" stroke={T.red} strokeWidth={2} dot={{r:3,fill:T.red,strokeWidth:0}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Body Fat % & Muscle Mass", <ResponsiveContainer {...CL}><LineChart data={bfData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="bf" name="Body Fat %" stroke={T.amber} strokeWidth={2} dot={{r:3,fill:T.amber,strokeWidth:0}} connectNulls/><Line type="monotone" dataKey="muscle" name="Muscle (kg)" stroke={T.green} strokeWidth={2} dot={{r:3,fill:T.green,strokeWidth:0}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Energy & Stress", <ResponsiveContainer {...CL}><LineChart data={feelData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="energy" name="Energy" stroke={T.green} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="stress" name="Stress" stroke={T.red} strokeWidth={2} dot={{r:3}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Symptom Tracker (Nausea & Pain /10)", <ResponsiveContainer {...CL}><LineChart data={symData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Legend iconSize={8} wrapperStyle={{fontSize:10}}/><Line type="monotone" dataKey="nausea" name="Nausea" stroke={T.amber} strokeWidth={2} dot={{r:3}} connectNulls/><Line type="monotone" dataKey="pain" name="Pain" stroke={T.red} strokeWidth={2} dot={{r:3}} connectNulls/></LineChart></ResponsiveContainer>)}
      {chartCard("Compliance Score รายวัน (/10)", <ResponsiveContainer {...CL}><BarChart data={compData}><CartesianGrid strokeDasharray="3 3" stroke={T.borderLight} vertical={false}/><XAxis dataKey="day" tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><YAxis domain={[0,10]} tick={{fontSize:10,fill:T.textMuted}} axisLine={false} tickLine={false}/><Tooltip content={<CustomTip/>}/><Bar dataKey="score" name="Compliance" fill={T.accent} radius={[3,3,0,0]} opacity={0.85}/></BarChart></ResponsiveContainer>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAGE: INJECTION LOG
// ═══════════════════════════════════════════════════════════════
function InjPage() {
  const [injections, setInjections] = useState(getInj());
  const [sheet, setSheet] = useState(false);
  const [site, setSite] = useState(INJ_SITES[0]);
  const [form, setForm] = useState({ name: "", date: dateKey(), time: "20:00", dose: "", weightBefore: "", n24: "", n48: "", n72: "", note: "" });

  const confirmInj = () => {
    const inj = { id: Date.now(), site, ...form };
    const updated = [inj, ...injections];
    setInjections(updated); setInj(updated); setSheet(false);
    if (_uid) cloudSaveInj(_uid, updated);
  };
  const removeInj = (id) => { const u = injections.filter(i => i.id !== id); setInjections(u); setInj(u); if (_uid) cloudSaveInj(_uid, u); };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <SectionTitle sub="บันทึกตามที่แพทย์สั่ง">Injection Log</SectionTitle>
        <button onClick={() => { setForm({ name: "", date: dateKey(), time: "20:00", dose: "", weightBefore: "", n24: "", n48: "", n72: "", note: "" }); setSite(INJ_SITES[0]); setSheet(true); }}
          style={{ padding: "10px 18px", background: T.accent, color: "#fff", border: "none", borderRadius: T.radiusSm, fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>+ บันทึกใหม่</button>
      </div>
      {!injections.length && <div style={{ textAlign: "center", padding: "40px 20px", color: T.textMuted, fontSize: 13 }}>ยังไม่มีบันทึก</div>}
      {injections.map(inj => <InjCard key={inj.id} inj={inj} onRemove={() => removeInj(inj.id)} />)}

      <Sheet open={sheet} onClose={() => setSheet(false)} title="บันทึกการฉีดยา">
        <FieldGroup>
          <FieldRow label="ชื่อยา"><FieldInput value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="เช่น Mounjaro" /></FieldRow>
          <FieldRow label="วันที่"><FieldInput value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} placeholder="YYYY-MM-DD" /></FieldRow>
          <FieldRow label="เวลา"><FieldInput value={form.time} onChange={e => setForm(p => ({ ...p, time: e.target.value }))} placeholder="20:00" /></FieldRow>
          <FieldRow label="Dose" unit="mg"><FieldInput value={form.dose} onChange={e => setForm(p => ({ ...p, dose: e.target.value }))} placeholder="ตามที่แพทย์สั่ง" /></FieldRow>
          <FieldRow label="น้ำหนักก่อนฉีด" unit="kg"><FieldInput value={form.weightBefore} onChange={e => setForm(p => ({ ...p, weightBefore: e.target.value }))} placeholder="ชั่งก่อนฉีด" /></FieldRow>
        </FieldGroup>
        <Lbl>ตำแหน่งฉีด</Lbl>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {INJ_SITES.map(s => (
            <button key={s} onClick={() => setSite(s)} style={{ padding: "7px 13px", borderRadius: 20, border: `1px solid ${site === s ? T.accent : T.border}`, background: site === s ? T.accentSoft : T.surface, color: site === s ? T.accent : T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: site === s ? 600 : 400 }}>{s}</button>
          ))}
        </div>
        <FieldGroup>
          <FieldRow label="Nausea 24h" unit="/10"><FieldInput value={form.n24} onChange={e => setForm(p => ({ ...p, n24: e.target.value }))} placeholder="กรอกหลังฉีด 24 ชม." /></FieldRow>
          <FieldRow label="Nausea 48h" unit="/10"><FieldInput value={form.n48} onChange={e => setForm(p => ({ ...p, n48: e.target.value }))} placeholder="กรอกหลังฉีด 48 ชม." /></FieldRow>
          <FieldRow label="Nausea 72h" unit="/10"><FieldInput value={form.n72} onChange={e => setForm(p => ({ ...p, n72: e.target.value }))} placeholder="กรอกหลังฉีด 72 ชม." /></FieldRow>
          <FieldRow label="หมายเหตุ"><FieldInput value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} placeholder="อาการอื่นๆ ที่สังเกตได้" /></FieldRow>
        </FieldGroup>
        <SheetBtns onCancel={() => setSheet(false)} onConfirm={confirmInj} confirmLabel="บันทึกการฉีด" />
      </Sheet>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAGE: WEEKLY REVIEW
// ═══════════════════════════════════════════════════════════════
function WeeklyPage() {
  const db = getDB();
  const [notes, setNotes] = useState(() => { try { return JSON.parse(localStorage.getItem(k(WEEKLY_STORE)) || "{}"); } catch { return {}; } });
  const saveNotes = (n) => { setNotes(n); localStorage.setItem(k(WEEKLY_STORE), JSON.stringify(n)); if (_uid) debounceCloud("weekly", () => cloudSaveWeekly(_uid, n), 1500); };

  const getDays = (n) => { const r = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); r.push({ key: dateKey(d), r: db[dateKey(d)] || null }); } return r; };
  const days = getDays(7);
  const recs = days.filter(d => d.r);

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const weights = recs.filter(d => d.r.weight).map(d => +d.r.weight);
  const wDelta = weights.length >= 2 ? weights[weights.length - 1] - weights[0] : null;
  const kcals = recs.map(d => (d.r.meals || []).reduce((s, m) => s + m.items.reduce((ss, i) => ss + (+i.kcal || 0), 0), 0));
  const avgK = avg(kcals);
  const pros = recs.map(d => (d.r.meals || []).reduce((s, m) => s + m.items.reduce((ss, i) => ss + (+i.pro || 0), 0), 0));
  const avgP = avg(pros);
  const proHit = recs.filter(d => pros[recs.indexOf(d)] >= 90).length;
  const stepsArr = recs.filter(d => d.r.steps).map(d => +d.r.steps);
  const avgS = avg(stepsArr);
  const exDays = recs.filter(d => d.r?.exercises?.length > 0).length;
  const compArr = recs.map(d => d.r.checks ? getCLItems().filter(i => d.r.checks[i.key]).length : 0);
  const avgComp = avg(compArr);
  const nauArr = recs.filter(d => d.r.nausea !== undefined).map(d => +d.r.nausea || 0);
  const avgNau = avg(nauArr);

  const rows = [
    { label: "น้ำหนักเปลี่ยน", target: "ลด 0.4–0.9 kg", actual: wDelta !== null ? `${wDelta > 0 ? "+" : ""}${wDelta.toFixed(1)} kg` : "—", ok: wDelta !== null && wDelta <= -0.3 && wDelta >= -1.2 },
    { label: "Avg Calories", target: "1,100–1,350 kcal", actual: avgK ? `${Math.round(avgK)} kcal` : "—", ok: avgK !== null && avgK >= 1050 && avgK <= 1400 },
    { label: "Avg Protein", target: "≥ 90g / วัน", actual: avgP ? `${Math.round(avgP)}g` : "—", ok: avgP !== null && avgP >= 90 },
    { label: "Protein Hit ≥90g", target: "≥ 5 วัน/สัปดาห์", actual: `${proHit}/${recs.length} วัน`, ok: proHit >= 5 },
    { label: "Avg Steps", target: "≥ 7,000", actual: avgS ? Math.round(avgS).toLocaleString() : "—", ok: avgS !== null && avgS >= 7000 },
    { label: "Training Days", target: "2–3 วัน", actual: `${exDays}/7 วัน`, ok: exDays >= 2 },
    { label: "Compliance", target: "≥ 8/10", actual: avgComp ? `${avgComp.toFixed(1)}/10` : "—", ok: avgComp !== null && avgComp >= 8 },
    { label: "Avg Nausea", target: "≤ 5/10", actual: avgNau !== null ? `${avgNau.toFixed(1)}/10` : "—", ok: avgNau === null || avgNau <= 5 },
  ];

  const DECISIONS = [
    { cond: "ลด 0.4–0.9 kg/week + ไม่เพลีย", action: "ทำแผนเดิมต่อ", type: "good" },
    { cond: "ลดน้อยกว่า 0.3 kg/week ติด 2 สัปดาห์", action: "ลด 100 kcal หรือเพิ่ม steps 1,500 ก้าว/วัน", type: "warn" },
    { cond: "ลดเกิน 1.2 kg/week + เพลียมาก", action: "เพิ่มอาหาร 100–150 kcal/วัน ทันที", type: "alert" },
    { cond: "คลื่นไส้ ≥7/10 ติดหลายวัน", action: "ลดไขมันต่อมื้อ + แบ่งมื้อเล็กลง + แจ้งแพทย์", type: "alert" },
    { cond: "ท้องผูก ≥ 3 วันติดกัน", action: "เพิ่มน้ำ + ผัก + เดิน + ปรึกษาแพทย์ถ้าไม่ดีขึ้น", type: "warn" },
  ];
  const decCol = { good: [T.greenSoft, T.green], warn: [T.amberSoft, T.amber], alert: [T.redSoft, T.red] };

  return (
    <div>
      <SectionTitle sub="7 วันล่าสุด">Weekly Review</SectionTitle>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.accent, marginBottom: 14, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 }}>KPI vs Target</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: i < rows.length - 1 ? `1px solid ${T.borderLight}` : "none", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{r.label}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{r.target}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{r.actual}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: r.ok ? T.greenSoft : T.amberSoft, color: r.ok ? T.green : T.amber }}>{r.ok ? "ON TRACK" : "REVIEW"}</span>
            </div>
          </div>
        ))}
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.accent, marginBottom: 14, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 }}>Decision Rules</div>
        {DECISIONS.map((d, i) => (
          <div key={i} style={{ padding: "10px 14px", marginBottom: 8, borderRadius: T.radiusSm, background: decCol[d.type][0], borderLeft: `3px solid ${decCol[d.type][1]}` }}>
            <div style={{ fontSize: 11, color: decCol[d.type][1], marginBottom: 3 }}>If: {d.cond}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>→ {d.action}</div>
          </div>
        ))}
      </Card>
      <Card>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.accent, marginBottom: 14, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 }}>Weekly Notes</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[["good","สิ่งที่ดีสัปดาห์นี้"],["improve","สิ่งที่ต้องปรับ"],["plan","แผนสัปดาห์หน้า"],["note","หมายเหตุ"]].map(([k,label]) => (
            <div key={k}>
              <Lbl>{label}</Lbl>
              <textarea value={notes[k]||""} onChange={e=>saveNotes({...notes,[k]:e.target.value})} rows={3} placeholder={`${label}...`}
                style={{ width:"100%", padding:"10px 12px", border:`1px solid ${T.border}`, borderRadius:T.radiusSm, fontSize:14, color:T.text, background:T.surfaceAlt, resize:"vertical", fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ═══ DATA PAGE ═══════════════════════════════════════════════
function DataPage() {
  const db = getDB();
  const keys = Object.keys(db).sort().reverse();

  const exportExcel = () => {
    if (typeof XLSX === "undefined") { alert("ต้องเปิดใน browser จริง เพื่อใช้งาน Export"); return; }
    const summaryRows = [["Date","Weight(kg)","Waist(cm)","Hip(cm)","Thigh(cm)","BodyFat%","Muscle(kg)","Calories","Protein(g)","Carb(g)","Fat(g)","Water(ml)","Steps","ExBurned(kcal)","Hunger","Fullness","Energy","Stress","Sleep(h)","Nausea","Dizzy","Pain","Constipation","Vomit","BM","ComplianceScore","DayNote"]];
    const mealRows = [["Date","Meal","Food","Calories","Protein","Carb","Fat"]];
    const exRows = [["Date","Type","Detail","Duration(min)","Burned(kcal)","RPE"]];
    const injections = getInj();
    const injRows = [["Date","Drug","Dose(mg)","Site","WeightBefore","Nausea24h","Nausea48h","Nausea72h","Note"]];
    keys.forEach(key => {
      const r = db[key]; if (!r) return;
      const mac = (r.meals||[]).reduce((s,m)=>{m.items.forEach(i=>{s.kcal+=+i.kcal||0;s.pro+=+i.pro||0;s.carb+=+i.carb||0;s.fat+=+i.fat||0;});return s;},{kcal:0,pro:0,carb:0,fat:0});
      const exK = (r.exercises||[]).reduce((s,e)=>s+(+e.kcal||0),0);
      const comp = r.checks ? getCLItems().filter(i=>r.checks[i.key]).length : 0;
      summaryRows.push([key,r.weight||"",r.waist||"",r.hip||"",r.thigh||"",r.bf||"",r.muscle||"",Math.round(mac.kcal)||"",Math.round(mac.pro)||"",Math.round(mac.carb)||"",Math.round(mac.fat)||"",r.water||"",r.steps||"",exK||"",r.hunger||"",r.fullness||"",r.energy||"",r.stress||"",r.sleep||"",r.nausea||"",r.dizzy||"",r.pain||"",r.constipation||"",r.vomit||"",r.bm||"",comp,r.dayNote||""]);
      (r.meals||[]).forEach(m=>m.items.forEach(i=>mealRows.push([key,m.name,i.food,i.kcal,i.pro,i.carb,i.fat])));
      (r.exercises||[]).forEach(e=>exRows.push([key,e.type,e.detail,e.dur||"",e.kcal||"",e.rpe||""]));
    });
    injections.forEach(i=>injRows.push([i.date,i.name,i.dose,i.site,i.weightBefore,i.n24,i.n48,i.n72,i.note]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "Daily Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mealRows), "Meal Detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(exRows), "Exercise Log");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(injRows), "Injection Log");
    XLSX.writeFile(wb, `VitalTrack_${dateKey()}.xlsx`);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <SectionTitle sub={`${keys.length} วันที่บันทึก`}>Data & Export</SectionTitle>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={exportExcel} style={{ padding:"9px 18px", border:`1px solid ${T.green}`, background:T.greenSoft, color:T.green, borderRadius:T.radiusSm, fontSize:13, fontWeight:600, cursor:"pointer" }}>↓ Export Excel (5WP)</button>
          <button onClick={()=>{ if(confirm("ลบข้อมูลทั้งหมด?")&&confirm("ยืนยัน — ข้อมูลจะหายถาวร")){localStorage.removeItem(k(STORE));localStorage.removeItem(k(INJ_STORE));localStorage.removeItem(k(WEEKLY_STORE));window.location.reload();}}} style={{ padding:"9px 18px", border:`1px solid ${T.border}`, background:T.surface, color:T.textMuted, borderRadius:T.radiusSm, fontSize:13, cursor:"pointer" }}>✕ Clear</button>
        </div>
      </div>
      <Card style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead><tr>{["วันที่","Weight","Waist","kcal","Protein","Carb","Fat","Water","Steps","Ex.kcal","Nausea","Energy","Score"].map(h=>(
            <th key={h} style={{ padding:"8px 12px", textAlign:"left", fontWeight:600, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", color:T.textMuted, borderBottom:`2px solid ${T.border}`, whiteSpace:"nowrap" }}>{h}</th>
          ))}</tr></thead>
          <tbody>{keys.map(key=>{
            const r=db[key]; if(!r) return null;
            const mac=(r.meals||[]).reduce((s,m)=>{m.items.forEach(i=>{s.kcal+=+i.kcal||0;s.pro+=+i.pro||0;s.carb+=+i.carb||0;s.fat+=+i.fat||0;});return s;},{kcal:0,pro:0,carb:0,fat:0});
            const exK=(r.exercises||[]).reduce((s,e)=>s+(+e.kcal||0),0);
            const comp=r.checks?getCLItems().filter(i=>r.checks[i.key]).length:0;
            return(<tr key={key} style={{ borderBottom:`1px solid ${T.borderLight}` }}>
              {[key,r.weight||"—",r.waist||"—",Math.round(mac.kcal)||"—",Math.round(mac.pro)||"—",Math.round(mac.carb)||"—",Math.round(mac.fat)||"—",r.water||"—",r.steps||"—",exK||"—",r.nausea||"—",r.energy||"—",comp].map((v,i)=>(
                <td key={i} style={{ padding:"8px 12px", color:T.textSub, fontFamily:i>0?"monospace":"inherit", whiteSpace:"nowrap" }}>{v}</td>
              ))}
            </tr>);
          })}</tbody>
        </table>
        {!keys.length && <div style={{ textAlign:"center", padding:"32px", color:T.textMuted, fontSize:13 }}>ยังไม่มีข้อมูล — เริ่มกรอกในหน้า กรอกข้อมูล</div>}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAGE: PROFILE SETUP
// ═══════════════════════════════════════════════════════════════
// ── PF — top-level, ห้าม define ใน render function เด็ดขาด ──
// ถ้า define ใน ProfilePage จะ unmount/remount ทุก keystroke
function PF({ label, value, onChange, unit, placeholder }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Lbl>{label}</Lbl>
      <div style={{ display:"flex", alignItems:"baseline", gap:6,
        background:T.surfaceAlt, border:`1px solid ${T.border}`,
        borderRadius:T.radiusSm, padding:"8px 12px" }}>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck="false"
          data-form-type="other"
          style={{ flex:1, border:"none", background:"none",
            fontFamily:"monospace", fontSize:22, fontWeight:300,
            color:T.text, outline:"none", padding:0, width:"100%",
            WebkitUserSelect:"text" }}
        />
        {unit && <span style={{ fontSize:12, color:T.textMuted, flexShrink:0 }}>{unit}</span>}
      </div>
    </div>
  );
}

// ── ProfileSectionHeader — top-level เช่นกัน ────────────────
function ProfileSectionHeader({ children }) {
  return (
    <div style={{ fontSize:13, fontWeight:600, color:T.textSub,
      marginBottom:14, paddingBottom:10,
      borderBottom:`1px solid ${T.borderLight}` }}>{children}</div>
  );
}

const ACTIVITY_OPTIONS = [
  { val: "sedentary",   label: "นั่งทำงานเกือบทั้งวัน", multi: 1.2 },
  { val: "light",       label: "ออกกำลังกายเบา 1–3 วัน/สัปดาห์", multi: 1.375 },
  { val: "moderate",    label: "ออกกำลังกาย 3–5 วัน/สัปดาห์", multi: 1.55 },
  { val: "active",      label: "ออกกำลังกายหนัก 6–7 วัน/สัปดาห์", multi: 1.725 },
  { val: "very_active", label: "นักกีฬา / งานใช้แรงกาย", multi: 1.9 },
];
const GOAL_OPTIONS = [
  { val: "lose_fast", label: "ลดไขมันเร็ว (Deficit ~500 kcal)" },
  { val: "lose",      label: "ลดไขมันสม่ำเสมอ (Deficit ~300 kcal)" },
  { val: "maintain",  label: "คงน้ำหนัก" },
  { val: "gain",      label: "เพิ่มกล้าม (Surplus ~300 kcal)" },
];
const DEFICIT_MAP = { lose_fast: -500, lose: -300, maintain: 0, gain: 300 };

function ProfilePage({ onSaved }) {
  const saved = getProfile() || {};
  const sg = saved.goals || {};

  const [name,         setName]         = useState(saved.name        || "");
  const [gender,       setGender]       = useState(saved.gender      || "male");
  const [age,          setAge]          = useState(saved.age         || "");
  const [height,       setHeight]       = useState(saved.height      || "");
  const [startW,       setStartW]       = useState(saved.startWeight || "");
  const [activity,     setActivity]     = useState(saved.activity    || "light");
  const [bodyGoal,     setBodyGoal]     = useState(saved.bodyGoal    || "lose");
  const [kcalTarget,   setKcalTarget]   = useState(sg.kcalTarget     || "");
  const [ratioKey,     setRatioKey]     = useState(sg.ratioKey       || "35/35/30");
  const [waterTarget,  setWaterTarget]  = useState(sg.waterTarget    || "2000");
  const [stepsTarget,  setStepsTarget]  = useState(sg.stepsTarget    || "8000");
  const [sleepTarget,  setSleepTarget]  = useState(sg.sleepTarget    || "7");
  const [exDaysTarget, setExDaysTarget] = useState(sg.exDaysTarget   || "3");
  const [goalWeight,   setGoalWeight]   = useState(saved.goalWeight   || "");
  const [goalDate,     setGoalDate]     = useState(saved.goalDate     || "");
  const [goalReason,   setGoalReason]   = useState(saved.goalReason   || "");
  const [pcfSheet,     setPcfSheet]     = useState(false);
  const [savedOk,      setSavedOk]      = useState(false);

  const bmr  = calcBMR(gender, startW, height, age);
  const tdee = calcTDEE(bmr, activity);
  const suggestedKcal = tdee ? Math.max(1000, tdee + (DEFICIT_MAP[bodyGoal] || 0)) : null;

  const PCF_PRESETS = [
    { key:"40/40/20", label:"40 / 40 / 20", desc:"High Protein + Carb · Fat ต่ำ · Lean Bulk" },
    { key:"35/35/30", label:"35 / 35 / 30", desc:"Balanced · ใช้ได้ทั่วไป · Default" },
    { key:"40/30/30", label:"40 / 30 / 30", desc:"Zone Diet · High Protein · Fat Loss" },
    { key:"30/40/30", label:"30 / 40 / 30", desc:"Moderate · เน้น Carb สำหรับนักวิ่ง" },
    { key:"35/25/40", label:"35 / 25 / 40", desc:"Higher Fat · Low Carb · Keto เบาๆ" },
    { key:"30/20/50", label:"30 / 20 / 50", desc:"Keto · Fat หลัก · Carb ต่ำ" },
    { key:"25/50/25", label:"25 / 50 / 25", desc:"Carb-heavy · Endurance / มาราธอน" },
    { key:"45/30/25", label:"45 / 30 / 25", desc:"Very High Protein · Recomp" },
  ];

  const parseRatio = (k) => { const [p,c,f] = k.split("/").map(Number); return { p, c, f }; };
  const { p: ratioP, c: ratioC, f: ratioF } = parseRatio(ratioKey);
  const kcalNum = +kcalTarget || suggestedKcal || 1200;
  const macros  = calcMacros(kcalNum, ratioP, ratioC, ratioF);

  const saveAll = () => {
    const profile = {
      name, gender, age:+age, height:+height, startWeight:+startW,
      activity, bodyGoal, bmr, tdee,
      goalWeight: +goalWeight || null,
      goalDate, goalReason,
      goals: {
        kcalTarget: +kcalTarget || suggestedKcal,
        ratioKey, ratioP, ratioC, ratioF,
        proteinTarget: macros.protein,
        carbTarget: macros.carb,
        fatTarget: macros.fat,
        waterTarget: +waterTarget,
        stepsTarget: +stepsTarget,
        sleepTarget: +sleepTarget,
        exDaysTarget: +exDaysTarget,
      },
    };
    setProfile(profile);
    if (_uid) cloudSaveProfile(_uid, profile);
    setSavedOk(true);
    onSaved && onSaved();
    setTimeout(() => setSavedOk(false), 2000);
  };

  return (
    <div>
      {/* ── Summary strip (read-only) ─────────────────── */}
      <div style={{ marginBottom:20 }}>
        <h2 style={{ fontSize:20, fontWeight:700, color:T.text, margin:0 }}>My Profile</h2>
      </div>

      {(bmr || saved.name) && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:1,
          background:T.border, border:`1px solid ${T.border}`,
          borderRadius:T.radius, overflow:"hidden", marginBottom:16 }}>
          {[
            { label:"BMR",    val: bmr ? `${bmr.toLocaleString()}` : "—",    unit:"kcal" },
            { label:"TDEE",   val: tdee ? `${tdee.toLocaleString()}` : "—",  unit:"kcal" },
            { label:"เป้า",   val: suggestedKcal ? `${suggestedKcal.toLocaleString()}` : (kcalTarget || "—"), unit:"kcal/วัน" },
            { label:"Protein",val: macros.protein ? `${macros.protein}g` : "—", unit:"" },
            { label:"Carb",   val: macros.carb ? `${macros.carb}g` : "—",    unit:"" },
            { label:"Fat",    val: macros.fat ? `${macros.fat}g` : "—",      unit:"" },
          ].map(c => (
            <div key={c.label} style={{ background:T.surface, padding:"10px 6px", textAlign:"center" }}>
              <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:600, color:T.accent }}>{c.val}</div>
              <div style={{ fontSize:9, color:T.textMuted, textTransform:"uppercase", letterSpacing:"0.06em", marginTop:2 }}>{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── ข้อมูลส่วนตัว ─────────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <ProfileSectionHeader>⬡ ข้อมูลส่วนตัว</ProfileSectionHeader>
        <PF label="ชื่อ / Nickname" value={name}   onChange={setName}   placeholder="ชื่อที่ใช้แสดงในแอป" />
        <div style={{ marginBottom:14 }}>
          <Lbl>เพศ</Lbl>
          <div style={{ display:"flex", gap:8 }}>
            {[["male","ชาย"],["female","หญิง"]].map(([v,l]) => (
              <button key={v} onClick={() => setGender(v)}
                style={{ flex:1, padding:"11px 0",
                  border:`1px solid ${gender===v ? T.accent : T.border}`,
                  borderRadius:T.radiusSm,
                  background: gender===v ? T.accentSoft : T.surface,
                  color: gender===v ? T.accent : T.textSub,
                  fontSize:14, fontWeight: gender===v ? 700 : 400, cursor:"pointer" }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          <PF label="อายุ"    value={age}    onChange={setAge}    unit="ปี"  placeholder="30" />
          <PF label="ส่วนสูง" value={height} onChange={setHeight} unit="cm"  placeholder="170" />
          <PF label="น้ำหนัก" value={startW} onChange={setStartW} unit="kg"  placeholder="70" />
        </div>
      </Card>

      {/* ── กิจกรรม ───────────────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <ProfileSectionHeader>◷ ระดับกิจกรรม & เป้าหมาย</ProfileSectionHeader>
        <div style={{ marginBottom:14 }}>
          <Lbl>ระดับกิจกรรมประจำวัน</Lbl>
          <div style={{ display:"flex", flexDirection:"column", gap:1,
            border:`1px solid ${T.border}`, borderRadius:T.radiusSm, overflow:"hidden" }}>
            {ACTIVITY_OPTIONS.map((o, i) => (
              <button key={o.val} onClick={() => setActivity(o.val)}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px",
                  border:"none", borderBottom: i < ACTIVITY_OPTIONS.length-1 ? `1px solid ${T.borderLight}` : "none",
                  background: activity===o.val ? T.accentSoft : T.surface,
                  cursor:"pointer", textAlign:"left" }}>
                <div style={{ width:14, height:14, borderRadius:"50%", flexShrink:0,
                  border:`2px solid ${activity===o.val ? T.accent : T.border}`,
                  background: activity===o.val ? T.accent : "none",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {activity===o.val && <div style={{ width:5, height:5, borderRadius:"50%", background:"#fff" }} />}
                </div>
                <div>
                  <div style={{ fontSize:13, color: activity===o.val ? T.accent : T.text, fontWeight: activity===o.val ? 600 : 400 }}>{o.label}</div>
                  <div style={{ fontSize:10, color:T.textMuted }}>× {o.multi}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <Lbl>เป้าหมายร่างกาย</Lbl>
          <div style={{ display:"flex", flexDirection:"column", gap:1,
            border:`1px solid ${T.border}`, borderRadius:T.radiusSm, overflow:"hidden" }}>
            {GOAL_OPTIONS.map((o, i) => (
              <button key={o.val} onClick={() => setBodyGoal(o.val)}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px",
                  border:"none", borderBottom: i < GOAL_OPTIONS.length-1 ? `1px solid ${T.borderLight}` : "none",
                  background: bodyGoal===o.val ? T.accentSoft : T.surface,
                  cursor:"pointer", textAlign:"left" }}>
                <div style={{ width:14, height:14, borderRadius:"50%", flexShrink:0,
                  border:`2px solid ${bodyGoal===o.val ? T.accent : T.border}`,
                  background: bodyGoal===o.val ? T.accent : "none",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {bodyGoal===o.val && <div style={{ width:5, height:5, borderRadius:"50%", background:"#fff" }} />}
                </div>
                <div style={{ fontSize:13, color: bodyGoal===o.val ? T.accent : T.text, fontWeight: bodyGoal===o.val ? 600 : 400 }}>{o.label}</div>
              </button>
            ))}
          </div>
        </div>
        {bmr && (
          <div style={{ marginTop:12, padding:"10px 12px", background:T.greenSoft,
            borderRadius:T.radiusSm, fontSize:11, color:T.green, lineHeight:1.9 }}>
            BMR <strong>{bmr.toLocaleString()} kcal</strong> · TDEE <strong>{tdee.toLocaleString()} kcal</strong> · เป้าแนะนำ <strong>{suggestedKcal?.toLocaleString()} kcal/วัน</strong>
          </div>
        )}
      </Card>

      {/* ── Calorie & Macro ───────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <ProfileSectionHeader>◈ Calorie & Macro Goals</ProfileSectionHeader>
        {suggestedKcal && (
          <div style={{ fontSize:11, color:T.green, padding:"8px 12px",
            background:T.greenSoft, borderRadius:T.radiusSm, marginBottom:12 }}>
            ค่าแนะนำจากโปรไฟล์: {suggestedKcal.toLocaleString()} kcal/วัน
          </div>
        )}
        <PF label="Calorie Target" value={kcalTarget} onChange={setKcalTarget}
          unit="kcal/วัน" placeholder={suggestedKcal ? String(suggestedKcal) : "เช่น 1400"} />
        <div style={{ marginBottom:14 }}>
          <Lbl>PCF Ratio (Protein / Carb / Fat)</Lbl>
          <div style={{ display:"flex", gap:1, background:T.border,
            borderRadius:T.radiusSm, overflow:"hidden", marginBottom:10 }}>
            {[
              { label:"P", val:ratioP, color:T.green, bg:T.greenSoft, g:macros.protein },
              { label:"C", val:ratioC, color:T.amber, bg:T.amberSoft, g:macros.carb },
              { label:"F", val:ratioF, color:T.red,   bg:T.redSoft,   g:macros.fat },
            ].map(r => (
              <div key={r.label} style={{ flex:1, background:r.bg, padding:"10px 6px", textAlign:"center" }}>
                <div style={{ fontSize:18, fontWeight:700, color:r.color, fontFamily:"monospace" }}>{r.val}%</div>
                <div style={{ fontSize:9, color:r.color, textTransform:"uppercase", marginTop:1 }}>{r.label}</div>
                <div style={{ fontSize:10, color:T.textMuted, marginTop:2 }}>{r.g}g</div>
              </div>
            ))}
          </div>
          <button onClick={() => setPcfSheet(true)}
            style={{ width:"100%", padding:"10px 0", border:`1px solid ${T.accent}`,
              borderRadius:T.radiusSm, background:T.accentSoft, color:T.accent,
              fontSize:13, fontWeight:600, cursor:"pointer" }}>
            เปลี่ยนสัดส่วน PCF
          </button>
        </div>
      </Card>

      {/* ── เป้าหมายส่วนตัว ──────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <ProfileSectionHeader>🎯 เป้าหมายที่ต้องการไปถึง</ProfileSectionHeader>

        {/* น้ำหนักเป้าหมาย + วันที่ */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
          <PF label="น้ำหนักเป้าหมาย" value={goalWeight} onChange={setGoalWeight} unit="kg" placeholder="เช่น 75" />
          <PF label="Target Date" value={goalDate} onChange={setGoalDate} placeholder="เช่น 2025-12-31" />
        </div>

        {/* progress preview */}
        {goalWeight && startW && +goalWeight !== +startW && (() => {
          const db2 = getDB();
          const allKeys = Object.keys(db2).sort();
          const lastWithW = allKeys.reverse().find(k => db2[k]?.weight);
          const wL = lastWithW ? +db2[lastWithW].weight : +startW;
          const pct = Math.min(100, Math.max(0, Math.round(((+startW - wL) / (+startW - +goalWeight)) * 100)));
          const remaining = (wL - +goalWeight).toFixed(1);
          return (
            <div style={{ marginBottom:14, padding:"12px 14px", background:T.accentSoft, borderRadius:T.radiusSm, border:`1px solid ${T.accent}30` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <span style={{ fontSize:12, color:T.accent, fontWeight:600 }}>ความคืบหน้า</span>
                <span style={{ fontFamily:"monospace", fontSize:18, fontWeight:700, color:T.accent }}>{pct}%</span>
              </div>
              <div style={{ height:5, background:"rgba(45,91,227,0.15)", borderRadius:3 }}>
                <div style={{ height:"100%", width:`${pct}%`, background:T.accent, borderRadius:3 }} />
              </div>
              <div style={{ fontSize:11, color:T.textSub, marginTop:6 }}>
                เริ่ม {startW} kg → ตอนนี้ {wL.toFixed(1)} kg → เป้า {goalWeight} kg
                {remaining > 0 ? ` · เหลืออีก ${remaining} kg` : " · 🎉 ถึงเป้าแล้ว!"}
              </div>
            </div>
          );
        })()}

        {/* เหตุผล / แรงบันดาลใจ */}
        <div style={{ marginBottom:14 }}>
          <Lbl>เหตุผล / แรงบันดาลใจ</Lbl>
          <textarea value={goalReason} onChange={e => setGoalReason(e.target.value)} rows={3}
            placeholder="ทำไมถึงอยากเปลี่ยนแปลง? เป้าหมายนี้หมายความว่าอะไรสำหรับคุณ..."
            style={{ width:"100%", padding:"10px 12px", border:`1px solid ${T.border}`, borderRadius:T.radiusSm, fontSize:14, color:T.text, background:T.surfaceAlt, resize:"vertical", fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
        </div>

        {/* pace guide */}
        {goalWeight && startW && goalDate && (() => {
          const today = new Date();
          const target = new Date(goalDate);
          const daysLeft = Math.max(1, Math.round((target - today) / (1000*60*60*24)));
          const kgLeft = Math.max(0, +startW - +goalWeight);
          const pace = kgLeft > 0 ? (kgLeft / (daysLeft / 7)).toFixed(2) : 0;
          const ok = pace <= 1.0;
          return (
            <div style={{ padding:"10px 12px", background: ok ? T.greenSoft : T.amberSoft, borderRadius:T.radiusSm, fontSize:12, color: ok ? T.green : T.amber }}>
              {ok ? "✓" : "⚠"} ต้องลด <strong>{pace} kg/สัปดาห์</strong> ใน {daysLeft} วันที่เหลือ
              {!ok && " — pace นี้อาจเร็วเกินไป ลองขยับ Target Date หรือปรับเป้าหมาย"}
            </div>
          );
        })()}
      </Card>

      {/* ── เป้าหมายรายวัน ──────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <ProfileSectionHeader>◉ เป้าหมายรายวัน</ProfileSectionHeader>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <PF label="น้ำดื่ม"              value={waterTarget}  onChange={setWaterTarget}  unit="ml"   placeholder="2000" />
          <PF label="ก้าวเดิน"             value={stepsTarget}  onChange={setStepsTarget}  unit="ก้าว" placeholder="8000" />
          <PF label="ชั่วโมงนอน"           value={sleepTarget}  onChange={setSleepTarget}  unit="ชม." placeholder="7" />
          <PF label="วันออกกำลังกาย/สัปดาห์" value={exDaysTarget} onChange={setExDaysTarget} unit="วัน" placeholder="3" />
        </div>
      </Card>

      {/* ── Save ─────────────────────────────────────── */}
      <button onClick={saveAll}
        style={{ width:"100%", padding:14, border:"none",
          background: savedOk ? T.green : T.accent, color:"#fff",
          borderRadius:T.radiusSm, fontSize:15, fontWeight:700,
          cursor:"pointer", marginBottom:40, transition:"background 0.2s" }}>
        {savedOk ? "✓ บันทึกแล้ว" : "บันทึก"}
      </button>

      {/* ── PCF Sheet ────────────────────────────────── */}
      <Sheet open={pcfSheet} onClose={() => setPcfSheet(false)} title="เลือกสัดส่วน Macro">
        <div style={{ fontSize:11, color:T.textMuted, marginBottom:12 }}>P = Protein · C = Carb · F = Fat (รวม 100%)</div>
        <div style={{ display:"flex", flexDirection:"column", gap:1,
          border:`1px solid ${T.border}`, borderRadius:T.radiusSm, overflow:"hidden" }}>
          {PCF_PRESETS.map(preset => {
            const isActive = ratioKey === preset.key;
            return (
              <button key={preset.key} onClick={() => { setRatioKey(preset.key); setPcfSheet(false); }}
                style={{ display:"flex", alignItems:"center", gap:12, padding:"13px 16px",
                  border:"none", borderBottom:`1px solid ${T.borderLight}`,
                  background: isActive ? T.accentSoft : T.surface,
                  cursor:"pointer", textAlign:"left" }}>
                <div style={{ width:14, height:14, borderRadius:"50%", flexShrink:0,
                  border:`2px solid ${isActive ? T.accent : T.border}`,
                  background: isActive ? T.accent : "none",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {isActive && <div style={{ width:5, height:5, borderRadius:"50%", background:"#fff" }} />}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"monospace", fontSize:14, fontWeight:700,
                    color: isActive ? T.accent : T.text }}>{preset.label}</div>
                  <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>{preset.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}

// ═══ APP ROOT ════════════════════════════════════════════════
export default function App({ userId = "", userEmail = "", onLogout }) {
  const [syncing, setSyncing] = useState(true);
  const [page, setPage] = useState("daily");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [, forceUpdate] = useState(0);
  const width = useWindowWidth();
  const isMobile = width < 768;
  const SIDEBAR_W = 210;

  useEffect(() => {
    setCurrentUser(userId);
    if (userId) {
      cloudPullAll(userId).finally(() => setSyncing(false));
    } else {
      setSyncing(false);
    }
  }, [userId]);

  const changeDate = (n) => { const d = new Date(currentDate); d.setDate(d.getDate() + n); setCurrentDate(d); };

  const pageMap = {
    daily:   <DailyPage currentDate={currentDate} onSave={() => forceUpdate(x => x + 1)} />,
    review:  <ReviewPage />,
    inj:     <InjPage />,
    data:    <DataPage />,
    profile: <ProfilePage onSaved={() => forceUpdate(x => x + 1)} />,
  };

  if (syncing) {
    return (
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", gap:14, background:T.bg, fontFamily:"-apple-system,'SF Pro Display','Helvetica Neue',sans-serif" }}>
        <img src="/apple-touch-icon.png" alt="Bodii Now" style={{ width:60, height:60, borderRadius:14, opacity:0.9 }} />
        <div style={{ fontSize:13, color:T.textMuted }}>กำลังโหลดข้อมูล...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily:"-apple-system,'SF Pro Display','Helvetica Neue',sans-serif", background:T.bg, minHeight:"100vh", WebkitFontSmoothing:"antialiased" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        input[type=range]{-webkit-appearance:none;appearance:none;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:white;cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,0.25);border:2px solid #ddd;}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
        button,input,textarea{font-family:inherit;}
      `}</style>

      {!isMobile && <Sidebar active={page} onNav={setPage} />}

      <div style={{ position:"fixed", top:0, left:isMobile?0:SIDEBAR_W, right:0, zIndex:90, background:"rgba(250,250,248,0.92)", backdropFilter:"blur(12px)", WebkitBackdropFilter:"blur(12px)", borderBottom:`1px solid ${T.border}`, height:48, display:"flex", alignItems:"center", justifyContent:isMobile?"space-between":"flex-end", padding:"0 20px", gap:10 }}>
        {isMobile && (
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <img src="/apple-touch-icon.png" alt="logo" style={{ width:26, height:26, borderRadius:6, objectFit:"cover" }} />
            <span style={{ fontSize:16, fontWeight:700, color:"#2D5BE3", lineHeight:1 }}>Bodii</span>
            <span style={{ fontSize:16, fontWeight:700, color:"#0E1726", lineHeight:1 }}>Now</span>
          </div>
        )}
        {userEmail && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginRight:"auto" }}>
            <span style={{ fontSize:11, color:T.textMuted, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{userEmail}</span>
            <button onClick={onLogout} title="ออกจากระบบ"
              style={{ fontSize:11, color:T.textMuted, background:"none", border:`1px solid ${T.border}`, borderRadius:6, padding:"3px 8px", cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
              ออกจากระบบ
            </button>
          </div>
        )}
        <div style={{ display:"flex", alignItems:"center", border:`1px solid ${T.border}`, borderRadius:T.radiusSm, overflow:"hidden", background:T.surface }}>
          <button onClick={()=>changeDate(-1)} style={{ width:32,height:32,border:"none",borderRight:`1px solid ${T.border}`,background:"transparent",cursor:"pointer",color:T.textMuted,fontSize:16 }}>‹</button>
          <span style={{ padding:"0 14px", fontSize:12, fontFamily:"monospace", color:T.textSub, whiteSpace:"nowrap" }}>
            {currentDate.toLocaleDateString("th-TH",{day:"2-digit",month:"2-digit",year:"2-digit"})}
          </span>
          <button onClick={()=>changeDate(1)} style={{ width:32,height:32,border:"none",borderLeft:`1px solid ${T.border}`,background:"transparent",cursor:"pointer",color:T.textMuted,fontSize:16 }}>›</button>
        </div>
      </div>

      <main style={{ marginLeft:isMobile?0:SIDEBAR_W, padding:isMobile?"60px 16px 90px":"60px 44px 40px", minHeight:"100vh" }}>
        {pageMap[page]}
      </main>

      {isMobile && <BottomBar active={page} onNav={setPage} />}
    </div>
  );
}
