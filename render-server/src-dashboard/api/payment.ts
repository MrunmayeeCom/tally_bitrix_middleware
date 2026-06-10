import API from "./AxiosInstance";

type BillingCycle = "quarterly" | "half-yearly" | "yearly";

const API_KEY = import.meta.env.VITE_LMS_API_KEY || "my-secret-key-123";

// Step 1: Create pending transaction in LMS
export const initiatePurchase = async ({
  name,
  email,
  licenseId,
  billingCycle,
}: {
  name: string;
  email: string;
  licenseId: string;
  billingCycle: BillingCycle;
}) => {
  console.log('[initiatePurchase] payload:', { name, email, licenseId, billingCycle });
  try {
    const res = await API.post(`/api/lms/purchase-license`, {
      name,
      email,
      licenseId,
      billingCycle,
    }, {
      headers: { "x-api-key": API_KEY },
    });
    console.log('[initiatePurchase] response:', JSON.stringify(res.data, null, 2));
    if (!res.data?.success) throw new Error(res.data?.message || "Purchase initiation failed");
    return res.data;
  } catch(e: any) {
    console.error('[initiatePurchase] error:', JSON.stringify(e.response?.data, null, 2));
    throw new Error(e.response?.data?.message || e.message);
  }
};

// Step 2: Create Razorpay order from pending transaction
export const createOrder = async ({
  userId,
  licenseId,
  billingCycle,
}: {
  userId: string;
  licenseId: string;
  billingCycle: BillingCycle;
}) => {
  console.log('[createOrder] payload:', { userId, licenseId, billingCycle });
  try {
    const res = await API.post(`/api/payment/create-order`, {
      userId,
      licenseId,
      billingCycle,
    }, {
      headers: { "x-api-key": API_KEY },
    });
    console.log('[createOrder] response:', JSON.stringify(res.data, null, 2));
    if (!res.data?.orderId) throw new Error(res.data?.message || "Order creation failed");
    return res.data;
  } catch(e: any) {
    console.error('[createOrder] error:', JSON.stringify(e.response?.data, null, 2));
    throw new Error(e.response?.data?.message || e.message);
  }
};

// Step 3: Verify payment signature
export const verifyPayment = async (details: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) => {
  console.log('[verifyPayment] payload:', details);
  try {
    const res = await API.post(`/api/payment/verify-payment`, details, {
      headers: { "x-api-key": API_KEY },
    });
    console.log('[verifyPayment] response:', JSON.stringify(res.data, null, 2));
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