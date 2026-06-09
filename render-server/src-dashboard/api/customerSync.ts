import API from "./AxiosInstance";

const API_KEY = "my-secret-key-123";

interface SyncCustomerPayload {
  name: string;
  email: string;
  source: string;
  password: string;
}

interface LoginPayload {
  email: string;
  password: string;
}

interface LoginResponse {
  success: boolean;
  message: string;
  customer?: {
    name: string;
    email: string;
    customerId: string;
  };
}

export const syncCustomer = async (data: SyncCustomerPayload) => {
  try {
    const res = await API.post(
      "/api/external/customer-sync",
      data,
      {
        headers: {
          "x-api-key": API_KEY,
        },
      }
    );

    return res.data;
  } catch (error: any) {
    console.error("syncCustomer error:", error);
    throw error;
  }
};

export const checkCustomerExists = async (email: string): Promise<boolean> => {
  try {
    const res = await API.post(
      "/api/external/customer-exists",
      { email },
      {
        headers: {
          "x-api-key": API_KEY,
        },
      }
    );

    return res.data.exists;
  } catch (error: any) {
    console.error("checkCustomerExists error:", error);
    return false;
  }
};

// Login function with password validation
export const loginCustomer = async (data: LoginPayload): Promise<LoginResponse> => {
  try {
    const res = await API.post(
      "/api/external/customer-login",
      data,
      {
        headers: {
          "x-api-key": API_KEY,
        },
      }
    );

    return res.data;
  } catch (error: any) {
    console.error("loginCustomer error:", error);

    // If it's a 401 error, throw a specific error
    if (error.response?.status === 401) {
      throw new Error("Invalid email or password");
    }

    // For other errors, throw the original error
    throw error;
  }
};