import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";

interface Props {
  onAuth: (user: any) => void;
}

export default function AuthModal({ onAuth }: Props) {
  const [mode, setMode]         = useState<"login" | "register">("login");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [orgName, setOrgName]   = useState("");
  const { login, register, loading, error } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const user = mode === "login"
        ? await login(email, password)
        : await register(name, email, password, orgName);
      onAuth(user);
    } catch {}
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", height: 44, padding: "0 14px",
    border: "1.5px solid #e8ecf0", borderRadius: 10,
    fontSize: 13.5, fontFamily: "'Inter', sans-serif",
    color: "#0f172a", background: "#fafbfc", outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    letterSpacing: "0.06em", color: "#94a3b8", marginBottom: 5,
    display: "block",
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#f8fafc",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24, fontFamily: "'Inter', sans-serif",
    }}>
      <div style={{
        background: "white", borderRadius: 24, padding: "40px 36px",
        width: "100%", maxWidth: 420,
        boxShadow: "0 8px 40px rgba(13,122,138,0.12), 0 2px 8px rgba(0,0,0,0.04)",
        border: "1px solid #e8ecf0",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            background: "linear-gradient(135deg,#0d7a8a,#0a3d5c)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 14px", fontSize: 24,
            boxShadow: "0 4px 14px rgba(13,122,138,0.3)",
          }}>⚡</div>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: "0 0 6px", letterSpacing: "-0.03em" }}>
            TallyBitrixSync
          </h2>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>
            {mode === "login" ? "Sign in to your account" : "Create your account"}
          </p>
        </div>

        {/* Tab switcher */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6,
          background: "#f1f5f9", borderRadius: 10, padding: 4, marginBottom: 24,
        }}>
          {(["login", "register"] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: "9px 0", borderRadius: 7, border: "none", cursor: "pointer",
              fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
              background: mode === m ? "white" : "transparent",
              color: mode === m ? "#0d7a8a" : "#64748b",
              boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              transition: "all 0.15s",
            }}>
              {m === "login" ? "Sign In" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {mode === "register" && (
            <>
              <div>
                <label style={labelStyle}>Full Name <span style={{ color: "#ef4444" }}>*</span></label>
                <input style={inputStyle} placeholder="John Doe" value={name}
                  onChange={e => setName(e.target.value)} required />
              </div>
              <div>
                <label style={labelStyle}>Company Name <span style={{ color: "#94a3b8", textTransform: "none", fontWeight: 400 }}>(Optional)</span></label>
                <input style={inputStyle} placeholder="Acme Pvt Ltd" value={orgName}
                  onChange={e => setOrgName(e.target.value)} />
              </div>
            </>
          )}

          <div>
            <label style={labelStyle}>Email Address <span style={{ color: "#ef4444" }}>*</span></label>
            <input style={inputStyle} type="email" placeholder="you@company.com"
              value={email} onChange={e => setEmail(e.target.value)} required />
          </div>

          <div>
            <label style={labelStyle}>Password <span style={{ color: "#ef4444" }}>*</span></label>
            <input style={inputStyle} type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)} required />
          </div>

          {error && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 8, padding: "10px 14px",
              fontSize: 12, color: "#dc2626", fontWeight: 500,
            }}>
              ✕ {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            height: 48, borderRadius: 12, border: "none",
            background: "linear-gradient(135deg,#0d7a8a,#0a3d5c)",
            color: "white", fontSize: 14, fontWeight: 600,
            fontFamily: "'Inter', sans-serif", cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1, marginTop: 4,
            boxShadow: "0 4px 14px rgba(13,122,138,0.28)",
            transition: "all 0.15s",
          }}>
            {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
          </button>
        </form>

        <p style={{ textAlign: "center", fontSize: 12, color: "#94a3b8", marginTop: 20 }}>
          {mode === "login" ? "Don't have an account? " : "Already have an account? "}
          <button onClick={() => setMode(mode === "login" ? "register" : "login")} style={{
            background: "none", border: "none", color: "#0d7a8a",
            fontWeight: 600, cursor: "pointer", fontSize: 12,
            fontFamily: "'Inter', sans-serif",
          }}>
            {mode === "login" ? "Register" : "Sign In"}
          </button>
        </p>
      </div>
    </div>
  );
}