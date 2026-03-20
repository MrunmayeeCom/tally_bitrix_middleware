import axios from "axios";
import API from "./AxiosInstance";

// Get logged-in user details
export const fetchUser = async () => {
  const token = localStorage.getItem("token");

  const res = await API.get(`/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data.data;
};

// Login user
export const loginUser = async (email: string, password: string) => {
  const res = await API.post(`/api/auth/login`, {
    email,
    password
  });

  // Store token and user data
  if (res.data.token) {
    localStorage.setItem("token", res.data.token);
    localStorage.setItem("userData", JSON.stringify(res.data.user));
  }

  return res.data;
};

// Register user
export const registerUser = async (name: string, email: string, password: string, orgName?: string) => {
  const res = await API.post(`/api/auth/register`, {
    name,
    email,
    password,
    orgName
  });

  // Store token and user data
  if (res.data.token) {
    localStorage.setItem("token", res.data.token);
    localStorage.setItem("userData", JSON.stringify(res.data.user));
  }

  return res.data;
};

// Logout user
export const logoutUser = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("userData");
  window.location.href = "/login";
};

// Check if user is authenticated
export const isAuthenticated = () => {
  const token = localStorage.getItem("token");
  return !!token;
};

// Get user from localStorage (no API call)
export const getStoredUser = () => {
  const userDataStr = localStorage.getItem("user");
  if (!userDataStr) return null;
  
  try {
    return JSON.parse(userDataStr);
  } catch (error) {
    console.error("Failed to parse user data:", error);
    return null;
  }
};