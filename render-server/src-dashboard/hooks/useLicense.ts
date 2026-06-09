import { useState, useCallback } from "react";
import { checkActiveLicense } from "../api/lms";

export function useLicense() {
  const [license, setLicense]   = useState<any>(null);
  const [loading, setLoading]   = useState(false);

  const check = useCallback(async (email: string) => {
    setLoading(true);
    try {
      const lic = await checkActiveLicense(email);
      setLicense(lic);
      return lic;
    } catch {
      setLicense(null);
      return null;
    } finally { setLoading(false); }
  }, []);

  const isActive = license?.status === "active";

  return { license, loading, isActive, check };
}