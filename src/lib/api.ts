const API_URL = "";

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
  post: async (endpoint: string, data: any) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "POST",
      credentials: 'same-origin',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return handleResponse(res, endpoint.startsWith('/auth/'));
  },
  put: async (endpoint: string, data: any) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PUT",
      credentials: 'same-origin',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },
  patch: async (endpoint: string, data: any) => {
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PATCH",
      credentials: 'same-origin',
      headers: { "Content-Type": "application/json" },
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
