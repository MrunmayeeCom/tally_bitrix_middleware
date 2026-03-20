import axios from "axios";

import API from "./AxiosInstance";

// Fetch all subscription plans
export const fetchPlans = async () => {
  const res = await API.get(`/api/licenseType`);
  return res.data.data; // adjust based on your response structure
};

// Get logged-in user details
export const fetchUser = async () => {
  const token = localStorage.getItem("token");

  const res = await API.get(`/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data.data;
};