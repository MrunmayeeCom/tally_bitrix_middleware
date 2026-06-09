const APP_BASE_URL = import.meta.env.VITE_APP_BASE_URL;

const HEADERS = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "1",
};

export async function fetchPortalData(clientId: string) {
  const res = await fetch(`${APP_BASE_URL}/dashboard/data?clientId=${clientId}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

export async function linkLicense(payload: {
  clientId: string;
  customerEmail: string;
  licenseId: string;
  licensePlan: string;
  licenseStatus: string;
}) {
  const res = await fetch(`${APP_BASE_URL}/api/license/link`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function pushDashboardData(clientId: string, data: object) {
  const res = await fetch(`${APP_BASE_URL}/dashboard/push?clientId=${clientId}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function triggerSync(clientId: string, path: string) {
  const res = await fetch(`${APP_BASE_URL}/dashboard/push?clientId=${clientId}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ trigger: path }),
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}