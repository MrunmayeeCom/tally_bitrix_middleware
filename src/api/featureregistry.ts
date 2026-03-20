import API from "./AxiosInstance";

const API_KEY    = "my-secret-key-123";
const PRODUCT_ID = "69ba90211cf0356ba779b317";


export interface FeatureRegistryItem {
  featureSlug: string;
  featureName: string;
  description?: string;
  limitType: "count" | "boolean" | "unlimited";
  plans: {
    planName: string;
    limitValue: number | boolean | null;
  }[];
}

export interface FeatureRegistry {
  productId: string;
  productName?: string;
  features: FeatureRegistryItem[];
}


export const fetchFeatureRegistry = async (): Promise<FeatureRegistry | null> => {
  try {
    const res = await API.get(
      `/api/feature-registry/${PRODUCT_ID}`,
      {
        headers: {
          "x-api-key": API_KEY,
        },
      }
    );

    return res.data?.success ? res.data.data : null;
  } catch (error: any) {
    console.error("fetchFeatureRegistry error (non-fatal):", error);
    return null;
  }
};