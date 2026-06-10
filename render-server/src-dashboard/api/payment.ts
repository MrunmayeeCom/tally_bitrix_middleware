import API from "./AxiosInstance";

type BillingCycle = "quarterly" | "half-yearly" | "yearly";

const API_KEY = import.meta.env.VITE_LMS_API_KEY || "my-secret-key-123";

export const createOrder = async ({
  userId,
  licenseId,
  billingCycle,
  amount,
}: {
  userId: string;
  licenseId: string;
  billingCycle: BillingCycle;
  amount: number;
}) => {
  const payload = { userId, licenseId, billingCycle, amount };
  console.log('[createOrder] payload:', payload);
  try {
    const res = await API.post(`/api/payment/create-order`, payload, {
      headers: { "x-api-key": API_KEY },
    });
    console.log('[createOrder] response:', res.data);
    if (!res.data?.success) throw new Error(res.data?.message || "Order creation failed");
    return res.data;
  } catch(e: any) {
    console.error('[createOrder] error:', JSON.stringify(e.response?.data, null, 2));
    throw new Error(e.response?.data?.message || e.message);
  }
};

export const verifyPayment = async (details: any) => {
  try {
    const res = await API.post(`/api/payment/verify-payment`, details, {
      headers: { "x-api-key": API_KEY },
    });
    console.log('[verifyPayment] response:', res.data);
    if (!res.data?.success) throw new Error(res.data?.message || "Verification failed");
    return res.data;
  } catch(e: any) {
    console.error('[verifyPayment] error:', JSON.stringify(e.response?.data, null, 2));
    throw new Error(e.response?.data?.message || e.message);
  }
};

export const getTransactionDetails = async (transactionId: string) => {
  const res = await API.get(`/api/payment/transaction/${transactionId}`);
  return res.data;
};

export const getMyTransactions = async (userId: string) => {
  const res = await API.get(`/api/payment/my-transactions?userId=${userId}`);
  return res.data;
};

export const downloadInvoice = (transactionId: string) => {
  if (!transactionId) return;
  window.open(
    `https://license-system-v6ht.onrender.com/api/payment/invoice/${transactionId}`,
    "_blank"
  );
};