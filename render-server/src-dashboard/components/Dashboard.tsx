import React, { useEffect, useRef } from "react";
import { User } from "../types";

interface Props {
  clientId: string;
  user: User | null;
  onLogout: () => void;
}

export default function Dashboard({ clientId, user, onLogout }: Props) {
  // The dashboard renders the full existing dashboard UI
  // We inject clientId into the global scope for the dashboard scripts
  useEffect(() => {
    (window as any).__DASHBOARD_CLIENT_ID__ = clientId;
    (window as any).__DASHBOARD_USER__      = user;
  }, [clientId, user]);

  return (
    <div style={{ minHeight:"100vh", fontFamily:"'Inter',sans-serif" }}>
      {/* Logout button overlay */}
      <div style={{
        position:"fixed", bottom:20, right:20, zIndex:999,
      }}>
        <button onClick={onLogout} style={{
          padding:"8px 16px", borderRadius:8, border:"1px solid #e8ecf0",
          background:"white", color:"#64748b", fontSize:12, fontWeight:600,
          cursor:"pointer", fontFamily:"'Inter',sans-serif",
          boxShadow:"0 2px 8px rgba(0,0,0,0.08)",
        }}>
          Sign Out
        </button>
      </div>

      {/* Dashboard content — rendered by DashboardContent */}
      <DashboardContent clientId={clientId} user={user} />
    </div>
  );
}

// This component contains all the existing dashboard UI
// migrated from dashboard.html into React/TSX
function DashboardContent({ clientId, user }: { clientId: string; user: User | null }) {
  const APP_BASE_URL = import.meta.env.VITE_APP_BASE_URL;

  // For now render an iframe pointing to the existing dashboard
  // This lets you migrate incrementally without rewriting everything at once
  return (
    <iframe
      src={`${APP_BASE_URL}/dashboard-legacy?clientId=${clientId}`}
      style={{
        width:"100%", border:"none",
        height:"calc(100vh - 0px)",
        display:"block",
      }}
      title="TallySync Dashboard"
    />
  );
}