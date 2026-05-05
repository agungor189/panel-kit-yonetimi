export type UserRole = 'admin' | 'user' | 'readonly';

export interface ManagedUser {
  id: string;
  username: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  last_login_at?: string | null;
  notes?: string;
}

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
  product_series?: string;
  tube_type_code?: string;
  size_code?: string;
  form_code?: string;
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
  available_stock?: number;
  physical_stock?: number;
  product_type?: 'finished' | 'assembly' | 'component' | 'accessory';
  is_sellable?: boolean | number;
  visible_in_catalog?: boolean | number;
  exclude_from_analysis?: boolean | number;
  is_assembly?: boolean | number;
  stock_source?: 'central' | 'bom';
  bom_components?: ProductBomComponent[];
  bom_usage?: ProductBomUsage[];
  images?: ProductImage[];
  platforms?: ProductPlatform[];
}

export interface ProductBomComponent {
  component_product_id: string;
  quantity_per_unit: number;
  component_role?: string;
  sku?: string;
  title?: string;
  name?: string;
  central_stock?: number;
  available_for_parent?: number;
}

export interface ProductBomUsage {
  parent_product_id: string;
  quantity_per_unit: number;
  component_role?: string;
  sku?: string;
  title?: string;
  name?: string;
  available_stock?: number;
  physical_stock?: number;
  bottleneck_component?: {
    sku?: string;
    name?: string;
    quantity_per_unit?: number;
    central_stock?: number;
    available_for_parent?: number;
  } | null;
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

export interface TrendyolConfig {
  enabled: boolean;
  environment: 'stage' | 'prod';
  api_key_id: string;
  sync_window_days: number;
  store_front_code?: string;
}

export interface TrendyolMarketplaceOrder {
  id: string;
  platform: 'Trendyol';
  environment: 'stage' | 'prod';
  external_order_id: string;
  shipment_package_id: string;
  status?: string;
  panel_status?: string;
  customer_name?: string;
  customer_phone?: string;
  total_amount?: number;
  currency?: string;
  package_created_at?: string;
  package_last_modified_at?: string;
  sale_id?: string | null;
  imported_at?: string | null;
  sync_status?: string;
  sync_error?: string | null;
  line_count?: number;
  matched_line_count?: number;
  unmatched_line_count?: number;
  lines?: TrendyolMarketplaceOrderLine[];
  created_at?: string;
  updated_at?: string;
}

export interface TrendyolMarketplaceOrderLine {
  id: string;
  external_line_id: string;
  product_name?: string;
  barcode?: string;
  stock_code?: string;
  merchant_sku?: string;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
  status?: string;
  matched_product_id?: string | null;
  match_method?: string | null;
  match_confidence?: number;
  matched_product_title?: string | null;
  matched_product_sku?: string | null;
  matched_product_barcode?: string | null;
}

export interface TrendyolStatus {
  config: TrendyolConfig;
  keys: ApiKey[];
  stats: {
    total?: number;
    stage_count?: number;
    prod_count?: number;
    last_package_at?: string | null;
    last_local_update_at?: string | null;
    line_count?: number;
    matched_line_count?: number;
    unmatched_line_count?: number;
  };
  last_sync_at?: string | null;
  last_sync_summary?: {
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
    lines?: number;
    matched_lines?: number;
    unmatched_lines?: number;
    environment: 'stage' | 'prod';
  } | null;
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

export interface BackupConfig {
  enabled: boolean;
  run_at: string;
  retention_days: number;
  include_uploads: boolean;
  uploads_strategy: 'smart' | 'full' | 'incremental' | 'none';
  weekly_full_day: number;
}

export interface BackupRun {
  id: string;
  trigger_type: string;
  backup_kind: 'database' | 'uploads';
  upload_mode?: 'full' | 'incremental' | null;
  status: 'running' | 'success' | 'failed' | 'expired' | 'deleted';
  cloud_status?: 'not_configured' | 'uploading' | 'success' | 'failed' | 'skipped' | null;
  cloud_provider?: string | null;
  cloud_path?: string | null;
  cloud_uploaded_at?: string | null;
  cloud_error?: string | null;
  cloud_attempts?: number;
  file_name?: string | null;
  file_path?: string | null;
  size_bytes?: number;
  db_size_bytes?: number;
  upload_file_count?: number;
  upload_total_bytes?: number;
  error_message?: string | null;
  created_by?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface BackupStatus {
  config: BackupConfig;
  cloud?: {
    enabled: boolean;
    configured: boolean;
    provider: string;
    rclone_remote?: string | null;
    prefix: string;
    retention_days: number;
  };
  backup_dir: string;
  db_path: string;
  uploads_dir: string;
  next_run_at?: string | null;
  storage: {
    fileCount: number;
    totalBytes: number;
  };
  runs: BackupRun[];
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
  backup_config?: BackupConfig;
  sales_channels?: string[];
  commission_rates: Record<string, number>;
  product_categories: string[];
  income_categories: string[];
  expense_categories: string[];
}
