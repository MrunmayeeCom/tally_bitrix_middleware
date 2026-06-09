import axios from "axios";
import API from "./AxiosInstance";

export const purchaseLicense = async (payload: any) => {
  const res = await API.post(`/api/lms/purchase-license`, payload);
  return res.data; // ✅ return FULL response
};
