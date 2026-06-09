import React from "react";

export default function LoadingScreen({ message = "Loading…" }: { message?: string }) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "#f8fafc",
      fontFamily: "'Inter', sans-serif", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        width: 36, height: 36, border: "3px solid #e2e8f0",
        borderTopColor: "#0d7a8a", borderRadius: "50%",
        animation: "spin 0.75s linear infinite",
      }} />
      <p style={{ fontSize: 13, color: "#94a3b8" }}>{message}</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}