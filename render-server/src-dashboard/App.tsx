import React, { useState, useEffect } from "react";
import { AppState, User } from "./types";
import { clearAuth, getStoredUser } from "./hooks/useAuth";
import { checkActiveLicense } from "./api/lms";
import { fetchPortalData, linkLicense } from "./api/middleware";
import AuthModal from "./components/AuthModal";
import PricingPage from "./components/PricingPage";
import Dashboard from "./components/Dashboard";
import LoadingScreen from "./components/LoadingScreen";

function getClientId() {
  try { return new URLSearchParams(window.location.search).get("clientId") || ""; }
  catch { return ""; }
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const [user, setUser]         = useState<User | null>(null);
  const [loadingMsg, setLoadingMsg] = useState("Connecting…");
  const clientId = getClientId();

  useEffect(() => { init(); }, []);

  async function init() {
    setAppState("loading");
    try {
      // Step 1: verify token if exists
      // Step 1: check stored customer session
      const stored = getStoredUser();
      let currentUser: User | null = null;

      if (stored?.email) {
        setLoadingMsg("Restoring session…");
        currentUser = stored;
        setUser(stored);
      }

      // Step 2: no stored customer → show auth
      if (!currentUser) {
        setAppState("auth");
        return;
      }

      // Step 3: check active license for this user
      setLoadingMsg("Checking license…");
      const license = await checkActiveLicense(currentUser.email);

      if (license?.status === "active") {
        // Step 4: link license to clientId if not already linked
        setLoadingMsg("Setting up dashboard…");
        await linkLicense({
          clientId,
          customerEmail: currentUser.email,
          licenseId:     license._id || license.licenseId,
          licensePlan:   license.licenseTypeId?.name || license.licensePlan || "",
          licenseStatus: "active",
        });
        setAppState("dashboard");
      } else {
        // No active license → show pricing
        setAppState("pricing");
      }
    } catch(e) {
      console.error("Init error:", e);
      setAppState("auth");
    }
  }

  async function handleAuth(authedUser: User) {
    setUser(authedUser);
    setAppState("loading");
    setLoadingMsg("Checking license…");
    try {
      const license = await checkActiveLicense(authedUser.email);
      if (license?.status === "active") {
        await linkLicense({
          clientId,
          customerEmail: authedUser.email,
          licenseId:     license._id || license.licenseId,
          licensePlan:   license.licenseTypeId?.name || "",
          licenseStatus: "active",
        });
        setAppState("dashboard");
      } else {
        setAppState("pricing");
      }
    } catch {
      setAppState("pricing");
    }
  }

  async function handlePurchased() {
    if (!user) return;
    setAppState("loading");
    setLoadingMsg("Activating license…");
    try {
      const license = await checkActiveLicense(user.email);
      if (license?.status === "active") {
        await linkLicense({
          clientId,
          customerEmail: user.email,
          licenseId:     license._id || license.licenseId,
          licensePlan:   license.licenseTypeId?.name || "",
          licenseStatus: "active",
        });
      }
    } catch {}
    setAppState("dashboard");
  }

  function handleLogout() {
    clearAuth();
    setUser(null);
    setAppState("auth");
  }

  if (appState === "loading")    return <LoadingScreen message={loadingMsg} />;
  if (appState === "auth")       return <AuthModal onAuth={handleAuth} />;
  if (appState === "pricing")    return <PricingPage clientId={clientId} user={user} onPurchased={handlePurchased} />;
  if (appState === "dashboard")  return <Dashboard clientId={clientId} user={user} onLogout={handleLogout} />;
  return null;
}