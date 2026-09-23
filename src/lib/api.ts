const API_URL = "";

export type MutationOptions = {
  operationId?: string;
};

const canonicalActionPayload = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? String(value);
  }
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalActionPayload).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalActionPayload(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
};

export const createRetryOperation = (prefix: string) => {
  let active: { payload: string; operationId: string } | null = null;
  return {
    idFor(payload: unknown) {
      const canonicalPayload = canonicalActionPayload(payload);
      if (!active || active.payload !== canonicalPayload) {
        const randomUuid = globalThis.crypto?.randomUUID?.();
        if (!randomUuid) throw new Error("Secure client operation ID generation is unavailable.");
        active = { payload: canonicalPayload, operationId: `${prefix}-${randomUuid}` };
      }
      return active.operationId;
    },
    complete(operationId: string) {
      if (active?.operationId === operationId) active = null;
    },
  };
};

const requiresSalesOperationId = (method: "POST" | "PUT" | "PATCH", endpoint: string) => (
  (method === "POST" && endpoint === "/sales")
  || (method === "POST" && /^\/sales\/[^/]+\/financial-expenses$/.test(endpoint))
  || (method === "POST" && /^\/returns\/v1\/(?:sales\/[^/]+|[^/]+\/refunds)$/.test(endpoint))
  || ((method === "PUT" || method === "PATCH") && /^\/sales\/[^/]+(?:\/status)?$/.test(endpoint))
);

const mutationHeaders = (method: "POST" | "PUT" | "PATCH", endpoint: string, options: MutationOptions = {}) => {
  const operationId = String(options.operationId || "").trim();
  if (requiresSalesOperationId(method, endpoint) && !operationId) {
    throw new Error(`X-Operation-ID is required for ${method} ${endpoint}.`);
  }
  return {
    "Content-Type": "application/json",
    ...(operationId ? { "X-Operation-ID": operationId } : {}),
  };
};

const handleResponse = async (res: Response, skip401Reload = false) => {
  let data;
  let jsonError = false;
  try {
    data = await res.json();
  } catch (e) {
    jsonError = true;
  }

  const shouldClearSession =
    res.status === 401 ||
    (res.status === 403 && data?.error?.code === 'USER_DISABLED');

  if (shouldClearSession && !skip401Reload) {
    window.location.href = '/';
    return;
  }
  
  if (jsonError && !res.ok) {
    throw new Error(res.statusText || 'Bir hata oluştu');
  }

  if (!res.ok || data?.success === false) {
     throw new Error(data?.error?.message || data?.error || 'Bir hata oluştu');
  }
  return data;
};

export const api = {
  get: async (endpoint: string) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      credentials: 'same-origin',
    });
    return handleResponse(res, endpoint.startsWith('/auth/'));
  },
  post: async (endpoint: string, data: any, options?: MutationOptions) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "POST",
      credentials: 'same-origin',
      headers: mutationHeaders("POST", endpoint, options),
      body: JSON.stringify(data),
    });
    return handleResponse(res, endpoint.startsWith('/auth/'));
  },
  put: async (endpoint: string, data: any, options?: MutationOptions) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PUT",
      credentials: 'same-origin',
      headers: mutationHeaders("PUT", endpoint, options),
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },
  patch: async (endpoint: string, data: any, options?: MutationOptions) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PATCH",
      credentials: 'same-origin',
      headers: mutationHeaders("PATCH", endpoint, options),
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },
  delete: async (endpoint: string) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "DELETE",
      credentials: 'same-origin',
    });
    return handleResponse(res);
  },
  upload: async (endpoint: string, formData: FormData) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "POST",
      credentials: 'same-origin',
      body: formData,
    });
    return handleResponse(res);
  }
};

export const formatCurrency = (value: number, symbol = "₺") => {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    currencyDisplay: "symbol"
  }).format(value).replace("TL", symbol).replace("₺", symbol);
};

export const PLATFORMS = ["Trendyol", "Hepsiburada", "Amazon", "N11", "Website", "Instagram"];
export const MATERIALS = ["Aliminyum", "PPR", "Dokum Demir", "Karbon Celik"];
export const CATEGORIES = ["Aliminyum", "PPR", "Dokum Demir", "Karbon Celik"];
