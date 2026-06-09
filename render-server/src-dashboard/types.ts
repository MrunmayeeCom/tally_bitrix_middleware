export type AppState = "loading" | "auth" | "pricing" | "dashboard";

export interface User {
  _id: string;
  name: string;
  email: string;
  orgName?: string;
}

export interface LMSPlan {
  licenseId: string;
  planName: string;
  pricePerUser: number;
  includedUsers: number;
  features: { featureSlug: string; uiLabel: string }[];
  discountConfig: Record<string, number>;
}

export interface PortalData {
  success: boolean;
  agentLive: boolean;
  customerEmail?: string;
  licenseStatus?: string;
  licenseId?: string;
  licensePlan?: string;
  pushedAt?: string;
  history?: any[];
  lastSync?: any;
  overdue?: any[];
  status?: any;
}

export type BillingCycle = "quarterly" | "half-yearly" | "yearly";