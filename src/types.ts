export type UserRole = 'admin' | 'user' | 'readonly';

export interface Product {
  id: string;
  name: string;
  title: string;
  warehouse_location: string;
  sku: string;
  barcode: string;
  category: string;
  model: string;
  material?: string;
  size?: string;
  pipe_size?: string;
  connection_type?: string;
  usage_area?: string;
  supplier?: string;
  min_stock_level?: number;
  description: string;
  purchase_price_usd: number;
  purchase_cost: number;
  sale_price: number;
  buffer_percentage: number;
  exchange_rate_used: number;
  weight: number;
  status: 'Active' | 'Passive' | 'Out of stock';
  notes: string;
  created_at: string;
  updated_at: string;
  cover_image?: string;
  central_stock?: number;
  total_stock?: number;
  images?: ProductImage[];
  platforms?: ProductPlatform[];
}

export interface ProductImage {
  id: string;
  product_id: string;
  path: string;
  sort_order: number;
}

export interface ProductPlatform {
  id: string;
  product_id: string;
  platform_name: string;
  stock: number;
  price: number;
  is_listed: boolean;
}

export interface Transaction {
  id: string;
  date: string;
  type: 'Income' | 'Expense';
  category: string;
  platform: string;
  amount: number;
  exchange_rate_at_transaction?: number;
  currency?: string;
  amount_try?: number;
  cash_account_id?: string;
  payer_person_id?: string;
  will_be_refunded?: number;
  refund_status?: string;
  is_invoice?: number;
  invoice_name?: string;
  is_stock_related?: number;
  distribute_to_product_cost?: number;
  document_url?: string;
  product_id?: string;
  product_title?: string;
  note: string;
  reference_number: string;
  recurring_id?: string;
  title?: string;
  description?: string;
  payment_method?: string;
  supplier?: string;
  invoice_number?: string;
  attachment_count?: number;
  created_at?: string;
}

export interface ExpenseAttachment {
  id: string;
  expense_id: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  uploaded_at: string;
}

export interface RecurringPaymentPlan {
  id: string;
  title: string;
  description?: string;
  category: string;
  payment_type: string;
  amount: number;
  currency: string;
  amount_try?: number;
  exchange_rate?: number;
  due_day?: number;
  due_month?: number;
  start_month?: number;
  week_day?: number;
  custom_interval_days?: number;
  frequency: string;
  start_date?: string;
  end_date?: string;
  next_due_date?: string;
  last_processed_date?: string;
  auto_process: boolean;
  is_active: boolean;
  payment_account_id?: string;
  expense_category_id?: string;
  tax_type?: string;
  related_party?: string;
  document_required: boolean;
  notes?: string;
}

export interface RecurringPaymentOccurrence {
  id: string;
  recurring_payment_id: string;
  due_date: string;
  amount: number;
  currency: string;
  exchange_rate?: number;
  amount_try?: number;
  status: 'pending' | 'due' | 'overdue' | 'processed' | 'skipped' | 'cancelled';
  processed_at?: string;
  expense_id?: string;
  transaction_id?: string;
  processed_by?: string;
  notes?: string;

  // Joined from plan
  plan_title?: string;
  plan_category?: string;
  plan_auto_process?: boolean;
  plan_payment_type?: string;
  plan_frequency?: string;
}

export interface DashboardMetrics {
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  lowStockCount: number;
  totalStockSalesValue: number;
  totalStockCostValue: number;
  totalBufferedCostValue: number;
  cashTotal?: number;
  pendingPlatform?: number;
  monthlyCashIn?: number;
  monthlyCashOut?: number;
  totalActivities?: number;
  totalChangedValues?: number;
}

export interface DashboardWidget {
  id: string;
  widget_type: string;
  position: number;
  is_visible: boolean;
  size: number;
  settings: any;
}

export interface ApiKey {
  id: string;
  service_name: string;
  display_name: string;
  key_name?: string;
  merchant_id?: string;
  seller_id?: string;
  status: 'active' | 'passive';
  last4: string;
  maskedKey?: string;
  notes?: string;
  last_test_status?: 'success' | 'failed';
  last_tested_at?: string;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanelApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last4: string;
  status: 'active' | 'passive' | 'revoked';
  environment: 'live' | 'test';
  permissions: string;
  allowed_ips?: string;
  expires_at?: string;
  last_used_at?: string;
  last_used_ip?: string;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
  maskedKey: string;
}

export interface Settings {
  company_name: string;
  low_stock_threshold: number;
  currency_symbol: string;
  language: string;
  usd_exchange_rate: number;
  default_buffer_percentage: number;
  default_profit_percentage?: string | number;
  api_key?: string;
  commission_rates: Record<string, number>;
  product_categories: string[];
  income_categories: string[];
  expense_categories: string[];
}
