import { api } from '../../lib/api';

const buildQuery = (params?: any) => {
  if (!params) return '';
  const q = new URLSearchParams();
  Object.keys(params).forEach(k => {
    if (params[k] !== undefined && params[k] !== null) {
      q.append(k, String(params[k]));
    }
  });
  const str = q.toString();
  return str ? `?${str}` : '';
};

export const dashboardApi = {
  getWidgets: () => api.get('/dashboard/widgets'),
  getSummary: () => api.get('/dashboard-summary'),
  createWidget: (widget: any) => api.post('/dashboard/widgets', widget),
  updateWidgets: (widgets: any[]) => api.put('/dashboard/widgets', widgets),
  deleteWidget: (id: string) => api.delete(`/dashboard/widgets/${id}`),
  
  // Payment Widgets
  getPaymentSummary: (params?: any) => api.get(`/dashboard/widgets/payments/summary${buildQuery(params)}`),
  getPaymentUpcoming: (params?: any) => api.get(`/dashboard/widgets/payments/upcoming${buildQuery(params)}`),
  getPaymentCalendarMini: (params?: any) => api.get(`/dashboard/widgets/payments/calendar-mini${buildQuery(params)}`),
  getPaymentStatusShare: (params?: any) => api.get(`/dashboard/widgets/payments/status-share${buildQuery(params)}`),
  getPaymentMonthlyAmounts: (params?: any) => api.get(`/dashboard/widgets/payments/monthly-amounts${buildQuery(params)}`),
  
  // Product Widgets
  getProductSummary: (params?: any) => api.get(`/dashboard/widgets/product-analysis/summary${buildQuery(params)}`),
  getProductMaterialShare: (params?: any) => api.get(`/dashboard/widgets/product-analysis/material-share${buildQuery(params)}`),
  getProductModelShare: (params?: any) => api.get(`/dashboard/widgets/product-analysis/model-share${buildQuery(params)}`),
  getProductSalesTrend: (params?: any) => api.get(`/dashboard/widgets/product-analysis/sales-trend${buildQuery(params)}`),
  getProductReorderSummary: (params?: any) => api.get(`/dashboard/widgets/product-analysis/reorder-summary${buildQuery(params)}`),
};
