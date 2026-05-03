import type { UserRole } from '../types';

const API_URL = "";

export const getToken = () => localStorage.getItem('token');

const checkAccess = () => {
  const role = localStorage.getItem('userRole') as UserRole | null;
  if (role === 'readonly') {
    throw new Error('Yetkisiz işlem. Yalnızca okuma izniniz var.');
  }
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
    const hadToken = !!localStorage.getItem('token');
    localStorage.removeItem('token');
    localStorage.removeItem('userRole');
    if (hadToken) {
       window.location.href = '/'; 
       return; // stop execution
    }
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
      headers: { "Authorization": `Bearer ${getToken()}` }
    });
    return handleResponse(res, endpoint.startsWith('/auth/'));
  },
  post: async (endpoint: string, data: any) => {
    if (!endpoint.startsWith('/auth/')) checkAccess();
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`
      },
      body: JSON.stringify(data),
    });
    return handleResponse(res, endpoint.startsWith('/auth/'));
  },
  put: async (endpoint: string, data: any) => {
    checkAccess();
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PUT",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`
      },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },
  patch: async (endpoint: string, data: any) => {
    checkAccess();
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "PATCH",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`
      },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },
  delete: async (endpoint: string) => {
    checkAccess();
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${getToken()}` }
    });
    return handleResponse(res);
  },
  upload: async (endpoint: string, formData: FormData) => {
    checkAccess();
    const res = await fetch(`${API_URL}/api${endpoint}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${getToken()}` },
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
