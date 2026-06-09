import { useState, useCallback } from "react";
import { User } from "../types";
import { loginCustomer, syncCustomer, checkCustomerExists, checkActiveLicense } from "../api/lms";

function getStoredCustomer(): User | null {
  try { return JSON.parse(localStorage.getItem("bx_customer") || "null"); } catch { return null; }
}
function setStoredCustomer(u: any) {
  try { localStorage.setItem("bx_customer", JSON.stringify(u)); } catch {}
}
export function clearAuth() {
  try {
    localStorage.removeItem("bx_customer");
    localStorage.removeItem("bx_customer_email");
  } catch {}
}
export function getStoredUser(): User | null { return getStoredCustomer(); }
// No JWT token for customers — they are identified by email
export function getToken() { return ""; }

export function useAuth() {
  const [user, setUser]       = useState<User | null>(getStoredCustomer());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true); setError("");
    try {
      const data = await loginCustomer({ email, password });
      if (!data.success) throw new Error(data.message || "Login failed");
      const customer: User = {
        _id:   data.customer?.customerId || email,
        name:  data.customer?.name || "",
        email: data.customer?.email || email,
      };
      setStoredCustomer(customer);
      localStorage.setItem("bx_customer_email", email);
      setUser(customer);
      return customer;
    } catch(e: any) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, _orgName?: string) => {
    setLoading(true); setError("");
    try {
      const data = await syncCustomer({ name, email, password, source: "bitrix-app" });
      if (!data.success) throw new Error(data.message || "Registration failed");
      // Auto login after register
      const loginData = await loginCustomer({ email, password });
      const customer: User = {
        _id:   loginData.customer?.customerId || email,
        name:  loginData.customer?.name || name,
        email: loginData.customer?.email || email,
      };
      setStoredCustomer(customer);
      localStorage.setItem("bx_customer_email", email);
      setUser(customer);
      return customer;
    } catch(e: any) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setUser(null);
  }, []);

  const verifyToken = useCallback(async () => {
    // No JWT — check if stored customer email still has active session
    const stored = getStoredCustomer();
    if (!stored?.email) return null;
    // Just return stored customer — re-auth only on explicit login
    setUser(stored);
    return stored;
  }, []);

  return { user, loading, error, login, register, logout, verifyToken };
}