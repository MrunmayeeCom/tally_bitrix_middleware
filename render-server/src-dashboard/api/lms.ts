import API from "./AxiosInstance";

const API_KEY    = import.meta.env.VITE_LMS_API_KEY    || "my-secret-key-123";
const PRODUCT_ID = import.meta.env.VITE_PRODUCT_ID     || "69ba90211cf0356ba779b317";

// ── Customer Auth (External) ──────────────────────────────────────────────────
// These are for Bitrix customers, NOT internal LMS users

export const checkCustomerExists = async (email: string): Promise<boolean> => {
  const res = await API.post(
    "/api/external/customer-exists",
    { email },
    { headers: { "x-api-key": API_KEY } }
  );
  return res.data.exists;
};

export const syncCustomer = async (data: {
  name: string;
  email: string;
  source: string;
  password: string;
}) => {
  const res = await API.post(
    "/api/external/customer-sync",
    data,
    { headers: { "x-api-key": API_KEY } }
  );
  return res.data;
};

export const loginCustomer = async (data: {
  email: string;
  password: string;
}) => {
  const res = await API.post(
    "/api/external/customer-login",
    data,
    { headers: { "x-api-key": API_KEY } }
  );
  return res.data;
};

// ── License ───────────────────────────────────────────────────────────────────

export const checkActiveLicense = async (email: string) => {
  const res = await API.get(
    `/api/external/actve-license/${email}?productId=${PRODUCT_ID}`,
    { headers: { "x-api-key": API_KEY } }
  );
  return res.data?.activeLicense || null;
};

// ── Plans ─────────────────────────────────────────────────────────────────────

export const fetchPlansForProduct = async () => {
  const res = await API.get(
    `/api/license/public/licenses-by-product/${PRODUCT_ID}`,
    { headers: { "x-api-key": API_KEY } }
  );
  const licenses = res.data?.licenses || res.data?.data || [];
  const matched = licenses.find((lic: any) => {
    const lt = lic.licenseTypeId || lic.licenseType;
    return (lt?.price?.amount ?? 0) > 0 && lt?.name?.toLowerCase() !== "enterprise";
  }) || licenses[0];
  if (!matched) throw new Error("Plan not found");
  const lt = matched.licenseTypeId || matched.licenseType;
  let userCount = 1;
  const rawFeatures = lt.features || [];
  if (Array.isArray(rawFeatures)) {
    for (const f of rawFeatures) {
      if (typeof f === "object" && f.featureType === "limit") {
        const slug = (f.featureSlug || "").toLowerCase();
        const val  = f.limitValue ?? f.value;
        if (slug.includes("user") && typeof val === "number") { userCount = val; break; }
      }
    }
  }
  console.log('[fetchPlans] matched._id:', matched._id, 'lt._id:', lt._id);
  return {
    licenseId:      matched._id,
    planName:       lt.name,
    pricePerUser:   lt.price.amount,
    includedUsers:  userCount,
    features:       Array.isArray(rawFeatures)
                      ? rawFeatures.filter((f: any) => typeof f === "object" && f.uiLabel)
                      : [],
    discountConfig: lt.discountConfig ?? { monthly:0, quarterly:0, "half-yearly":0, yearly:0 },
  };
};

// ── Internal LMS (keep for admin use) ────────────────────────────────────────

export const fetchPlans = async () => {
  const res = await API.get(`/api/licenseType`);
  return res.data.data;
};

export const fetchUser = async () => {
  const token = localStorage.getItem("token");
  const res = await API.get(`/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.data;
};