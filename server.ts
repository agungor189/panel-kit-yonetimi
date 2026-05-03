import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import Database from "better-sqlite3";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import os from "os";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import AdmZip from "adm-zip";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { createProductAnalyticsRouter } from "./server/routes/productAnalyticsRoutes.js";
import { createRecurringPaymentsRouter } from "./server/routes/recurringPaymentsRoutes.js";
import { createDashboardDataRouter } from "./server/routes/dashboardDataRoutes.js";
import { generateNormalizedFields } from "./server/utils/normalizeProductFields.js";
import { restoreUploadEntry } from "./server/utils/restoreUploads.js";
import { initializeDatabase, openDatabase } from "./server/db/initialize.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      panelApiKey?: {
        id: string;
        name: string;
        permissions: string[];
      }
    }
  }
}

type AuthenticatedUser = {
  id: string;
  username: string;
  role: string;
  permissions: Record<string, unknown>;
  must_change_password: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Encryption Utility for API Keys
const ALGORITHM = 'aes-256-gcm';

if (!process.env.ENCRYPTION_SECRET) {
  throw new Error("ENCRYPTION_SECRET is required. Lütfen .env dosyanıza ekleyin!");
}
if (process.env.ENCRYPTION_SECRET.length < 32) {
  throw new Error(
    "ENCRYPTION_SECRET en az 32 karakter olmalıdır. Üret: " +
    "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  );
}

if (!process.env.PANEL_API_HASH_SECRET) {
  throw new Error("PANEL_API_HASH_SECRET is required. Lütfen .env dosyanıza ekleyin!");
}
if (process.env.PANEL_API_HASH_SECRET.length < 32) {
  throw new Error("PANEL_API_HASH_SECRET en az 32 karakter olmalıdır.");
}

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required. Lütfen .env dosyanıza ekleyin! (min 32 karakter önerilir)");
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET en az 32 karakter olmalıdır.");
}

// AES-256 needs exactly 32 bytes. The min-length check above guarantees we
// have enough material; we use the first 32 bytes as the key. Backwards-
// compatible with previously encrypted data.
const ENCRYPTION_SECRET = Buffer.from(process.env.ENCRYPTION_SECRET.slice(0, 32));

function encryptText(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptText(cipherText: string): string {
  if (!cipherText) return '';
  try {
    const [ivHex, authTagHex, encryptedHex] = cipherText.split(':');
    if (!ivHex || !authTagHex || !encryptedHex) return '';
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_SECRET, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error("Decryption error:", err);
    return '';
  }
}

function hashApiKey(clearKey: string): string {
  return crypto.createHmac('sha256', process.env.PANEL_API_HASH_SECRET!)
    .update(clearKey)
    .digest('hex');
}

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Database initialization — path is configurable via DB_PATH env var.
// Docker volumes: set DB_PATH=/data/dsdst_panel.db and mount /data as a volume.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "dsdst_panel.db");
let db = openDatabase(DB_PATH);
initializeDatabase(db);

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const expenseStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const expensesDir = path.join(process.cwd(), 'uploads', 'expenses');
    if (!fs.existsSync(expensesDir)) {
      fs.mkdirSync(expensesDir, { recursive: true });
    }
    cb(null, expensesDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `expense_${uuidv4()}${ext}`);
  }
});

const upload = multer({ storage });
const expenseUpload = multer({ 
  storage: expenseStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Sadece JPG, PNG, WEBP ve PDF dosyaları yüklenebilir.'));
    }
  }
});
// 500 MB max backup restore size — prevents disk exhaustion from malicious / corrupt uploads.
const backupUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

export const AppLogger = {
  info: (category: string, message: string, data?: any) => {
    console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), category, message, data }));
  },
  warn: (category: string, message: string, data?: any) => {
    console.warn(JSON.stringify({ level: 'WARN', timestamp: new Date().toISOString(), category, message, data }));
  },
  error: (category: string, message: string, error?: any) => {
    console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), category, message, error: error?.message || error, stack: error?.stack }));
  }
};

function logActivity(action: string, entity_type: string, entity_id: string, details?: any, userId?: string) {
  try {
    db.prepare(`
      INSERT INTO activity_logs (id, action, entity_type, entity_id, details, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), action, entity_type, entity_id, details ? JSON.stringify(details) : null, userId ?? null);
  } catch (err) {
    AppLogger.error('DATABASE_ERROR', 'Activity logging failed', err);
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mergeProductPlatforms(platforms: any[] | undefined, fallbackPrice?: unknown): any[] {
  if (!Array.isArray(platforms)) return [];

  const merged = new Map<string, any>();
  for (const platform of platforms) {
    const name = cleanText(platform?.name ?? platform?.platform_name);
    if (!name) continue;

    const existing = merged.get(name) || {
      ...platform,
      name,
      platform_name: name,
      stock: 0,
      is_listed: 0,
    };

    if (platform?.stock !== undefined && platform.stock !== null) {
      existing.stock = (Number(existing.stock) || 0) + (Number(platform.stock) || 0);
      existing.stockProvided = true;
    }

    if (platform?.price !== undefined && platform.price !== null) {
      existing.price = Number(platform.price) || 0;
      existing.priceProvided = true;
    } else if (existing.price === undefined && fallbackPrice !== undefined) {
      existing.price = Number(fallbackPrice) || 0;
    }

    if (platform?.is_listed !== undefined && platform.is_listed !== null) {
      existing.is_listed = existing.is_listed || (platform.is_listed ? 1 : 0);
      existing.listedProvided = true;
    }

    merged.set(name, existing);
  }

  return [...merged.values()];
}

function stockQuantity(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function legacyPlatformStockTotal(platforms: any[] | undefined): number {
  if (!Array.isArray(platforms)) return 0;
  return platforms.reduce((total, platform) => total + stockQuantity(platform?.stock), 0);
}

function hasCentralStockPayload(body: any): boolean {
  if (!body) return false;
  if (body.central_stock !== undefined || body.total_stock !== undefined || body.stock !== undefined) return true;
  return Array.isArray(body.platforms) && body.platforms.some((platform: any) => platform?.stock !== undefined && platform?.stock !== null);
}

function resolveCentralStock(body: any, fallback = 0): number {
  if (body?.central_stock !== undefined && body.central_stock !== null && body.central_stock !== '') {
    return stockQuantity(body.central_stock);
  }
  if (body?.total_stock !== undefined && body.total_stock !== null && body.total_stock !== '') {
    return stockQuantity(body.total_stock);
  }
  if (body?.stock !== undefined && body.stock !== null && body.stock !== '') {
    return stockQuantity(body.stock);
  }
  const legacyStock = legacyPlatformStockTotal(body?.platforms);
  if (legacyStock > 0) return legacyStock;
  return stockQuantity(fallback);
}

function centralStockChannel(platformName?: string | null): string {
  const channel = cleanText(platformName);
  return channel || 'Merkez Depo';
}

function buildExpenseCashDescription(expense: any): string {
  const category = cleanText(expense?.category) || 'Gider';
  const detail =
    cleanText(expense?.title) ||
    cleanText(expense?.note) ||
    cleanText(expense?.description) ||
    cleanText(expense?.reference_number);

  return detail ? `Gider: ${category} - ${detail}` : `Gider: ${category}`;
}

function getExpensePaymentAccountId(expense: any): string | null {
  return expense?.payer_person_id || expense?.cash_account_id || null;
}

function ensureActiveCashAccount(accountId: string): any {
  const account = db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(accountId) as any;
  if (!account) throw new Error("Geçersiz hesap.");
  if (account.is_active === 0) throw new Error("Seçili hesap pasif.");
  return account;
}

function insertExpenseCashTransaction(expense: any): string {
  const accountId = getExpensePaymentAccountId(expense);
  if (!accountId) throw new Error("Gider eklerken ödeme hesabı veya ödeyen kişi seçimi zorunludur.");
  ensureActiveCashAccount(accountId);

  const amount = Number(expense.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Tutar 0'dan büyük olmalıdır.");

  const exchangeRate = Number(expense.exchange_rate_at_transaction || expense.exchange_rate || 1);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("Döviz kuru geçerli değil.");

  const cashTxId = uuidv4();
  db.prepare(`
    INSERT INTO cash_transactions (
      id, account_id, type, amount, currency, exchange_rate_at_transaction,
      source_type, source_id, description, transaction_date, is_deleted
    )
    VALUES (?, ?, 'OUT', ?, ?, ?, 'expense', ?, ?, ?, 0)
  `).run(
    cashTxId,
    accountId,
    amount,
    expense.currency || 'TRY',
    exchangeRate,
    expense.id,
    buildExpenseCashDescription(expense),
    expense.date || new Date().toISOString(),
  );

  return cashTxId;
}

function syncExpenseCashTransaction(expense: any): void {
  const accountId = getExpensePaymentAccountId(expense);
  if (!accountId) throw new Error("Gider eklerken ödeme hesabı veya ödeyen kişi seçimi zorunludur.");
  ensureActiveCashAccount(accountId);

  const amount = Number(expense.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Tutar 0'dan büyük olmalıdır.");

  const exchangeRate = Number(expense.exchange_rate_at_transaction || expense.exchange_rate || 1);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("Döviz kuru geçerli değil.");

  const existingCash = db.prepare(`
    SELECT *
    FROM cash_transactions
    WHERE source_type = 'expense'
      AND source_id = ?
      AND COALESCE(is_deleted, 0) = 0
    ORDER BY created_at DESC
    LIMIT 1
  `).get(expense.id) as any;

  if (!existingCash) {
    insertExpenseCashTransaction(expense);
    return;
  }

  if (existingCash.account_id !== accountId) {
    db.prepare("UPDATE cash_transactions SET is_deleted = 1 WHERE id = ?").run(existingCash.id);
    insertExpenseCashTransaction(expense);
    return;
  }

  db.prepare(`
    UPDATE cash_transactions
    SET amount = ?,
        currency = ?,
        exchange_rate_at_transaction = ?,
        description = ?,
        transaction_date = ?
    WHERE id = ?
  `).run(
    amount,
    expense.currency || 'TRY',
    exchangeRate,
    buildExpenseCashDescription(expense),
    expense.date || existingCash.transaction_date || existingCash.created_at,
    existingCash.id,
  );
}

// -- EXCHANGE RATES LOGIC --
async function fetchExchangeRate() {
  let rate = 0;
  let source = '';
  
  try {
    // Primary: Yahoo Finance (Real-time)
    try {
      const yahooRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/TRY=X");
      if (yahooRes.ok) {
         const data = await yahooRes.json();
         const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
         if (price && price > 0) {
            rate = parseFloat(price);
            source = 'Yahoo Finance';
         }
      }
    } catch(e) {}

    // Secondary: open.er-api.com
    if (!rate || rate <= 0) {
      try {
        const backupRes = await fetch("https://open.er-api.com/v6/latest/USD");
        if (backupRes.ok) {
           const data = await backupRes.json();
           if (data?.rates?.TRY) {
              rate = data.rates.TRY;
              source = 'open.er-api.com';
           }
        }
      } catch(e) {}
    }

    // Tertiary: TCMB
    if (!rate || rate <= 0) {
      try {
        const tcmbRes = await fetch("https://www.tcmb.gov.tr/kurlar/today.xml");
        if (tcmbRes.ok) {
           const text = await tcmbRes.text();
           const match = text.match(/<Currency[^>]*Kod="USD"[\s\S]*?<ForexSelling>(.*?)<\/ForexSelling>/);
           if (match && match[1]) {
              rate = parseFloat(match[1]);
              source = 'TCMB';
           }
        }
      } catch(e) {}
    }

    if (rate > 0) {
       db.prepare(`UPDATE exchange_rates SET is_active = 0 WHERE is_active = 1`).run();
       db.prepare(`
         INSERT INTO exchange_rates (id, base_currency, target_currency, rate, source, is_active)
         VALUES (?, 'USD', 'TRY', ?, ?, 1)
       `).run(uuidv4(), rate, source);
       console.log(`[ExchangeRate] Successfully fetched ${rate} from ${source}`);
       
       // logActivity('CREATE', 'setting', 'exchange_rate', { details: `Kur güncellendi: ${rate} (Kaynak: ${source})` });
       return true;
    }
  } catch (err: any) {
    console.error(`[ExchangeRate Error] ${err.message}`);
    // logActivity('CREATE', 'setting', 'exchange_rate_error', { details: `Kur güncellenemedi: ${err.message}` });
  }
  return false;
}

// Initial fetch on startup
setTimeout(fetchExchangeRate, 2000);
// Fetch daily (86400000 ms)
setInterval(fetchExchangeRate, 86400000);

export function getActiveExchangeRate() {
   const row = db.prepare("SELECT * FROM exchange_rates WHERE is_active = 1 ORDER BY fetched_at DESC LIMIT 1").get() as any;
   return row?.rate || 0;
}

// -- END EXCHANGE RATES LOGIC --

async function startServer() {
  const app = express();
  const PORT = 3000;
  app.set('trust proxy', 1);

  // Security Headers (Helmet)
  // Disabled Content Security Policy for Vite/React development compatibility.
  // In a strict production environment, you should configure CSP properly.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false
  }));

  // General Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: "Çok fazla istek gönderildi, lütfen daha sonra tekrar deneyin."
  });
  app.use(limiter);

  // CORS: allow specific origins via ALLOWED_ORIGINS env var (comma-separated).
  // Leaving ALLOWED_ORIGINS unset permits all origins (useful for local dev behind a tunnel).
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  app.use(cors({
    origin: allowedOrigins.length > 0
      ? (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error(`CORS: origin '${origin}' not allowed`));
          }
        }
      : true,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' })); // Limit JSON body size
  app.use("/uploads", express.static(uploadsDir, { maxAge: '1d' }));

  // JWT_SECRET validated at startup — no fallback allowed.
  const JWT_SECRET = process.env.JWT_SECRET!;

  const parseUserPermissions = (permissions: string | null | undefined): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(permissions || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const loadUserForAuth = (userId: string): { user?: AuthenticatedUser; disabled?: boolean } => {
    const dbUser = db.prepare(`
      SELECT id, username, role, is_active, permissions, must_change_password
      FROM users
      WHERE id = ?
    `).get(userId) as any;

    if (!dbUser) return {};
    if (dbUser.is_active === 0) return { disabled: true };

    return {
      user: {
        id: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        permissions: parseUserPermissions(dbUser.permissions),
        must_change_password: dbUser.must_change_password === 1,
      },
    };
  };

  const authRouter = express.Router();
  authRouter.post('/login', (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Kullanıcı adı ve şifre zorunludur.' } });
      }

      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
      if (!user) {
        logActivity('LOGIN_FAILED', 'auth', 'unknown', { username, ip: req.ip, reason: 'user_not_found' });
        return res.status(401).json({ success: false, error: { code: 'AUTH_FAILED', message: 'Geçersiz kullanıcı adı veya şifre.' } });
      }

      if (user.is_active === 0) {
        return res.status(403).json({ success: false, error: { code: 'ACCOUNT_DISABLED', message: 'Bu hesap devre dışı bırakılmış.' } });
      }

      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) {
        logActivity('LOGIN_FAILED', 'auth', user.id, { username, ip: req.ip, reason: 'wrong_password' });
        return res.status(401).json({ success: false, error: { code: 'AUTH_FAILED', message: 'Geçersiz kullanıcı adı veya şifre.' } });
      }

      db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
      logActivity('LOGIN_SUCCESS', 'auth', user.id, { username, ip: req.ip }, user.id);

      const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '12h' });
      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          must_change_password: user.must_change_password === 1,
        },
      });
    } catch (err: any) {
      AppLogger.error('AUTH_ERROR', 'Login failed', err);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  // Change own password — requires current password verification.
  // Also used for forced password change after first login.
  authRouter.post('/change-password', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Token gerekli.' } });
    }
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
      const { current_password, new_password } = req.body;

      if (!current_password || !new_password) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Mevcut ve yeni şifre zorunludur.' } });
      }
      if (new_password.length < 8) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Yeni şifre en az 8 karakter olmalıdır.' } });
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(decoded.id) as any;
      if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Kullanıcı bulunamadı.' } });
      if (user.is_active === 0) {
        return res.status(403).json({ success: false, error: { code: 'USER_DISABLED', message: 'Bu hesap devre dışı bırakılmış.' } });
      }

      if (!bcrypt.compareSync(current_password, user.password_hash)) {
        return res.status(401).json({ success: false, error: { code: 'AUTH_FAILED', message: 'Mevcut şifre yanlış.' } });
      }

      const newHash = bcrypt.hashSync(new_password, 10);
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(newHash, user.id);

      logActivity('PASSWORD_CHANGED', 'auth', user.id, { ip: req.ip }, user.id);
      res.json({ success: true, message: 'Şifre başarıyla değiştirildi.' });
    } catch (err: any) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Geçersiz token.' } });
    }
  });

  authRouter.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out' });
  });

  authRouter.get('/me', (req, res) => {
     const authHeader = req.headers.authorization;
     if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No token' } });
     try {
       const token = authHeader.split(' ')[1];
       const decoded = jwt.verify(token, JWT_SECRET) as any;
       const authUser = loadUserForAuth(decoded.id);
       if (authUser.disabled) {
         return res.status(403).json({ success: false, error: { code: 'USER_DISABLED', message: 'Bu hesap devre dışı bırakılmış.' } });
       }
       if (!authUser.user) {
         return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid user' } });
       }
       res.json({
         success: true,
         user: authUser.user,
       });
     } catch (err) {
       res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
     }
  });

  // Strict rate-limit on login — brute-force protection.
  // 10 attempts per 15 min per IP, only failed attempts count toward the limit.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Çok fazla başarısız giriş denemesi. 15 dakika sonra tekrar deneyin.' } },
  });
  app.use("/api/auth/login", loginLimiter);

  app.use("/api/auth", authRouter);

  // API Authentication Middleware
  app.use("/api", (req, res, next) => {
    // allow auth routes and public API routes with their own auth/limits
    if (req.path.startsWith('/auth/') || req.path.startsWith('/public/')) return next();

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
       try {
         const token = authHeader.split(' ')[1];
         const decoded = jwt.verify(token, JWT_SECRET) as any;
         const authUser = loadUserForAuth(decoded.id);
         if (authUser.disabled) {
           return res.status(403).json({
             success: false,
             error: { code: 'USER_DISABLED', message: 'Bu hesap devre dışı bırakılmış.' },
           });
         }
         if (!authUser.user) {
           return res.status(401).json({
             success: false,
             error: { code: 'UNAUTHORIZED', message: 'Invalid user.' },
           });
         }
         req.user = authUser.user;
         return next();
       } catch (err: any) {
         AppLogger.warn('AUTH_ERROR', 'JWT verification failed', { message: err.message, ip: req.ip });
         return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' } });
       }
    }

    const apiKeyHeader = req.headers['x-api-key'] || (authHeader && !authHeader.startsWith('Bearer ') ? authHeader : undefined);
    const settingsApiKey = db.prepare("SELECT value FROM settings WHERE key='api_key'").get() as any;
    
    if (settingsApiKey && settingsApiKey.value && apiKeyHeader === settingsApiKey.value) {
        req.user = {
          id: 'legacy-api-key',
          username: 'legacy-api-key',
          role: 'api_key',
          permissions: {},
          must_change_password: false,
        };
        return next();
    }

    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized access.' } });
  });

  // Enforce first-login password changes server-side. Login and change-password
  // remain available through /api/auth; every other JWT-backed route is blocked
  // until the user's password is changed.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path.startsWith('/public/')) return next();

    const user = req.user;
    if (!user || user.role === 'api_key') return next();

    if (user.must_change_password) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Devam etmeden önce şifrenizi değiştirmeniz gerekiyor.',
        },
      });
    }

    next();
  });

  // Server-side write protection: readonly users and the legacy static API key cannot call mutating methods.
  // This enforces access control on the server, not just the client.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path.startsWith('/public/')) return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const user = req.user;
    if (user?.role === 'readonly' || user?.role === 'api_key') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Bu kimlik bilgisi yazma işlemleri için yetkili değil.' },
      });
    }
    next();
  });

  // Helper middleware — admin-only routes (backup, restore, user management, settings).
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      logActivity('FORBIDDEN_ACCESS', 'system', req.path, { method: req.method, ip: req.ip }, user?.id);
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Bu işlem için admin yetkisi gereklidir.' },
      });
    }
    next();
  };

  // --- API ROUTES ---

  // Activity Logs
  app.get("/api/activity-logs", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const offset = Number(req.query.offset) || 0;
      const { entity_type, action, user_id } = req.query;

      let sql = "SELECT * FROM activity_logs WHERE 1=1";
      const params: any[] = [];
      if (entity_type) { sql += " AND entity_type = ?"; params.push(entity_type); }
      if (action)      { sql += " AND action = ?";      params.push(action); }
      if (user_id)     { sql += " AND user_id = ?";     params.push(user_id); }
      sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const logs = db.prepare(sql).all(...params);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Analytics Endpoint
  app.get("/api/analytics", (req, res) => {
    try {
      const period = req.query.period || 'this_month';
      const now = new Date();
      let startDateStr = '';
      let endDateStr = `${now.toISOString()}`;

      if (period === 'today') {
        const today = new Date(now.setHours(0,0,0,0));
        startDateStr = today.toISOString();
      } else if (period === 'this_week') {
        const today = new Date();
        const startOfWeek = new Date(today.setDate(today.getDate() - today.getDay() + 1));
        startOfWeek.setHours(0,0,0,0);
        startDateStr = startOfWeek.toISOString();
      } else if (period === 'last_3_months') {
        const start = new Date(now.setMonth(now.getMonth() - 2));
        start.setDate(1);
        start.setHours(0,0,0,0);
        startDateStr = start.toISOString();
      } else if (period === 'last_6_months') {
        const start = new Date(now.setMonth(now.getMonth() - 5));
        start.setDate(1);
        start.setHours(0,0,0,0);
        startDateStr = start.toISOString();
      } else if (period === 'this_year') {
        const start = new Date(now.getFullYear(), 0, 1);
        startDateStr = start.toISOString();
      } else {
        // default this_month
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        startDateStr = start.toISOString();
      }

      // Base filtered sales
      const sales = db.prepare(`SELECT * FROM sales WHERE created_at >= ? AND status NOT IN ('İptal Edildi', 'İade Edildi')`).all(startDateStr) as any[];
      const saleIds = sales.map(s => s.id);
      
      let saleItems: any[] = [];
      if (saleIds.length > 0) {
         const placeholders = saleIds.map(() => '?').join(',');
         saleItems = db.prepare(`
           SELECT si.*, p.model, p.material, p.category, p.size, p.sku, s.platform
           FROM sale_items si 
           LEFT JOIN products p ON si.product_id = p.id
           JOIN sales s ON si.sale_id = s.id
           WHERE si.sale_id IN (${placeholders}) AND s.status NOT IN ('İptal Edildi', 'İade Edildi')
         `).all(...saleIds) as any[];
      }

      // Get expenses
      const expenses = db.prepare(`SELECT * FROM transactions WHERE type = 'Expense' AND date >= ?`).all(startDateStr) as any[];

      // Aggregations
      const metrics = {
        totalRevenue: sales.reduce((ac, s) => ac + (s.net_total || 0), 0),
        grossProfit: sales.reduce((ac, s) => ac + (s.gross_profit || 0), 0),
        netProfit: sales.reduce((ac, s) => ac + (s.net_profit || 0), 0) - expenses.reduce((ac, ex) => ac + ex.amount, 0),
        totalOrders: sales.length,
        totalItemsSold: saleItems.reduce((ac, si) => ac + si.quantity, 0),
        totalShipping: sales.reduce((ac, s) => ac + (s.shipping_cost || 0), 0),
        totalCommission: sales.reduce((ac, s) => ac + ((s.total_amount || 0) * (s.commission_rate || 0) / 100), 0),
        totalAds: sales.reduce((ac, s) => ac + (s.ad_spend || 0), 0),
        totalPackaging: sales.reduce((ac, s) => ac + (s.packaging_cost || 0), 0),
        generalExpenses: expenses.reduce((ac, ex) => ac + ex.amount, 0)
      };

      res.json({ success: true, metrics, sales, saleItems, expenses });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard Widgets Endpoints
  app.get("/api/dashboard/widgets", (req, res) => {
    try {
      const user_id = req.query.user_id || 'admin';
      const widgets = db.prepare("SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position ASC").all(user_id) as any[];
      const parsedWidgets = widgets.map(w => ({...w, settings_json: JSON.parse(w.settings_json || '{}')}));
      res.json(parsedWidgets);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/dashboard/widgets", (req, res) => {
    try {
      // Expects array of updates
      const widgets = Array.isArray(req.body) ? req.body : [req.body];
      const stmt = db.prepare("UPDATE dashboard_widgets SET title = ?, description = ?, size = ?, position = ?, is_visible = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      const transaction = db.transaction((updates) => {
        for (const w of updates) {
          stmt.run(w.title, w.description, w.size, w.position, w.is_visible, JSON.stringify(w.settings_json || {}), w.id);
        }
      });
      transaction(widgets);
      res.json({ success: true });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/dashboard/widgets", (req, res) => {
    try {
      const w = req.body;
      const id = w.id || uuidv4();
      const insert = db.prepare("INSERT INTO dashboard_widgets (id, user_id, widget_key, title, description, widget_type, source_module, size, position, is_visible, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run(id, w.user_id || 'admin', w.widget_key, w.title || '', w.description || '', w.widget_type, w.source_module, w.size || 'small', w.position || 0, w.is_visible !== undefined ? w.is_visible : 1, JSON.stringify(w.settings_json || {}));
      res.json({ id });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/dashboard/widgets/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM dashboard_widgets WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dashboard Summary Endpoint
  app.get("/api/dashboard-summary", (req, res) => {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const firstDayOfMonth = `${year}-${month}-01T00:00:00Z`;
      const lastDayOfMonthStr = `${year}-${month}-${new Date(year, now.getMonth() + 1, 0).getDate().toString().padStart(2, '0')}`;
      const currentMonthStr = `${year}-${month}`;

      // Metrics (Exclude Cancelled Sales)
      const revenueResult = db.prepare("SELECT SUM(net_total) as total FROM sales WHERE created_at >= ? AND status NOT IN ('İptal Edildi', 'İade Edildi')").get(firstDayOfMonth) as any;
      const salesProfitResult = db.prepare("SELECT SUM(net_profit) as total, SUM(gross_profit) as gross FROM sales WHERE created_at >= ? AND status NOT IN ('İptal Edildi', 'İade Edildi')").get(firstDayOfMonth) as any;
      const realizedExpensesResult = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'Expense' AND date >= ? AND COALESCE(is_deleted, 0) = 0").get(firstDayOfMonth) as any;

      // Cash Metrics
      // 1. Total Cash Balance
      const cashAccountsTotal = db.prepare(`
         SELECT 
           SUM(
             opening_balance + 
             COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND type='IN' AND COALESCE(is_deleted, 0) = 0), 0) -
             COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND type='OUT' AND COALESCE(is_deleted, 0) = 0), 0)
           ) as total
         FROM cash_accounts a
         WHERE a.type != 'platform'
      `).get() as any;
      
      const pendingPlatformTotal = db.prepare(`
         SELECT 
           SUM(
             opening_balance + 
             COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND type='IN' AND COALESCE(is_deleted, 0) = 0), 0) -
             COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND type='OUT' AND COALESCE(is_deleted, 0) = 0), 0)
           ) as total
         FROM cash_accounts a
         WHERE a.type = 'platform'
      `).get() as any;

      const monthlyCashIn = db.prepare("SELECT SUM(amount) as total FROM cash_transactions WHERE type='IN' AND COALESCE(transaction_date, created_at) >= ? AND source_type='sale' AND COALESCE(is_deleted, 0) = 0").get(firstDayOfMonth) as any;
      const monthlyCashOut = db.prepare("SELECT SUM(amount) as total FROM cash_transactions WHERE type='OUT' AND COALESCE(transaction_date, created_at) >= ? AND source_type='expense' AND COALESCE(is_deleted, 0) = 0").get(firstDayOfMonth) as any;

      const pendingOccurrences = db.prepare(`
        SELECT SUM(amount_try) as total 
        FROM recurring_payment_occurrences 
        WHERE status IN ('pending', 'due', 'overdue')
          AND due_date >= ? AND due_date <= ?
      `).get(`${year}-${month}-01`, lastDayOfMonthStr) as any;
      let pendingRecurringTotal = pendingOccurrences?.total || 0;

      const totalRevenue = revenueResult?.total || 0;
      const salesNetProfit = salesProfitResult?.total || 0;
      const salesGrossProfit = salesProfitResult?.gross || 0;
      const totalExpenses = (realizedExpensesResult?.total || 0) + pendingRecurringTotal;

      const lowStockProductsQuery = db.prepare(`
        SELECT p.*,
          (SELECT path FROM product_images WHERE product_id = p.id ORDER BY sort_order ASC LIMIT 1) as cover_image,
          COALESCE(p.central_stock, 0) as total_stock
        FROM products p
        WHERE COALESCE(p.central_stock, 0) <= COALESCE(NULLIF(p.min_stock_level, 0), CAST((SELECT value FROM settings WHERE key = 'low_stock_threshold') AS INTEGER), 50)
        AND p.status = 'Active'
        ORDER BY total_stock ASC
      `).all() as any[];

      const allProducts = db.prepare(`
        SELECT p.id, p.purchase_cost, p.sale_price, p.purchase_price_usd, p.exchange_rate_used, p.buffer_percentage, p.material, p.model, p.size, p.category,
          COALESCE(p.central_stock, 0) as total_stock
        FROM products p
      `).all() as any[];

      let totalSaleValue = 0;
      let totalCostValue = 0;
      let totalBufferedCostValue = 0;

      for (const p of allProducts) {
        if (p.total_stock <= 0) continue;
        totalSaleValue += (p.total_stock * (p.sale_price || 0));
        const pc = p.purchase_cost || ((p.purchase_price_usd || 0) * (p.exchange_rate_used || 0));
        totalCostValue += (p.total_stock * pc);
        totalBufferedCostValue += (p.total_stock * pc * (1 + (p.buffer_percentage || 0) / 100));
      }

      const metrics = {
        totalRevenue,
        totalExpenses,
        grossProfit: salesGrossProfit,
        netProfit: salesNetProfit - totalExpenses,
        netProfitMargin: totalRevenue > 0 ? ((salesNetProfit - totalExpenses) / totalRevenue) * 100 : 0,
        lowStockCount: lowStockProductsQuery.length,
        totalStockSalesValue: totalSaleValue,
        totalStockCostValue: totalCostValue,
        totalBufferedCostValue: totalBufferedCostValue,
        stockEstProfit: totalSaleValue - totalCostValue,
        lowStockProducts: lowStockProductsQuery,
        cashTotal: cashAccountsTotal?.total || 0,
        pendingPlatform: pendingPlatformTotal?.total || 0,
        monthlyCashIn: monthlyCashIn?.total || 0,
        monthlyCashOut: monthlyCashOut?.total || 0
      };

      // Charts: 6 Month History
      const monthlyExpenses = db.prepare(`
        SELECT strftime('%Y-%m', date) as month, SUM(amount) as expense
        FROM transactions WHERE type = 'Expense' GROUP BY month
      `).all() as any[];
      const monthlySales = db.prepare(`
        SELECT strftime('%Y-%m', created_at) as month, SUM(net_total) as income, SUM(net_profit) as profit
        FROM sales WHERE status NOT IN ('İptal Edildi', 'İade Edildi') GROUP BY month
      `).all() as any[];

      const monthMap: Record<string, { income: number, expense: number, profit: number }> = {};
      monthlySales.forEach(row => {
        monthMap[row.month] = { income: row.income, profit: row.profit, expense: 0 };
      });
      monthlyExpenses.forEach(row => {
        if (!monthMap[row.month]) monthMap[row.month] = { income: 0, profit: 0, expense: 0 };
        monthMap[row.month].expense = row.expense;
      });

      let monthlyDataRaw = Object.keys(monthMap).map(m => ({
        month: m,
        income: monthMap[m].income,
        expense: monthMap[m].expense,
        profit: monthMap[m].profit
      })).sort((a,b) => b.month.localeCompare(a.month)).slice(0, 6);

      let monthlyData = [...monthlyDataRaw];
      let foundCurrent = false;
      monthlyData = monthlyData.map(d => {
        if (d.month === currentMonthStr) {
          foundCurrent = true;
          return { ...d, expense: d.expense + pendingRecurringTotal };
        }
        return d;
      });

      if (!foundCurrent && pendingRecurringTotal > 0) {
        monthlyData.unshift({ month: currentMonthStr, income: 0, profit: 0, expense: pendingRecurringTotal });
        if (monthlyData.length > 6) monthlyData.pop();
      }
      monthlyData.reverse();

      // Charts: Platform Revenue
      const platformRevenue = db.prepare(`
        SELECT platform, SUM(total_amount) as total
        FROM sales
        GROUP BY platform
      `).all();

      const charts = { monthlyData, platformRevenue };

      // Recent Transactions
      const recentTransactions = db.prepare("SELECT * FROM transactions ORDER BY date DESC LIMIT 10").all();

      res.json({ metrics, charts, recentTransactions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Products CRUD
  const productSchema = z.object({
    name: z.string().optional(),
    sku: z.string().min(1, "SKU boş bırakılamaz"),
    purchase_cost: z.number().min(0, "Maliyet negatif olamaz").optional(),
    sale_price: z.number().min(0, "Satış fiyatı negatif olamaz").optional(),
    material: z.string().optional().default("Bilinmiyor"),
    model: z.string().optional().default("Bilinmiyor"),
    size: z.string().optional().default("Bilinmiyor"),
    pipe_size: z.string().optional().default("Bilinmiyor"),
    central_stock: z.coerce.number().min(0, "Merkez depo stoğu negatif olamaz").optional(),
    total_stock: z.coerce.number().min(0, "Merkez depo stoğu negatif olamaz").optional(),
    platforms: z.array(z.object({
      name: z.string(),
      stock: z.coerce.number().min(0, "Stok negatif olamaz").optional(),
      price: z.number().min(0, "Platform fiyatı negatif olamaz").optional(),
      is_listed: z.boolean().optional()
    }).passthrough()).optional()
  }).passthrough();

  app.post("/api/products/bulk-import", (req, res) => {
    const items = req.body;
    if (!Array.isArray(items)) {
       return res.status(400).json({ success: false, error: { code: 'INVALID_ROOT', message: 'Payload array olmalıdır' } });
    }

    try {
      db.transaction(() => {
        for (const rawItem of items) {
          const validated = productSchema.parse(rawItem) as any;
          
          // Duplicate check
          const existing = db.prepare("SELECT id FROM products WHERE sku = ?").get(validated.sku) as any;
          if (existing) {
             throw new Error(`Duplicate SKU found: ${validated.sku}`);
          }

          const id = uuidv4();
          const centralStock = resolveCentralStock(validated);
          const { normalized_material, normalized_model, normalized_size, normalized_tube_type } = generateNormalizedFields({ material: validated.material, model: validated.model, size: validated.size, category: validated.category, name: validated.name });

          db.prepare(`
            INSERT INTO products (id, name, title, sku, barcode, category, model, description, purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked, weight, status, material, size, connection_type, usage_area, supplier, min_stock_level, central_stock, normalized_material, normalized_model, normalized_size, normalized_tube_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id, validated.name, validated.title, validated.sku, validated.barcode, validated.category, validated.model, validated.description, 
            validated.purchase_price_usd || 0, validated.purchase_cost || 0, validated.sale_price || 0, validated.buffer_percentage || 0, validated.profit_percentage || 0, validated.exchange_rate_used || 0, validated.price_locked ? 1 : 0, 
            validated.weight || 0, validated.status || 'active', validated.material, validated.size, validated.connection_type, validated.usage_area, validated.supplier, validated.min_stock_level !== undefined ? validated.min_stock_level : 50, centralStock,
            normalized_material, normalized_model, normalized_size, normalized_tube_type
          );

          if (validated.platforms) {
             for (const p of mergeProductPlatforms(validated.platforms, validated.sale_price)) {
               db.prepare(`INSERT INTO product_platforms (id, product_id, platform_name, stock, price, is_listed) VALUES (?, ?, ?, ?, ?, ?)`).run(uuidv4(), id, p.name, 0, p.price ?? validated.sale_price ?? 0, p.is_listed ? 1 : 0);
             }
          }
        }
      })();
      res.json({ success: true, message: `${items.length} ürün import edildi.` });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.issues } });
      }
      AppLogger.error('IMPORT_ERROR', 'Bulk import failed', err);
      res.status(400).json({ success: false, error: { code: 'IMPORT_FAILED', message: err.message } });
    }
  });

  app.get("/api/products", (req, res) => {
    const products = db.prepare(`
      SELECT p.*, 
        (SELECT path FROM product_images WHERE product_id = p.id ORDER BY sort_order ASC LIMIT 1) as cover_image,
        COALESCE(p.central_stock, 0) as total_stock
      FROM products p
      ORDER BY p.created_at DESC
    `).all();
    res.json(products);
  });

  app.get("/api/products/:id", (req, res) => {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) as any;
    if (!product) return res.status(404).json({ error: "Product not found" });

    const images = db.prepare("SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order ASC").all(req.params.id);
    const platforms = db.prepare("SELECT * FROM product_platforms WHERE product_id = ?").all(req.params.id);
    
    res.json({ ...product, total_stock: product.central_stock || 0, images, platforms });
  });



  app.post("/api/products", (req, res) => {
    const id = uuidv4();
    const { 
      name, title, warehouse_location, sku, barcode, category, model, description, 
      purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked,
      weight, status, notes, platforms, images, material, size, pipe_size, connection_type, usage_area, supplier, min_stock_level
    } = req.body;
    const centralStock = resolveCentralStock(req.body);
    
    // We pass the full body to generateNormalizedFields to use pipe_size inside it if needed.
    const { normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size } = generateNormalizedFields({ ...req.body, material, model, size, category, name, pipe_size });

    const insertProduct = db.prepare(`
      INSERT INTO products (id, name, title, warehouse_location, sku, barcode, category, model, description, purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked, weight, status, notes, material, size, pipe_size, connection_type, usage_area, supplier, min_stock_level, central_stock, normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      insertProduct.run(
        id, name, title, warehouse_location, sku || `SKU-${Date.now()}`, barcode, category, model, description, 
        purchase_price_usd || 0, purchase_cost || 0, sale_price || 0, buffer_percentage || 0, profit_percentage || 0, exchange_rate_used || 0, price_locked ? 1 : 0, 
        weight || 0, status, notes, material, size, pipe_size, connection_type, usage_area, supplier, min_stock_level !== undefined ? min_stock_level : 50, centralStock,
        normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size
      );
      
      const insertPlatform = db.prepare(`
        INSERT INTO product_platforms (id, product_id, platform_name, stock, price, is_listed)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const p of mergeProductPlatforms(platforms, sale_price)) {
        insertPlatform.run(uuidv4(), id, p.name, 0, p.price ?? sale_price ?? 0, p.is_listed ? 1 : 0);
      }

      if (centralStock > 0) {
        db.prepare(`
          INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, 'Merkez Depo', centralStock, 'İlk merkez depo stoğu', 'ADJUST');
      }

      if (images && Array.isArray(images)) {
        const insertImg = db.prepare("INSERT INTO product_images (id, product_id, path, sort_order) VALUES (?, ?, ?, ?)");
        images.forEach((img: any, idx: number) => {
          insertImg.run(uuidv4(), id, img.path || img, idx);
        });
      }
      logActivity('CREATE', 'product', id, { name, title, sku });
    })();

    res.json({ id });
  });

  app.post("/api/products/bulk-pricing", (req, res) => {
    try {
      const { updates, settings } = req.body;
      const { exchangeRate, bufferPercentage, profitPercentage } = settings;
      let updatedCount = 0;
      let skippedLockedCount = 0;
      let skippedMissingCount = 0;

      db.transaction(() => {
        const currentProductStmt = db.prepare(`
          SELECT id, purchase_price_usd, purchase_cost, sale_price, buffer_percentage,
                 profit_percentage, exchange_rate_used, price_locked
          FROM products
          WHERE id = ?
        `);
        const historyStmt = db.prepare(`
          INSERT INTO pricing_history (
            id, product_id, purchase_price_usd, purchase_cost, sale_price,
            buffer_percentage, profit_percentage, exchange_rate_used, price_locked,
            changed_by, change_reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const stmt = db.prepare(`
          UPDATE products 
          SET sale_price = ?, 
              exchange_rate_used = ?, 
              buffer_percentage = ?, 
              profit_percentage = ?, 
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND COALESCE(price_locked, 0) = 0
        `);
        
        const platformStmt = db.prepare(`
          UPDATE product_platforms 
          SET price = ? 
          WHERE product_id = ?
        `);

        for (const update of updates) {
          const currentProduct = currentProductStmt.get(update.id) as any;
          if (!currentProduct) {
            skippedMissingCount += 1;
            continue;
          }
          if (currentProduct.price_locked === 1) {
            skippedLockedCount += 1;
            continue;
          }

          historyStmt.run(
            uuidv4(),
            currentProduct.id,
            currentProduct.purchase_price_usd,
            currentProduct.purchase_cost,
            currentProduct.sale_price,
            currentProduct.buffer_percentage,
            currentProduct.profit_percentage,
            currentProduct.exchange_rate_used,
            currentProduct.price_locked,
            req.user?.id ?? null,
            'bulk-pricing'
          );

          const result = stmt.run(update.newSalePrice, exchangeRate, bufferPercentage, profitPercentage, update.id);
          if (result.changes > 0) {
            updatedCount += result.changes;
            platformStmt.run(update.newSalePrice, update.id);
          }
        }
      })();

      res.json({ success: true, updatedCount, skippedLockedCount, skippedMissingCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/products/:id", (req, res) => {
    const { 
      name, title, warehouse_location, sku, barcode, category, model, description, 
      purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked,
      weight, status, notes, platforms, images, material, size, pipe_size, connection_type, usage_area, supplier, min_stock_level 
    } = req.body;
    
    const { normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size } = generateNormalizedFields({ material, model, size, pipe_size, category, name });

    db.transaction(() => {
      const beforeState: any = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
      if (beforeState) {
        beforeState.platforms = db.prepare("SELECT platform_name, stock, price, is_listed FROM product_platforms WHERE product_id = ?").all(req.params.id);
        beforeState.images = db.prepare("SELECT id, path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC").all(req.params.id);
      }
      const previousCentralStock = stockQuantity(beforeState?.central_stock);
      const nextCentralStock = hasCentralStockPayload(req.body)
        ? resolveCentralStock(req.body, previousCentralStock)
        : previousCentralStock;

      db.prepare(`
        UPDATE products SET 
          name=?, title=?, warehouse_location=?, sku=?, barcode=?, category=?, model=?, description=?, 
          purchase_price_usd=?, purchase_cost=?, sale_price=?, buffer_percentage=?, profit_percentage=?, exchange_rate_used=?, price_locked=?,
          weight=?, status=?, notes=?, material=?, size=?, pipe_size=?, connection_type=?, usage_area=?, supplier=?, min_stock_level=?, central_stock=?,
          normalized_material=?, normalized_model=?, normalized_size=?, normalized_tube_type=?, normalized_pipe_size=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        name, title, warehouse_location, sku, barcode, category, model, description, 
        purchase_price_usd || 0, purchase_cost || 0, sale_price || 0, buffer_percentage || 0, profit_percentage || 0, exchange_rate_used || 0, price_locked ? 1 : 0,
        weight || 0, status, notes, material, size, pipe_size, connection_type, usage_area, supplier, min_stock_level !== undefined ? min_stock_level : 50, nextCentralStock,
        normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size, req.params.id
      );

      const getPlatform = db.prepare("SELECT * FROM product_platforms WHERE product_id = ? AND platform_name = ? LIMIT 1");
      const updatePlatform = db.prepare(`
        UPDATE product_platforms
        SET
          price = CASE WHEN ? THEN ? ELSE price END,
          is_listed = CASE WHEN ? THEN ? ELSE is_listed END
        WHERE product_id = ? AND platform_name = ?
      `);
      const insertPlatform = db.prepare(`
        INSERT INTO product_platforms (id, product_id, platform_name, stock, price, is_listed)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      if (Array.isArray(platforms)) {
        for (const p of mergeProductPlatforms(platforms, sale_price)) {
          const platformName = p.name ?? p.platform_name;
          if (!platformName) continue;

          const priceProvided = p.priceProvided === true;
          const listedProvided = p.listedProvided === true;
          const priceValue = priceProvided ? Number(p.price) || 0 : (Number(sale_price) || 0);
          const listedValue = p.is_listed ? 1 : 0;
          const existingPlatform = getPlatform.get(req.params.id, platformName) as any;

          if (existingPlatform) {
            updatePlatform.run(
              priceProvided ? 1 : 0,
              priceValue,
              listedProvided ? 1 : 0,
              listedValue,
              req.params.id,
              platformName
            );
          } else {
            insertPlatform.run(uuidv4(), req.params.id, platformName, 0, priceValue, listedValue);
          }
        }
      }

      const centralStockDiff = nextCentralStock - previousCentralStock;
      if (centralStockDiff !== 0) {
        db.prepare(`
          INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), req.params.id, 'Merkez Depo', centralStockDiff, 'Oto: Ürün Güncelleme', 'ADJUST');
      }

      if (images && Array.isArray(images)) {
        const insertImg = db.prepare("INSERT INTO product_images (id, product_id, path, sort_order) VALUES (?, ?, ?, ?)");
        images.forEach((img: any, idx: number) => {
          if (img.id && img.id.startsWith('temp-')) {
             insertImg.run(uuidv4(), req.params.id, img.path, idx + 100);
          }
        });
      }
      
      const afterState: any = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
      if (afterState) {
        afterState.platforms = db.prepare("SELECT platform_name, stock, price, is_listed FROM product_platforms WHERE product_id = ?").all(req.params.id);
        afterState.images = db.prepare("SELECT id, path, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC").all(req.params.id);
        if (req.body.imageChanged) {
          afterState.imageChanged = true;
        }
      }
      logActivity('UPDATE', 'product', req.params.id, { before: beforeState, after: afterState });
    })();

    res.json({ success: true });
  });

  app.delete("/api/products", requireAdmin, (req, res) => {
    logActivity('DELETE_ALL_BLOCKED', 'product', 'all', { ip: req.ip }, req.user?.id);
    res.status(410).json({
      success: false,
      error: {
        code: 'ENDPOINT_DISABLED',
        message: 'Toplu ürün silme endpointi veri güvenliği nedeniyle devre dışı bırakıldı.',
      },
    });
  });

  app.delete("/api/products/:id", (req, res) => {
    const beforeState = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
    logActivity('DELETE', 'product', req.params.id, { before: beforeState });
    res.json({ success: true });
  });

  // Images Upload
  app.post("/api/products/:id/images", upload.array("images"), (req: any, res) => {
    const files = req.files as any[];
    const productId = req.params.id;

    db.transaction(() => {
      const stmt = db.prepare("INSERT INTO product_images (id, product_id, path, sort_order) VALUES (?, ?, ?, ?)");
      const lastOrder = db.prepare("SELECT MAX(sort_order) as max FROM product_images WHERE product_id = ?").get(productId) as any;
      let order = (lastOrder?.max || 0) + 1;

      for (const file of files) {
        stmt.run(uuidv4(), productId, `/uploads/${file.filename}`, order++);
      }
    })();

    res.json({ success: true });
  });

  app.delete("/api/images/:id", (req, res) => {
    const image = db.prepare("SELECT path FROM product_images WHERE id = ?").get(req.params.id) as any;
    if (image) {
      const fullPath = path.join(process.cwd(), image.path);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      db.prepare("DELETE FROM product_images WHERE id = ?").run(req.params.id);
    }
    res.json({ success: true });
  });

  // Stock Movement
  app.post("/api/stock/adjust", (req, res) => {
    const { product_id, platform_name, change_amount, reason } = req.body;

    try {
      const delta = Math.trunc(Number(change_amount));
      if (!Number.isFinite(delta) || delta === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_STOCK_CHANGE', message: 'Stok değişimi 0 olamaz.' } });
      }

      db.transaction(() => {
        const beforeState = db.prepare("SELECT id, central_stock FROM products WHERE id = ?").get(product_id) as any;
        if (!beforeState) throw new Error("Ürün bulunamadı.");

        const beforeStock = stockQuantity(beforeState.central_stock);
        const nextStock = beforeStock + delta;
        if (nextStock < 0) throw new Error(`Yetersiz merkez depo stoğu. Mevcut stok: ${beforeStock} adet.`);

        db.prepare("UPDATE products SET central_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(nextStock, product_id);

        db.prepare(`
          INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), product_id, centralStockChannel(platform_name), delta, reason || 'Manuel merkez depo stok ayarı', 'ADJUST');

        logActivity('UPDATE_STOCK', 'product', product_id, {
          channel: centralStockChannel(platform_name),
          change_amount: delta,
          reason,
          before: { central_stock: beforeStock },
          after: { central_stock: nextStock },
        });
      })();

      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: { code: 'STOCK_ADJUST_FAILED', message: err.message } });
    }
  });

  app.get("/api/stock/movements/:productId", (req, res) => {
    const logs = db.prepare("SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC").all(req.params.productId);
    res.json(logs);
  });

  // Expenses API
  app.get("/api/expenses", (req, res) => {
    const expenses = db.prepare(`
      SELECT t.*, 
             (SELECT COUNT(*) FROM expense_attachments WHERE expense_id = t.id) as attachment_count
      FROM transactions t 
      WHERE t.type = 'Expense' AND (t.is_deleted = 0 OR t.is_deleted IS NULL)
      ORDER BY t.date DESC
    `).all();
    res.json(expenses);
  });

  app.get("/api/expenses/:id", (req, res) => {
    const expense = db.prepare(`
      SELECT t.*
      FROM transactions t 
      WHERE t.id = ? AND t.type = 'Expense' AND COALESCE(t.is_deleted, 0) = 0
    `).get(req.params.id);

    if (!expense) return res.status(404).json({ error: "Expense not found" });

    const attachments = db.prepare("SELECT * FROM expense_attachments WHERE expense_id = ? ORDER BY uploaded_at DESC").all(req.params.id);
    
    res.json({ ...expense, attachments });
  });

  app.post("/api/expenses", (req, res) => {
    const { 
      date, category, platform, amount, note, reference_number, title, description, payment_method, supplier, invoice_number, 
      cash_account_id, currency, exchange_rate, amount_try, payer_person_id, will_be_refunded, refund_status, is_invoice, 
      invoice_name, is_stock_related, distribute_to_product_cost 
    } = req.body;
    const txId = uuidv4();
    
    try {
      db.transaction(() => {
        const activeRate = exchange_rate || getActiveExchangeRate();
        if (!activeRate || activeRate <= 0) throw new Error("Döviz kuru geçerli değil.");
        
        const actualAccountId = payer_person_id || cash_account_id;
        if (!actualAccountId) throw new Error("Gider eklerken ödeme hesabı veya ödeyen kişi seçimi zorunludur.");
        const account = db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(actualAccountId) as any;
        if (!account) throw new Error("Geçersiz hesap.");
        if (account.is_active === 0) throw new Error("Seçili hesap pasif.");
        if (amount <= 0) throw new Error("Tutar 0'dan büyük olmalıdır.");

        insertExpenseCashTransaction({
          id: txId,
          date: date || new Date().toISOString(),
          category,
          title,
          note,
          description,
          reference_number,
          amount,
          currency: currency || 'TRY',
          exchange_rate_at_transaction: activeRate,
          payer_person_id,
          cash_account_id,
        });

        db.prepare(`
          INSERT INTO transactions (
            id, date, type, category, platform, amount, note, reference_number, title, description, payment_method, supplier, invoice_number, cash_account_id, exchange_rate_at_transaction,
            currency, amount_try, payer_person_id, will_be_refunded, refund_status, is_invoice, invoice_name, is_stock_related, distribute_to_product_cost
          )
          VALUES (?, ?, 'Expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          txId, date || new Date().toISOString(), category, platform, amount, note, reference_number, title, description, payment_method, supplier, invoice_number, cash_account_id, activeRate,
          currency || 'TRY', amount_try || (currency === 'USD' ? amount * activeRate : amount), payer_person_id, will_be_refunded || 0, refund_status, is_invoice || 0, invoice_name, is_stock_related || 0, distribute_to_product_cost || 0
        );
        
        logActivity('CREATE', 'expense', txId, { after: req.body });
      })();
      res.json({ id: txId, success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/expenses/:id", (req, res) => {
    const { 
      date, category, platform, amount, note, reference_number, title, description, payment_method, supplier, invoice_number,
      currency, exchange_rate, amount_try, payer_person_id, will_be_refunded, refund_status, is_invoice, invoice_name, 
      is_stock_related, distribute_to_product_cost, cash_account_id
    } = req.body;
    
    try {
      const result = db.transaction(() => {
        const beforeState = db.prepare(`
          SELECT *
          FROM transactions
          WHERE id = ?
            AND type = 'Expense'
            AND COALESCE(is_deleted, 0) = 0
        `).get(req.params.id) as any;

        if (!beforeState) {
          const err = new Error("Expense not found") as any;
          err.statusCode = 404;
          throw err;
        }

        const nextAmount = amount !== undefined ? Number(amount) : Number(beforeState.amount);
        if (!Number.isFinite(nextAmount) || nextAmount <= 0) throw new Error("Tutar 0'dan büyük olmalıdır.");

        const hasField = (name: string) => Object.prototype.hasOwnProperty.call(req.body, name);
        const nextCurrency = hasField('currency') ? (currency || 'TRY') : (beforeState.currency || 'TRY');
        const activeRate = Number(exchange_rate || beforeState.exchange_rate_at_transaction || getActiveExchangeRate());
        if (!Number.isFinite(activeRate) || activeRate <= 0) throw new Error("Döviz kuru geçerli değil.");

        const nextExpense = {
          ...beforeState,
          id: req.params.id,
          date: hasField('date') ? (date || new Date().toISOString()) : (beforeState.date || new Date().toISOString()),
          category: hasField('category') ? category : beforeState.category,
          platform: hasField('platform') ? platform : beforeState.platform,
          amount: nextAmount,
          note: hasField('note') ? note : beforeState.note,
          reference_number: hasField('reference_number') ? reference_number : beforeState.reference_number,
          title: hasField('title') ? title : beforeState.title,
          description: hasField('description') ? description : beforeState.description,
          payment_method: hasField('payment_method') ? payment_method : beforeState.payment_method,
          supplier: hasField('supplier') ? supplier : beforeState.supplier,
          invoice_number: hasField('invoice_number') ? invoice_number : beforeState.invoice_number,
          currency: nextCurrency,
          exchange_rate_at_transaction: activeRate,
          amount_try: amount_try !== undefined && amount_try !== null && amount_try !== ''
            ? Number(amount_try)
            : (nextCurrency === 'USD' ? nextAmount * activeRate : nextAmount),
          payer_person_id: hasField('payer_person_id') ? payer_person_id : beforeState.payer_person_id,
          will_be_refunded: hasField('will_be_refunded') ? (will_be_refunded || 0) : (beforeState.will_be_refunded ?? 0),
          refund_status: hasField('refund_status') ? refund_status : beforeState.refund_status,
          is_invoice: hasField('is_invoice') ? (is_invoice || 0) : (beforeState.is_invoice ?? 0),
          invoice_name: hasField('invoice_name') ? invoice_name : beforeState.invoice_name,
          is_stock_related: hasField('is_stock_related') ? (is_stock_related || 0) : (beforeState.is_stock_related ?? 0),
          distribute_to_product_cost: hasField('distribute_to_product_cost') ? (distribute_to_product_cost || 0) : (beforeState.distribute_to_product_cost ?? 0),
          cash_account_id: hasField('cash_account_id') ? cash_account_id : beforeState.cash_account_id,
        };

        if (!Number.isFinite(Number(nextExpense.amount_try))) throw new Error("TRY tutarı geçerli değil.");
        syncExpenseCashTransaction(nextExpense);

        db.prepare(`
          UPDATE transactions
          SET date = ?, category = ?, platform = ?, amount = ?, note = ?, reference_number = ?, title = ?, description = ?, payment_method = ?, supplier = ?, invoice_number = ?,
              currency = ?, amount_try = ?, payer_person_id = ?, will_be_refunded = ?, refund_status = ?, is_invoice = ?, invoice_name = ?, is_stock_related = ?, distribute_to_product_cost = ?, cash_account_id = ?, exchange_rate_at_transaction = ?
          WHERE id = ? AND type = 'Expense'
        `).run(
          nextExpense.date, nextExpense.category, nextExpense.platform, nextExpense.amount, nextExpense.note, nextExpense.reference_number, nextExpense.title, nextExpense.description, nextExpense.payment_method, nextExpense.supplier, nextExpense.invoice_number,
          nextExpense.currency, nextExpense.amount_try, nextExpense.payer_person_id, nextExpense.will_be_refunded, nextExpense.refund_status, nextExpense.is_invoice, nextExpense.invoice_name, nextExpense.is_stock_related, nextExpense.distribute_to_product_cost, nextExpense.cash_account_id, nextExpense.exchange_rate_at_transaction,
          req.params.id
        );

        logActivity('UPDATE', 'expense', req.params.id, { before: beforeState, after: nextExpense }, req.user?.id);
        return nextExpense;
      })();

      res.json({ success: true, expense: result });
    } catch (err: any) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  });

  app.delete("/api/expenses/:id", (req, res) => {
    try {
      db.transaction(() => {
        const beforeState = db.prepare(`
          SELECT *
          FROM transactions
          WHERE id = ?
            AND type = 'Expense'
            AND COALESCE(is_deleted, 0) = 0
        `).get(req.params.id) as any;

        if (!beforeState) {
          const err = new Error("Expense not found") as any;
          err.statusCode = 404;
          throw err;
        }

        db.prepare("UPDATE transactions SET is_deleted = 1 WHERE id = ?").run(req.params.id);
        db.prepare(`
          UPDATE cash_transactions
          SET is_deleted = 1
          WHERE source_type = 'expense'
            AND source_id = ?
            AND COALESCE(is_deleted, 0) = 0
        `).run(req.params.id);
        logActivity('DELETE', 'expense', req.params.id, { before: beforeState, after: { is_deleted: 1 } }, req.user?.id);
      })();

      res.json({ success: true });
    } catch (err: any) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  });

  app.post("/api/expenses/:id/attachments", expenseUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const attId = uuidv4();
    const filePath = `uploads/expenses/${req.file.filename}`;
    
    try {
      db.prepare(`
        INSERT INTO expense_attachments (id, expense_id, file_name, file_path, mime_type, file_size)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(attId, req.params.id, req.file.originalname, filePath, req.file.mimetype, req.file.size);
      
      const attachment = db.prepare("SELECT * FROM expense_attachments WHERE id = ?").get(attId);
      res.json({ success: true, attachment });
    } catch (err: any) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/expenses/:id/attachments/:attachmentId", (req, res) => {
    const attachment = db.prepare("SELECT * FROM expense_attachments WHERE id = ? AND expense_id = ?").get(req.params.attachmentId, req.params.id) as any;
    
    if (!attachment) return res.status(404).json({ error: "Attachment not found" });

    if (attachment.file_path && fs.existsSync(path.join(process.cwd(), attachment.file_path))) {
      try { fs.unlinkSync(path.join(process.cwd(), attachment.file_path)); } catch(e) {}
    }

    db.prepare("DELETE FROM expense_attachments WHERE id = ?").run(req.params.attachmentId);
    
    res.json({ success: true });
  });

  app.get("/api/finance-summary", (req, res) => {
    try {
      // 1. Toplam Sermaye Girişi
      const capitalRes = db.prepare("SELECT SUM(amount * (CASE WHEN currency='USD' THEN exchange_rate_at_transaction ELSE 1 END)) as total FROM cash_transactions WHERE source_type = 'capital_injection' AND COALESCE(is_deleted, 0) = 0").get() as any;
      const capitalInjection = capitalRes?.total || 0;

      // 2. Satış Geliri
      const salesRes = db.prepare(`
        SELECT SUM(si.quantity * si.unit_price) as total_sales
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
      `).get() as any;
      const salesRevenue = salesRes?.total_sales || 0;

      // 3. Toplam Gider (is_stock_related = 0)
      const expensesRes = db.prepare("SELECT SUM(amount_try) as total FROM transactions WHERE type='Expense' AND is_stock_related=0 AND (is_deleted=0 OR is_deleted IS NULL)").get() as any;
      const totalExpense = expensesRes?.total || 0;

      // 4. Stoka Bağlanan Sermaye
      // Active stock value based on central warehouse stock.
      const stockRes = db.prepare(`
        SELECT SUM(p.purchase_cost * COALESCE(p.central_stock, 0)) as total
        FROM products p
      `).get() as any;
      const capitalInStock = stockRes?.total || 0;

      // 5. Şirket Kredi Kartı Borcu
      // Sum of negative balances of 'credit_card' liability accounts.
      let ccDebt = 0;
      let personalDebt = 0;
      let existingCash = 0;

      const accountsRes = db.prepare(`
        SELECT ca.id, ca.type, ca.is_liability, ca.opening_balance,
               (SELECT SUM(CASE 
                  WHEN type='IN' THEN amount * (CASE WHEN currency='USD' THEN exchange_rate_at_transaction ELSE 1 END) 
                  ELSE -amount * (CASE WHEN currency='USD' THEN exchange_rate_at_transaction ELSE 1 END) 
               END) FROM cash_transactions WHERE account_id = ca.id AND COALESCE(is_deleted, 0) = 0) as net_flow
        FROM cash_accounts ca
        WHERE ca.is_active = 1
      `).all() as any[];

      for(const acc of accountsRes) {
         let bal = (acc.opening_balance || 0) + (acc.net_flow || 0); // Note: opening_balance might need to be converted to TRY, but assuming TRY for simplicity or use activeRate.
         if (acc.is_liability === 1 || acc.type === 'credit_card' || acc.type === 'personal_card' || acc.type === 'personal_current_account') {
            if (bal < 0) {
               if (acc.type === 'credit_card') ccDebt += Math.abs(bal);
               else personalDebt += Math.abs(bal);
            }
         } else {
            if (bal > 0) existingCash += bal;
         }
      }

      // 8. Net Kullanılabilir Nakit (Mevcut Kasa - Kısa Vadeli Borçlar)
      const netCash = existingCash - ccDebt - personalDebt;

      // 9. Tahmini Net Kar (Satış Geliri + Diğer Gelirler? - Toplam Gider - Ürün Maliyeti (satılan ürünlerin maliyeti))
      const cogsRes = db.prepare(`
        SELECT SUM(si.quantity * si.purchase_cost) as total_cogs
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
      `).get() as any;
      const totalCogs = cogsRes?.total_cogs || 0;

      const netProfit = salesRevenue - totalCogs - totalExpense;

      res.json({
        capitalInjection,
        salesRevenue,
        totalExpense,
        capitalInStock,
        ccDebt,
        personalDebt,
        existingCash,
        netCash,
        netProfit,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cash Management
  app.get("/api/cash-accounts", (req, res) => {
    try {
      const accounts = db.prepare("SELECT * FROM cash_accounts ORDER BY name ASC").all();
      res.json(accounts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/cash-accounts", (req, res) => {
    try {
      const id = uuidv4();
      const body = req.body;
      const name = body.name || 'Yeni Hesap';
      const currency = body.currency || 'TRY';
      const type = body.type || 'bank';
      const opening_balance = parseFloat(body.opening_balance || body.openingBalance || 0);
      const credit_limit = parseFloat(body.credit_limit || body.creditLimit || 0);
      const statement_day = parseInt(body.statement_day || body.statementDay || body.cutoff_day || 0);
      const due_day = parseInt(body.due_day || body.dueDay || body.payment_due_day || body.due_date || 0);
      const is_liability = parseInt(body.is_liability || body.isLiability || 0);
      
      const bank_name = body.bank_name || body.bankName || '';
      const card_last_four = body.card_last_four || body.cardLastFour || '';
      const current_debt = parseFloat(body.current_debt || body.currentDebt || 0);
      const available_limit = parseFloat(body.available_limit || body.availableLimit || Math.max(0, credit_limit - current_debt));

      db.prepare(`
        INSERT INTO cash_accounts (
          id, name, currency, type, opening_balance, credit_limit, cutoff_day, payment_due_day, is_liability,
          statement_day, due_day, bank_name, card_last_four, current_debt, available_limit
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, name, currency, type, opening_balance, credit_limit, statement_day, due_day, is_liability,
        statement_day, due_day, bank_name, card_last_four, current_debt, available_limit
      );
      res.json({ success: true, id });
    } catch (err: any) {
      if (err.message && err.message.includes('has no column')) {
        res.status(500).json({ error: "Hesap oluşturulamadı. Veritabanı güncellemesi gerekli. Lütfen sayfayı yenileyin." });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.put("/api/cash-accounts/:id", (req, res) => {
    try {
      const { is_active } = req.body;
      db.prepare("UPDATE cash_accounts SET is_active = ? WHERE id = ?").run(is_active ? 1 : 0, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/cash-transactions", (req, res) => {
    try {
      const txs = db.prepare(`
        SELECT ct.*, ca.name as account_name, ca.currency as account_currency
        FROM cash_transactions ct
        LEFT JOIN cash_accounts ca ON ct.account_id = ca.id
        WHERE COALESCE(ct.is_deleted, 0) = 0
        ORDER BY COALESCE(ct.transaction_date, ct.created_at) DESC, ct.created_at DESC
      `).all();
      res.json(txs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/cash-deposit", (req, res) => {
    try {
      const { account_id, amount, description, source_type } = req.body;
      const amountNum = parseFloat(amount);
      if (amountNum <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
      
      const account = db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(account_id) as any;
      if (!account) return res.status(404).json({ error: "Account not found" });

      const txId = uuidv4();
      const desc = description || `Deposit: ${source_type}`;
      
      db.prepare(`
        INSERT INTO cash_transactions (id, account_id, type, amount, currency, exchange_rate_at_transaction, source_type, description)
        VALUES (?, ?, 'IN', ?, ?, ?, ?, ?)
      `).run(txId, account_id, amountNum, account.currency, 1, source_type || 'deposit', desc);
      
      logActivity('CREATE', 'cash_deposit', txId, { after: { account_id, amount, source_type } });
      res.json({ success: true, id: txId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/cash-transfer", (req, res) => {
    try {
      const { from_account_id, to_account_id, amount, rate, description } = req.body;
      const amountNum = parseFloat(amount);
      if (amountNum <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
      if (from_account_id === to_account_id) return res.status(400).json({ error: "Source and target accounts must be different" });

      const fromAccount = db.prepare("SELECT * FROM cash_accounts WHERE id = ? AND is_active = 1").get(from_account_id) as any;
      const toAccount = db.prepare("SELECT * FROM cash_accounts WHERE id = ? AND is_active = 1").get(to_account_id) as any;
      if (!fromAccount || !toAccount) return res.status(400).json({ error: "Invalid or inactive accounts" });

      let sourceCurrency = fromAccount.currency;
      let targetCurrency = toAccount.currency;

      let sourceAmount = amountNum;
      let targetAmount = amountNum;

      if (sourceCurrency !== targetCurrency) {
         if (!rate || parseFloat(rate) <= 0) return res.status(400).json({ error: "Exchange rate required for cross-currency transfer" });
         if (sourceCurrency === 'USD' && targetCurrency === 'TRY') {
            targetAmount = amountNum * parseFloat(rate);
         } else if (sourceCurrency === 'TRY' && targetCurrency === 'USD') {
            targetAmount = amountNum / parseFloat(rate);
         }
      }

      db.transaction(() => {
        const activeRate = getActiveExchangeRate() || 1;
        const desc = description || `Transfer: ${fromAccount.name} -> ${toAccount.name}`;
        const sourceTxId = uuidv4();
        const targetTxId = uuidv4();

        // OUT from source
        db.prepare(`
          INSERT INTO cash_transactions (id, account_id, type, amount, currency, exchange_rate_at_transaction, source_type, source_id, description)
          VALUES (?, ?, 'OUT', ?, ?, ?, 'transfer', ?, ?)
        `).run(sourceTxId, from_account_id, sourceAmount, sourceCurrency, parseFloat(rate) || activeRate, targetTxId, desc);

        // IN to target
        db.prepare(`
          INSERT INTO cash_transactions (id, account_id, type, amount, currency, exchange_rate_at_transaction, source_type, source_id, description)
          VALUES (?, ?, 'IN', ?, ?, ?, 'transfer', ?, ?)
        `).run(targetTxId, to_account_id, targetAmount, targetCurrency, parseFloat(rate) || activeRate, sourceTxId, desc);
        
        logActivity('CREATE', 'cash_transfer', sourceTxId, { after: { from_account_id, to_account_id, amount, rate } });
      })();

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Transactions CRUD
  app.get("/api/transactions", (req, res) => {
    const transactions = db.prepare(`
      SELECT t.*, p.title as product_title 
      FROM transactions t 
      LEFT JOIN products p ON t.product_id = p.id 
      WHERE t.is_deleted = 0 OR t.is_deleted IS NULL
      ORDER BY t.date DESC
    `).all();
    res.json(transactions);
  });

  app.post("/api/transactions", (req, res) => {
    const { 
      date, type, category, platform, amount, product_id, note, reference_number, supplier, invoice_number, expense_type, cash_account_id,
      currency, exchange_rate, amount_try, payer_person_id, will_be_refunded, refund_status, is_invoice, invoice_name, 
      is_stock_related, distribute_to_product_cost, document_url
    } = req.body;
    
    const txId = uuidv4();
    try {
       db.transaction(() => {
          const activeRate = exchange_rate || getActiveExchangeRate();
          if (!activeRate || activeRate <= 0) throw new Error("Döviz kuru geçerli değil.");

          // Insert expense record
          db.prepare(`
            INSERT INTO transactions (
              id, date, type, category, platform, amount, product_id, note, reference_number, supplier, invoice_number, expense_type, cash_account_id, exchange_rate_at_transaction,
              currency, amount_try, payer_person_id, will_be_refunded, refund_status, is_invoice, invoice_name, is_stock_related, distribute_to_product_cost, document_url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            txId, date || new Date().toISOString(), type, category, platform, amount, product_id, note, reference_number, supplier, invoice_number, expense_type, cash_account_id, activeRate,
            currency || 'TRY', amount_try || (currency === 'USD' ? amount * activeRate : amount), payer_person_id, will_be_refunded || 0, refund_status, is_invoice || 0, invoice_name, is_stock_related || 0, distribute_to_product_cost || 0, document_url
          );

          if (type === 'Expense') {
            const actualPaymentAccountId = payer_person_id || cash_account_id;
            if (!actualPaymentAccountId) throw new Error("Gider eklerken ödeme hesabı veya ödeyen kişi seçimi zorunludur.");
            
            const account = db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(actualPaymentAccountId) as any;
            if (!account) throw new Error("Geçersiz hesap.");
            if (account.is_active === 0) throw new Error("Seçili hesap pasif.");
            if (amount <= 0) throw new Error("Tutar 0'dan büyük olmalıdır.");

            insertExpenseCashTransaction({
              id: txId,
              date: date || new Date().toISOString(),
              category,
              note,
              amount,
              currency: currency || 'TRY',
              exchange_rate_at_transaction: activeRate,
              payer_person_id,
              cash_account_id,
            });
          }
          
          logActivity('CREATE', 'transaction', txId, { 
            before: {}, 
            after: { date: date || new Date().toISOString(), type, category, platform, amount, product_id, note, reference_number, cash_account_id }
          });
       })();
       res.json({ success: true, id: txId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/transactions/:id", (req, res) => {
    try {
      db.transaction(() => {
        const beforeState = db.prepare("SELECT * FROM transactions WHERE id = ? AND COALESCE(is_deleted, 0) = 0").get(req.params.id) as any;
        if (!beforeState) {
          const err = new Error("Transaction not found") as any;
          err.statusCode = 404;
          throw err;
        }

        db.prepare("UPDATE transactions SET is_deleted = 1 WHERE id = ?").run(req.params.id);
        if (beforeState.type === 'Expense') {
          db.prepare(`
            UPDATE cash_transactions
            SET is_deleted = 1
            WHERE source_type = 'expense'
              AND source_id = ?
              AND COALESCE(is_deleted, 0) = 0
          `).run(req.params.id);
        }
        logActivity('DELETE', 'transaction', req.params.id, { before: beforeState, after: { is_deleted: 1 } }, req.user?.id);
      })();

      res.json({ success: true });
    } catch (err: any) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  });

  // New recurring-payments routes will be imported here
  app.use("/api/recurring-payments", createRecurringPaymentsRouter(db));


  // Exchange Rates
  app.get("/api/exchange-rate", (req, res) => {
    try {
        const row = db.prepare("SELECT * FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1").get() as any;
        res.json(row || { rate: 0 });
    } catch(e: any) {
        res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/exchange-rate/refresh", async (req, res) => {
    try {
        const success = await fetchExchangeRate();
        const row = db.prepare("SELECT * FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1").get() as any;
        res.json({ success, rate: row?.rate, source: row?.source, fetched_at: row?.fetched_at });
    } catch(e: any) {
        res.status(500).json({ error: e.message });
    }
  });

  // Settings
  app.get("/api/settings", (req, res) => {
    const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
    const settings: any = {};
    settingsRows.forEach(row => {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    });
    res.json(settings);
  });

  app.put("/api/settings", (req, res) => {
    const body = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    
    db.transaction(() => {
      const beforeState: any = {};
      const afterState: any = {};
      
      const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
      for (const [key, value] of Object.entries(body)) {
         const oldRow = getStmt.get(key) as any;
         beforeState[key] = oldRow ? oldRow.value : null;
         
         const newValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
         stmt.run(key, newValue);
         afterState[key] = newValue;
      }
      logActivity('UPDATE', 'settings', 'global', { before: beforeState, after: afterState });
    })();
    
    res.json({ success: true });
  });

  // B2B: Firms
  app.get("/api/b2b/firms", (req, res) => {
    try {
      const firms = db.prepare(`SELECT * FROM firms ORDER BY created_at DESC`).all();
      res.json(firms);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/b2b/firms/:id", (req, res) => {
    try {
      const firm = db.prepare("SELECT * FROM firms WHERE id = ?").get(req.params.id) as any;
      if (!firm) return res.status(404).json({ error: "Firm not found" });

      const note_list = db.prepare("SELECT * FROM firm_notes WHERE firm_id = ? ORDER BY created_at DESC").all(req.params.id);
      const offers = db.prepare("SELECT * FROM offers WHERE firm_id = ? ORDER BY created_at DESC").all(req.params.id);
      const follow_ups = db.prepare("SELECT * FROM follow_ups WHERE firm_id = ? ORDER BY created_at DESC").all(req.params.id);
      
      res.json({ ...firm, note_list, offers, follow_ups });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/b2b/firms", (req, res) => {
    try {
      const id = uuidv4();
      const { name, sector, city, website, phone, email, contact_person, source_url, related_product, status, notes } = req.body;
      
      db.prepare(`
        INSERT INTO firms (id, name, sector, city, website, phone, email, contact_person, source_url, related_product, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, sector, city, website, phone, email, contact_person, source_url, related_product, status || 'Yeni', notes);
      
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/b2b/firms/:id", (req, res) => {
    try {
      const { name, sector, city, website, phone, email, contact_person, source_url, related_product, status, notes, is_active } = req.body;
      db.prepare(`
        UPDATE firms SET 
          name=?, sector=?, city=?, website=?, phone=?, email=?, contact_person=?, source_url=?, related_product=?, status=?, notes=?, is_active=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(name, sector, city, website, phone, email, contact_person, source_url, related_product, status, notes, is_active === undefined ? 1 : is_active ? 1 : 0, req.params.id);
      
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/b2b/firms/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM firms WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // B2B: Notes
  app.post("/api/b2b/firms/:id/notes", (req, res) => {
    try {
      const id = uuidv4();
      const { note } = req.body;
      db.prepare("INSERT INTO firm_notes (id, firm_id, note) VALUES (?, ?, ?)").run(id, req.params.id, note);
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // B2B: Offers
  app.get("/api/b2b/offers", (req, res) => {
    try {
      const offers = db.prepare(`
        SELECT o.*, f.name as firm_name 
        FROM offers o 
        LEFT JOIN firms f ON o.firm_id = f.id 
        ORDER BY o.created_at DESC
      `).all();
      res.json(offers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/b2b/offers", (req, res) => {
    try {
      const id = uuidv4();
      const { firm_id, title, description, amount, currency, status, offer_date, valid_until } = req.body;
      db.prepare(`
        INSERT INTO offers (id, firm_id, title, description, amount, currency, status, offer_date, valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, firm_id, title, description, amount, currency || '₺', status || 'Taslak', offer_date, valid_until);
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/b2b/offers/:id/status", (req, res) => {
    try {
      db.prepare("UPDATE offers SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/b2b/offers/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM offers WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // B2B: Follow-ups
  app.get("/api/b2b/follow-ups", (req, res) => {
    try {
      const follow_ups = db.prepare(`
        SELECT fu.*, f.name as firm_name 
        FROM follow_ups fu 
        LEFT JOIN firms f ON fu.firm_id = f.id 
        ORDER BY fu.next_follow_up_date ASC, fu.created_at DESC
      `).all();
      res.json(follow_ups);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/b2b/follow-ups", (req, res) => {
    try {
      const id = uuidv4();
      const { firm_id, type, note, next_follow_up_date } = req.body;
      db.prepare(`
        INSERT INTO follow_ups (id, firm_id, type, note, next_follow_up_date)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, firm_id, type, note, next_follow_up_date);
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- SALES ---
  const FINAL_SALE_STATUSES = ['İptal Edildi', 'İade Edildi'];
  const isFinalSaleStatus = (status?: string) => FINAL_SALE_STATUSES.includes(status || '');

  const restoreSaleStock = (sale: any, finalStatus: string) => {
    const originalMovementReason = `Satış No: ${sale.id}`;
    const restoredByProduct = new Map<string, number>();

    const originalMovements = db.prepare(`
      SELECT product_id, platform_name, SUM(ABS(change_amount)) as quantity
      FROM stock_movements
      WHERE reason = ? AND type = 'OUT' AND change_amount < 0
      GROUP BY product_id, platform_name
    `).all(originalMovementReason) as any[];

    const restoreToCentralStock = (productId: string, saleChannel: string | null | undefined, quantity: number) => {
      if (!productId || quantity <= 0) return;

      db.prepare("UPDATE products SET central_stock = COALESCE(central_stock, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(quantity, productId);
      db.prepare(`
        INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), productId, centralStockChannel(saleChannel), quantity, `${finalStatus} — Satış No: ${sale.id}`, 'IN');

      restoredByProduct.set(productId, (restoredByProduct.get(productId) || 0) + quantity);
    };

    for (const movement of originalMovements) {
      restoreToCentralStock(movement.product_id, movement.platform_name, Number(movement.quantity) || 0);
    }

    const saleItems = db.prepare("SELECT product_id, SUM(quantity) as quantity FROM sale_items WHERE sale_id = ? GROUP BY product_id").all(sale.id) as any[];
    for (const item of saleItems) {
      if (!item.product_id) continue;
      const soldQty = Number(item.quantity) || 0;
      const restoredQty = restoredByProduct.get(item.product_id) || 0;
      const remainingQty = soldQty - restoredQty;
      if (remainingQty > 0) {
        restoreToCentralStock(item.product_id, sale.platform, remainingQty);
      }
    }
  };

  const reverseSaleLedger = (sale: any, finalStatus: string) => {
    restoreSaleStock(sale, finalStatus);

    if (sale.income_transaction_id) {
      db.prepare(`
        UPDATE transactions
        SET is_deleted = 1,
            note = COALESCE(note, '') || ' [İptal/İade]'
        WHERE id = ? AND COALESCE(is_deleted, 0) = 0
      `).run(sale.income_transaction_id);
    }

    const existingReversal = db.prepare(`
      SELECT id FROM cash_transactions
      WHERE source_id = ? AND source_type IN ('sale_refund', 'sale_reversal')
        AND COALESCE(is_deleted, 0) = 0
      LIMIT 1
    `).get(sale.id) as any;
    if (existingReversal) return;

    const originalCash = db.prepare(`
      SELECT * FROM cash_transactions
      WHERE source_type = 'sale' AND source_id = ? AND type = 'IN'
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY created_at ASC
      LIMIT 1
    `).get(sale.id) as any;

    const accountId = originalCash?.account_id || sale.cash_account_id;
    if (!accountId) return;

    db.prepare(`
      INSERT INTO cash_transactions (
        id, account_id, type, amount, currency, exchange_rate_at_transaction,
        source_type, source_id, description
      )
      VALUES (?, ?, 'OUT', ?, ?, ?, 'sale_reversal', ?, ?)
    `).run(
      uuidv4(),
      accountId,
      originalCash?.amount ?? (sale.net_total ?? sale.total_amount),
      originalCash?.currency || 'TRY',
      originalCash?.exchange_rate_at_transaction || 1,
      sale.id,
      `${finalStatus}: Satış No ${sale.id}`
    );
  };

  const updateSaleRecord = (saleId: string, changes: any, userId?: string) => {
    let updatedSale: any = null;

    db.transaction(() => {
      const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId) as any;
      if (!sale) {
        const err = new Error("Satış bulunamadı.") as any;
        err.statusCode = 404;
        throw err;
      }

      const targetStatus = changes.status || sale.status;
      const wasFinal = isFinalSaleStatus(sale.status);
      const willBeFinal = isFinalSaleStatus(targetStatus);

      if (wasFinal && targetStatus !== sale.status) {
        throw new Error(`Durumu '${sale.status}' olan satış farklı bir duruma alınamaz.`);
      }
      if (!willBeFinal && wasFinal) {
        throw new Error("İptal/iade edilmiş bir satış geri alınamaz.");
      }

      const isBecomingFinal = willBeFinal && !wasFinal;
      if (isBecomingFinal) {
        reverseSaleLedger(sale, targetStatus);
        logActivity(targetStatus === 'İptal Edildi' ? 'SALE_CANCELLED' : 'SALE_RETURNED', 'sale', saleId,
          { reason: changes.return_reason, previous_status: sale.status }, userId);
      } else {
        logActivity('SALE_UPDATED', 'sale', saleId, { previous_status: sale.status, status: targetStatus }, userId);
      }

      db.prepare(`
        UPDATE sales SET
          customer_name=?,
          customer_phone=?,
          customer_address=?,
          shipping_company=?,
          tracking_number=?,
          status=?,
          return_reason=?,
          returned_at=CASE WHEN ? THEN COALESCE(returned_at, CURRENT_TIMESTAMP) ELSE returned_at END,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        changes.customer_name ?? sale.customer_name,
        changes.customer_phone ?? sale.customer_phone,
        changes.customer_address ?? sale.customer_address,
        changes.shipping_company ?? sale.shipping_company,
        changes.tracking_number ?? sale.tracking_number,
        targetStatus,
        changes.return_reason ?? sale.return_reason,
        willBeFinal ? 1 : 0,
        saleId,
      );

      updatedSale = db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId);
    })();

    return updatedSale;
  };

  app.patch("/api/sales/:id/status", (req, res) => {
    try {
      const { status } = req.body;
      if (!status) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Durum zorunludur.' } });
      }

      const updatedSale = updateSaleRecord(req.params.id, {
        status,
        return_reason: req.body.return_reason,
      }, req.user?.id);

      res.json({ success: true, message: "Durum güncellendi", sale: updatedSale });
    } catch (err: any) {
      res.status(err.statusCode || 400).json({ success: false, error: { code: 'UPDATE_FAILED', message: err.message } });
    }
  });

  app.get("/api/sales", (req, res) => {
    try {
      const sales = db.prepare("SELECT * FROM sales ORDER BY created_at DESC").all();
      sales.forEach((s: any) => {
        s.items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(s.id);
      });
      res.json(sales);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/sales/:id", (req, res) => {
    try {
      const updatedSale = updateSaleRecord(req.params.id, req.body, req.user?.id);
      res.json({ success: true, message: "Satış güncellendi.", sale: updatedSale });
    } catch (err: any) {
      AppLogger.error('SALE_UPDATE_ERROR', 'Sale update failed', err);
      res.status(err.statusCode || 400).json({ success: false, error: { code: 'UPDATE_FAILED', message: err.message } });
    }
  });

  const saleSchema = z.object({
    customer_name: z.string().min(1, 'Müşteri adı boş olamaz').optional(),
    commission_rate: z.coerce.number().min(0, 'Komisyon negatif olamaz').max(100, 'Komisyon maksimum %100 olabilir').optional().default(0),
    discount: z.coerce.number().min(0, 'İndirim negatif olamaz').optional().default(0),
    total_amount: z.coerce.number().min(0, 'Genel toplam negatif olamaz'),
    items: z.array(z.object({
      quantity: z.coerce.number().min(1, 'Satış miktarı 0 dan büyük olmalıdır'),
      price: z.coerce.number().min(0, 'Birim fiyat negatif olamaz'),
    }).passthrough())
  });

  app.post("/api/sales", (req, res) => {
    try {
      const validated = saleSchema.parse(req.body);
      const id = uuidv4();
      const { 
        customer_name, customer_phone, customer_address, 
        shipping_company, tracking_number, total_weight, total_quantity, total_amount, 
        items, platform, commission_rate, shipping_cost, discount, cash_account_id,
        packaging_cost, ad_spend, other_expenses
      } = req.body;
      
      db.transaction(() => {
        // Sepette aynı ürün birden fazla satırda varsa, stok hatasını engellemek için adetleri birleştir:
        const mergedItemsMap = new Map();
        for (const item of items) {
          if (mergedItemsMap.has(item.product_id)) {
             const existing = mergedItemsMap.get(item.product_id);
             existing.quantity += Number(item.quantity);
          } else {
             mergedItemsMap.set(item.product_id, { ...item, quantity: Number(item.quantity) });
          }
        }
        const mergedItems = Array.from(mergedItemsMap.values());

        let totalPurchaseCost = 0;
        const processedItems = mergedItems.map((item: any) => {
          const product = db.prepare("SELECT purchase_cost, central_stock FROM products WHERE id = ?").get(item.product_id) as any;
          if (!product) throw new Error(`Ürün bulunamadı: ${item.product_name || item.product_id}`);
          const pc = product?.purchase_cost || 0;
          totalPurchaseCost += (pc * item.quantity);
          return { ...item, purchase_cost: pc, price: item.price || 0, available_stock: stockQuantity(product.central_stock) };
        });

        // 1. Central warehouse stock validation for all items
        for (const item of processedItems) {
          if (item.available_stock < item.quantity) {
            throw new Error(`Yetersiz merkez depo stoğu. ${item.product_name} için mevcut stok: ${item.available_stock} adet.`);
          }
        }

        const commRate = parseFloat(commission_rate) || 0;
        const discountAmt = parseFloat(discount) || 0;
        const shipCost = parseFloat(shipping_cost) || 0;
        const packCost = parseFloat(packaging_cost) || 0;
        const adCost = parseFloat(ad_spend) || 0;
        const otherCost = parseFloat(other_expenses) || 0;
        
        let netTotal = total_amount - discountAmt;
        let grossProfit = netTotal - totalPurchaseCost;
        let netProfit = grossProfit - shipCost - packCost - adCost - otherCost - (total_amount * commRate / 100);

        // Cash Logic
        let finalCashAccountId = cash_account_id;
        const plat = platform || 'Satış Sistemi';
        const isPlatform = ['Trendyol', 'Hepsiburada', 'Amazon', 'N11'].includes(plat);

        if (isPlatform) {
           const platAccountName = `${plat} Bekleyen`;
           const foundAcc = db.prepare("SELECT id FROM cash_accounts WHERE name LIKE ?").get(`%${platAccountName}%`) as any;
           if (foundAcc) {
              finalCashAccountId = foundAcc.id;
           } else {
              // fallback
              const pAccId = uuidv4();
              db.prepare("INSERT INTO cash_accounts (id, name, currency, type) VALUES (?, ?, ?, ?)").run(pAccId, platAccountName, 'TRY', 'platform');
              finalCashAccountId = pAccId;
           }
        }

        if (!finalCashAccountId) {
           throw new Error("Satış için kasa hesabı belirlenemedi. (Nakit/Elden satışlar için kasa seçimi zorunludur.)");
        }

        const account = db.prepare("SELECT currency FROM cash_accounts WHERE id = ?").get(finalCashAccountId) as any;
        if (!account) throw new Error("Seçili kasa hesabı bulunamadı.");

        let finalAmountToCash = netTotal;
        if (isPlatform) {
           finalAmountToCash = netTotal - shipCost - packCost - adCost - otherCost - (total_amount * commRate / 100);
        }

        db.prepare(`
           INSERT INTO cash_transactions (id, account_id, type, amount, currency, exchange_rate_at_transaction, source_type, source_id, description)
           VALUES (?, ?, 'IN', ?, ?, 1, 'sale', ?, ?)
        `).run(uuidv4(), finalCashAccountId, finalAmountToCash, account.currency, id, `Satış: ${customer_name} (${plat})`);


        const activeRate = getActiveExchangeRate();
        if (!activeRate || activeRate <= 0) throw new Error("Güncel döviz kuru bulunamadı. Lütfen ayarlardan kuru yenileyin.");

        // 2. Create Sale
        db.prepare(`
          INSERT INTO sales (id, customer_name, customer_phone, customer_address, shipping_company, tracking_number, total_weight, total_quantity, total_amount, platform, commission_rate, shipping_cost, discount, packaging_cost, ad_spend, other_expenses, net_total, gross_profit, net_profit, cash_account_id, exchange_rate_at_transaction)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, customer_name, customer_phone, customer_address, shipping_company, tracking_number, total_weight, total_quantity, total_amount, plat, commRate, shipCost, discountAmt, packCost, adCost, otherCost, netTotal, grossProfit, netProfit, finalCashAccountId, activeRate);

        const insertItem = db.prepare(`
          INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight, unit_price, purchase_cost, net_profit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // 3. Process items: Sale Items, central stock deduction, Stock Movements
        for (const item of processedItems) {
          const lineRevenue = item.price * item.quantity;
          const lineCost = item.purchase_cost * item.quantity;
          const lineCommission = lineRevenue * commRate / 100;
          const itemNetProfit = lineRevenue - lineCost - lineCommission;

          insertItem.run(uuidv4(), id, item.product_id, item.product_name, item.quantity, item.weight, item.price, item.purchase_cost, itemNetProfit);

          const stockUpdate = db.prepare(`
            UPDATE products
            SET central_stock = COALESCE(central_stock, 0) - ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND COALESCE(central_stock, 0) >= ?
          `).run(item.quantity, item.product_id, item.quantity);

          if (stockUpdate.changes === 0) {
            const currentStock = db.prepare("SELECT COALESCE(central_stock, 0) as central_stock FROM products WHERE id = ?").get(item.product_id) as any;
            throw new Error(`Yetersiz merkez depo stoğu. ${item.product_name} için mevcut stok: ${currentStock?.central_stock || 0} adet.`);
          }

          db.prepare("INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type) VALUES (?, ?, ?, ?, ?, ?)")
            .run(uuidv4(), item.product_id, centralStockChannel(plat), -item.quantity, `Satış No: ${id}`, 'OUT');
        }

        // 4. Auto-create income transaction so the financial ledger is always consistent.
        const incTxnId = uuidv4();
        db.prepare(`
          INSERT INTO transactions (id, date, type, category, platform, amount, amount_try, currency,
            exchange_rate_at_transaction, note, reference_number, cash_account_id, created_at)
          VALUES (?, CURRENT_TIMESTAMP, 'Income', 'Satış', ?, ?, ?, 'TRY', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          incTxnId, plat, netTotal, netTotal, activeRate,
          `${customer_name || 'Müşteri'} — ${plat} satışı`,
          id, finalCashAccountId
        );

        // Update the sale with the linked income transaction id
        db.prepare("UPDATE sales SET income_transaction_id = ? WHERE id = ?").run(incTxnId, id);

        logActivity('SALE_CREATED', 'sale', id, {
          customer: customer_name, platform: plat, total: total_amount, net_profit: netProfit,
        }, req.user?.id);

      })();

      res.json({ success: true, message: "Satış başarıyla kaydedildi.", id });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
         return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.issues } });
      }
      AppLogger.error('SALE_ERROR', 'Sale transaction failed', err);
      res.status(400).json({ success: false, error: { code: 'SALE_FAILED', message: err.message } });
    }
  });

  // --- API INTEGRATIONS (KEYS) ---
  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per windowMs
    message: { error: "Çok fazla istek gönderildi, lütfen biraz bekleyin." }
  });

  app.get("/api/integrations/keys", apiLimiter, (req, res) => {
    try {
      const keys = db.prepare("SELECT id, service_name, display_name, key_name, status, last4, notes, last_used_at, created_at, updated_at FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as any[];
      
      const safeKeys = keys.map(k => {
        const testStatusRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_test_status_${k.id}`) as any;
        const testedAtRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_tested_at_${k.id}`) as any;
        return {
          ...k,
          last_test_status: testStatusRow ? testStatusRow.value : null,
          last_tested_at: testedAtRow ? testedAtRow.value : null,
          maskedKey: `********${k.last4 || '----'}`,
        };
      });

      res.json(safeKeys);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/keys", apiLimiter, (req, res) => {
    try {
      const { service_name, display_name, key_name, api_key, api_secret, merchant_id, seller_id, notes } = req.body;
      
      if (!service_name || !display_name || !api_key) {
        return res.status(400).json({ error: "Servis adı, görünen alan ve API anahtarı zorunludur." });
      }

      // Check duplicate
      const existing = db.prepare("SELECT id FROM api_keys WHERE service_name = ? AND display_name = ? AND deleted_at IS NULL").get(service_name, display_name);
      if (existing) {
        return res.status(400).json({ error: "Bu servis ve görünen ada sahip bir anahtar zaten var." });
      }

      const id = uuidv4();
      const apiKeyEncrypted = encryptText(api_key);
      const apiSecretEncrypted = api_secret ? encryptText(api_secret) : null;
      const last4 = api_key.length >= 4 ? api_key.slice(-4) : api_key;

      db.prepare(`
        INSERT INTO api_keys (id, service_name, display_name, key_name, api_key_encrypted, api_secret_encrypted, merchant_id, seller_id, last4, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, service_name, display_name, key_name || null, apiKeyEncrypted, apiSecretEncrypted, merchant_id || null, seller_id || null, last4, notes || null);
      
      logActivity("API_KEY_CREATED", "integration", id, { 
         before: null, 
         after: { service_name, display_name, status: 'active' },
         userIp: req.ip
      });

      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/integrations/keys/:id", apiLimiter, (req, res) => {
    try {
      const { display_name, key_name, api_key, api_secret, merchant_id, seller_id, notes } = req.body;
      const id = req.params.id;

      if (!display_name) {
        return res.status(400).json({ error: "Görünen alan zorunludur." });
      }

      const current = db.prepare("SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) {
        return res.status(404).json({ error: "API anahtarı bulunamadı." });
      }

      let apiKeyEncrypted = current.api_key_encrypted;
      let last4 = current.last4;
      if (api_key) {
        apiKeyEncrypted = encryptText(api_key);
        last4 = api_key.length >= 4 ? api_key.slice(-4) : api_key;
      }

      let apiSecretEncrypted = current.api_secret_encrypted;
      if (api_secret) {
        apiSecretEncrypted = encryptText(api_secret);
      } else if (api_secret === '') {
        apiSecretEncrypted = null;
      }

      db.prepare(`
        UPDATE api_keys 
        SET display_name = ?, key_name = ?, api_key_encrypted = ?, api_secret_encrypted = ?, merchant_id = ?, seller_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(display_name, key_name || null, apiKeyEncrypted, apiSecretEncrypted, merchant_id || null, seller_id || null, notes || null, id);

      logActivity("API_KEY_UPDATED", "integration", id, { 
         before: { display_name: current.display_name, service_name: current.service_name }, 
         after: { display_name, update: "Keys / metadata updated" },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/integrations/keys/:id/status", apiLimiter, (req, res) => {
    try {
      const { status } = req.body;
      db.prepare("UPDATE api_keys SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(status, req.params.id);
      
      logActivity("API_KEY_STATUS", "integration", req.params.id, { 
         before: {}, 
         after: { status },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/keys/:id/test", apiLimiter, async (req, res) => {
    try {
      const id = req.params.id;
      const current = db.prepare("SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) {
        return res.status(404).json({ error: "API anahtarı bulunamadı." });
      }

      if (current.status !== 'active') {
         return res.json({ status: "failed", message: "Pasif anahtarlar test edilemez." });
      }

      let status = "success";
      let message = "";

      if (current.service_name === 'Hepsiburada') {
        const merchantId = current.merchant_id;
        if (!merchantId) {
           return res.json({ status: "failed", message: "Merchant ID gerekli" });
        }
        
        const apiKey = decryptText(current.api_key_encrypted);
        const apiSecret = current.api_secret_encrypted ? decryptText(current.api_secret_encrypted) : "";
        
        // Hepsiburada genellikle Basic Auth kullanır. apiKey Username, apiSecret Password ise:
        let authToken = apiKey;
        if (apiSecret) {
           authToken = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
        }
        
        try {
           const response = await fetch(`https://oms-api.hepsiburada.com/merchants/${merchantId}/orders?limit=1`, {
              method: 'GET',
              headers: {
                 'Authorization': apiKey.startsWith('Basic ') ? apiKey : `Basic ${authToken}`,
                 'User-Agent': 'DSDST-Panel',
                 'Accept': 'application/json'
              }
           });
           
           if (response.ok) {
              status = "success";
              message = "Test başarılı";
           } else if (response.status === 401 || response.status === 403) {
              status = "failed";
              message = "Yetkilendirme başarısız";
           } else {
              status = "failed";
              message = `Hata kodu: ${response.status}`;
           }
        } catch (err: any) {
           status = "failed";
           message = "Bağlantı hatası";
        }
      } else {
         message = `Test başarılı (${current.service_name} bağlantı adımı atlandı)`;
      }

      db.prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`last_test_status_${id}`, status);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, CURRENT_TIMESTAMP)").run(`last_tested_at_${id}`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_test_status', ?)").run(status);

      logActivity("API_KEY_TESTED", "integration", id, { 
         after: { result: status, message },
         userIp: req.ip
      });

      res.json({ status, message });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/integrations/keys/:id", apiLimiter, (req, res) => {
    try {
      const id = req.params.id;
      const current = db.prepare("SELECT display_name, service_name FROM api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      
      if (!current) {
        return res.status(404).json({ error: "API anahtarı bulunamadı." });
      }

      db.prepare("UPDATE api_keys SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      logActivity("API_KEY_DELETED", "integration", id, { 
         before: { display_name: current.display_name, service_name: current.service_name }, 
         after: null,
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- PANEL API (INTERNAL KEYS FOR EXTERNAL SYSTEMS) ---
  app.get("/api/integrations/panel-api", apiLimiter, (req, res) => {
    try {
      const keys = db.prepare("SELECT id, name, key_prefix, last4, status, environment, permissions, allowed_ips, expires_at, last_used_at, last_used_ip, created_at, updated_at, revoked_at FROM panel_api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as any[];
      
      const safeKeys = keys.map(k => {
        const testStatusRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_test_status_${k.id}`) as any;
        const testedAtRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_tested_at_${k.id}`) as any;
        return {
          ...k,
          last_test_status: testStatusRow ? testStatusRow.value : null,
          last_tested_at: testedAtRow ? testedAtRow.value : null,
          maskedKey: `${k.key_prefix}********${k.last4}`,
        };
      });

      res.json(safeKeys);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/panel-api", apiLimiter, (req, res) => {
    try {
      const { name, environment, permissions, allowed_ips, expires_at } = req.body;
      
      if (!name) return res.status(400).json({ error: "Ad zorunludur." });
      
      const id = uuidv4();
      const envPrefix = environment === 'live' ? 'dsdst_live_' : 'dsdst_test_';
      const randomStr = crypto.randomBytes(16).toString('hex'); // 32 chars
      const newApiKey = `${envPrefix}${randomStr}`;
      
      const hashedKey = hashApiKey(newApiKey);
      const last4 = newApiKey.slice(-4);

      db.prepare(`
        INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, status, environment, permissions, allowed_ips, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(id, name, envPrefix, hashedKey, last4, environment, JSON.stringify(permissions || []), allowed_ips || null, expires_at || null);
      
      logActivity("PANEL_API_KEY_CREATED", "integration", id, { 
         after: { name, environment, status: 'active' },
         userIp: req.ip
      });

      // ONLY RETURN newApiKey HERE! IT SHOULD NOT BE RETURNED AGAIN.
      res.json({ id, apiKey: newApiKey }); 
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/integrations/panel-api/:id", apiLimiter, (req, res) => {
    try {
      const { name, permissions, allowed_ips, expires_at } = req.body;
      const id = req.params.id;

      if (!name) return res.status(400).json({ error: "Ad zorunludur." });

      const current = db.prepare("SELECT * FROM panel_api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) return res.status(404).json({ error: "API anahtarı bulunamadı." });

      db.prepare(`
        UPDATE panel_api_keys 
        SET name = ?, permissions = ?, allowed_ips = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, JSON.stringify(permissions || []), allowed_ips || null, expires_at || null, id);

      logActivity("PANEL_API_KEY_UPDATED", "integration", id, { 
         after: { name, update: "Panel API Key updated" },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/integrations/panel-api/:id/status", apiLimiter, (req, res) => {
    try {
      const { status } = req.body;
      db.prepare("UPDATE panel_api_keys SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(status, req.params.id);
      
      let action = "PANEL_API_KEY_STATUS";
      if (status === 'active') action = "PANEL_API_KEY_ACTIVATED";
      if (status === 'passive') action = "PANEL_API_KEY_PASSIVATED";

      logActivity(action, "integration", req.params.id, { 
         after: { status },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/panel-api/:id/revoke", apiLimiter, (req, res) => {
    try {
      const id = req.params.id;
      db.prepare("UPDATE panel_api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
      
      logActivity("PANEL_API_KEY_REVOKED", "integration", id, { 
         after: { status: 'revoked' },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/panel-api/:id/rotate", apiLimiter, (req, res) => {
    try {
      const id = req.params.id;
      const current = db.prepare("SELECT * FROM panel_api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) return res.status(404).json({ error: "API anahtarı bulunamadı." });

      // Revoke current
      db.prepare("UPDATE panel_api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      
      // Create new
      const newId = uuidv4();
      const randomStr = crypto.randomBytes(16).toString('hex');
      const newApiKey = `${current.key_prefix}${randomStr}`;
      const hashedKey = hashApiKey(newApiKey);
      const last4 = newApiKey.slice(-4);

      db.prepare(`
        INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, status, environment, permissions, allowed_ips, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(newId, current.name + " (Rotated)", current.key_prefix, hashedKey, last4, current.environment, current.permissions, current.allowed_ips, current.expires_at);

      logActivity("PANEL_API_KEY_ROTATED", "integration", id, { 
         after: { newKeyId: newId },
         userIp: req.ip
      });

      res.json({ id: newId, apiKey: newApiKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/integrations/panel-api/:id/test", apiLimiter, (req, res) => {
    try {
      const id = req.params.id;
      const current = db.prepare("SELECT * FROM panel_api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) return res.status(404).json({ error: "API anahtarı bulunamadı." });

      let status = "success";
      let message = "Test başarılı (Bağlantı açık). permissions: " + current.permissions;

      if (current.status !== 'active') {
         status = "failed";
         message = `Anahtar durumu: ${current.status}`;
      } else if (current.expires_at && new Date(current.expires_at).getTime() < Date.now()) {
         status = "failed";
         message = "Anahtar süresi dolmuş.";
      }

      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`last_test_status_${id}`, status);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, CURRENT_TIMESTAMP)").run(`last_tested_at_${id}`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_test_status', ?)").run(status);

      logActivity("PANEL_API_KEY_TESTED", "integration", id, { 
         after: { result: status, message },
         userIp: req.ip
      });

      res.json({ status, message });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/integrations/panel-api/:id", apiLimiter, (req, res) => {
    try {
      const id = req.params.id;
      
      const current = db.prepare("SELECT * FROM panel_api_keys WHERE id = ? AND deleted_at IS NULL").get(id) as any;
      if (!current) return res.status(404).json({ error: "API anahtarı bulunamadı." });

      db.prepare("UPDATE panel_api_keys SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      logActivity("PANEL_API_KEY_DELETED", "integration", id, { 
         before: { name: current.name },
         userIp: req.ip
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- PUBLIC API AUTHENTICATION MIDDLEWARE ---
  const publicApiAuth = (requiredPermission?: string) => (req: any, res: any, next: any) => {
      const apiKeyHeader = req.headers['x-api-key']?.toString();
      if (!apiKeyHeader) {
          return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "x-api-key header is required" } });
      }

      const hashedKey = hashApiKey(apiKeyHeader);
      const keyData = db.prepare("SELECT * FROM panel_api_keys WHERE key_hash = ? AND deleted_at IS NULL").get(hashedKey) as any;

      if (!keyData) {
          logActivity("PANEL_API_AUTH_FAILED", "system", "auth", { reason: "Invalid key", userIp: req.ip, userAgent: req.headers['user-agent'] });
          return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
      }

      if (keyData.status !== 'active') {
          logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: `Key status is ${keyData.status}`, userIp: req.ip, userAgent: req.headers['user-agent'] });
          return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: `API key is ${keyData.status}` } });
      }

      if (keyData.expires_at && new Date(keyData.expires_at).getTime() < Date.now()) {
          logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "Key expired", userIp: req.ip, userAgent: req.headers['user-agent'] });
          return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "API key has expired" } });
      }

      if (keyData.allowed_ips) {
          const allowedIps = keyData.allowed_ips.split(',').map((ip: string) => ip.trim());
          if (!allowedIps.includes(req.ip)) {
              logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "IP not allowed", userIp: req.ip, userAgent: req.headers['user-agent'] });
              return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "IP not allowed" } });
          }
      }

      const permissions = JSON.parse(keyData.permissions || '[]');
      if (requiredPermission && !permissions.includes(requiredPermission)) {
          logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "Missing permission", requiredPermission, userIp: req.ip, userAgent: req.headers['user-agent'] });
          return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      db.prepare("UPDATE panel_api_keys SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = ? WHERE id = ?").run(req.ip, keyData.id);

      req.panelApiKey = { id: keyData.id, name: keyData.name, permissions };
      next();
  };

  const publicApiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 120, // 120 requests per minute
    message: { success: false, error: { code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded" } }
  });

  const publicAuthFailedLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 20, // 20 failed attempt requests per minute per IP
    skipSuccessfulRequests: true,
    message: { success: false, error: { code: "TOO_MANY_REQUESTS", message: "Too many failed attempts" } }
  });


  app.use("/api/analytics", createProductAnalyticsRouter(db));
  app.use("/api/dashboard", createDashboardDataRouter(db));

  // --- PUBLIC API ROUTES ---
  app.use("/api/public", publicAuthFailedLimiter, publicApiLimiter);

  app.get("/api/public/health", (req, res) => {
    // Health doesn't require auth but we can validate it if present manually or just return ok
    res.json({ success: true, data: { status: "ok", timestamp: new Date().toISOString() } });
  });

  app.get("/api/public/products", publicApiAuth("products:read"), (req, res) => {
    const products = db.prepare("SELECT * FROM products").all();
    logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
    res.json({ success: true, data: products });
  });

  app.get("/api/public/stock", publicApiAuth("stock:read"), (req, res) => {
    const stock = db.prepare(`
      SELECT id as product_id, sku, title, COALESCE(central_stock, 0) as central_stock
      FROM products
      WHERE status != 'deleted'
    `).all();
    logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
    res.json({ success: true, data: stock });
  });

  app.patch("/api/public/stock/:productId", publicApiAuth("stock:write"), (req, res) => {
     // placeholder implementation
     logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
     res.json({ success: true, data: { productId: req.params.productId, updated: true } });
  });

  app.get("/api/public/orders", publicApiAuth("orders:read"), (req, res) => {
    const orders = db.prepare("SELECT * FROM sales").all();
    logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
    res.json({ success: true, data: orders });
  });

  app.post("/api/public/orders", publicApiAuth("orders:write"), (req, res) => {
     // placeholder implementation
     logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
     res.json({ success: true, data: { status: "created", body: req.body } });
  });

  app.get("/api/public/dashboard-summary", publicApiAuth("dashboard:read"), (req, res) => {
    // placeholder implementation
    logActivity("PANEL_API_USED", "public_api", req.panelApiKey.id, { path: req.path, userIp: req.ip });
    res.json({ success: true, data: { totalRevenue: 50000, unreadMessages: 3 } });
  });

  // --- DATABASE BACKUP / RESTORE ---
  // Both endpoints are admin-only — a backup contains the entire DB including credentials.
  app.get("/api/backup/download", requireAdmin, async (req, res) => {
    const ts = Date.now();
    // Write temp files to OS temp dir, not process.cwd(), to avoid polluting the project dir.
    const backupPath = path.join(os.tmpdir(), `dsdst_backup_${ts}.sqlite`);
    const zipPath    = path.join(os.tmpdir(), `dsdst_backup_${ts}.zip`);
    try {
      await db.backup(backupPath);

      const zip = new AdmZip();
      zip.addLocalFile(backupPath, "", "dsdst_panel.db");

      const uploadsDir = path.join(process.cwd(), "uploads");
      if (fs.existsSync(uploadsDir)) {
        zip.addLocalFolder(uploadsDir, "uploads");
      }

      zip.writeZip(zipPath);

      logActivity("BACKUP_DOWNLOADED", "system", "backup", { ip: req.ip }, req.user?.id);

      res.download(zipPath, `dsdst_backup_${new Date().toISOString().split('T')[0]}.zip`, () => {
        try { fs.unlinkSync(backupPath); } catch (_) {}
        try { fs.unlinkSync(zipPath); }    catch (_) {}
      });
    } catch (err: any) {
      try { fs.unlinkSync(backupPath); } catch (_) {}
      try { fs.unlinkSync(zipPath); }    catch (_) {}
      AppLogger.error('BACKUP_ERROR', 'Backup download failed', err);
      res.status(500).json({ success: false, error: { code: 'BACKUP_FAILED', message: err.message } });
    }
  });

  app.post("/api/maintenance/fix-pricing", requireAdmin, (req, res) => {
    try {
      if (req.body?.confirm !== 'FIX_PRICING') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message: "Fiyat onarımı için confirm alanı 'FIX_PRICING' olmalıdır.",
          },
        });
      }

      db.transaction(() => {
        // 1. Fill purchase_price_usd from purchase_cost if purchase_price_usd is 0 and purchase_cost > 0
        // Use a default exchange rate if activeRate is not available, but let's assume we read settings
        const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
        const settingsObj: any = {};
        settingsRows.forEach((r: any) => settingsObj[r.key] = r.value);

        const activeRateRow = db.prepare("SELECT * FROM exchange_rates WHERE is_active = 1 ORDER BY fetched_at DESC LIMIT 1").get() as any;
        const defaultRate = activeRateRow?.rate || parseFloat(settingsObj.usd_exchange_rate) || 35; // fallback
        const defaultBuffer = parseFloat(settingsObj.default_buffer_percentage) || 20;
        const defaultProfit = parseFloat(settingsObj.default_profit_percentage) || 50;

        // Fetch products that need fixing
        const productsParams = db.prepare(`
           SELECT id, purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked 
           FROM products
        `).all() as any[];

        const updateStmt = db.prepare(`
           UPDATE products 
           SET purchase_price_usd=?, purchase_cost=?, sale_price=?, buffer_percentage=?, profit_percentage=?, exchange_rate_used=?, price_locked=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?
        `);

        for (const p of productsParams) {
           let { purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked } = p;
           
           purchase_price_usd = purchase_price_usd || 0;
           purchase_cost = purchase_cost || 0;
           sale_price = sale_price || 0;
           buffer_percentage = buffer_percentage || defaultBuffer;
           profit_percentage = profit_percentage || defaultProfit;
           exchange_rate_used = exchange_rate_used || defaultRate;

           let needsUpdate = false;

           // If USD is zero, but cost is not
           if (purchase_price_usd === 0 && purchase_cost > 0) {
              purchase_price_usd = purchase_cost / exchange_rate_used;
              needsUpdate = true;
           }

           // If USD is zero, and Cost is zero, but Sale price is not
           if (purchase_price_usd === 0 && purchase_cost === 0 && sale_price > 0) {
              // Backward calculation
              // sale_price = bufferedCost * (1+profit/100)
              // bufferedCost = cost * (1+buffer/100)
              const bufferedCost = sale_price / (1 + (profit_percentage/100));
              purchase_cost = bufferedCost / (1 + (buffer_percentage/100));
              purchase_price_usd = purchase_cost / exchange_rate_used;
              needsUpdate = true;
           }
           
           if (!p.buffer_percentage || !p.profit_percentage || !p.exchange_rate_used) {
              needsUpdate = true;
           }

           if (needsUpdate) {
              updateStmt.run(purchase_price_usd, purchase_cost, sale_price, buffer_percentage, profit_percentage, exchange_rate_used, price_locked, p.id);
           }
        }

        // Fix missing cost data in sales and sale_items
        const salesObj = db.prepare("SELECT * FROM sales").all() as any[];
        const updateSaleItem = db.prepare("UPDATE sale_items SET purchase_cost=?, net_profit=? WHERE id=?");
        const updateSale = db.prepare("UPDATE sales SET net_total=?, gross_profit=?, net_profit=?, packaging_cost=?, ad_spend=?, other_expenses=? WHERE id=?");

        for (const s of salesObj) {
           const items = db.prepare("SELECT * FROM sale_items WHERE sale_id=?").all(s.id) as any[];
           let totalPurchaseCost = 0;
           for (const item of items) {
              let itemCost = item.purchase_cost;
              if (!itemCost || itemCost <= 0) {
                 const prod = db.prepare("SELECT purchase_cost FROM products WHERE id=?").get(item.product_id) as any;
                 itemCost = prod?.purchase_cost || 0;
              }
              const itemTotalRevenue = item.unit_price * item.quantity;
              const itemTotalCost = itemCost * item.quantity;
              const comm = itemTotalRevenue * (s.commission_rate || 0) / 100;
              const itemProfit = itemTotalRevenue - itemTotalCost - comm;
              updateSaleItem.run(itemCost, itemProfit, item.id);
              totalPurchaseCost += itemTotalCost;
           }

           const val = (n: any) => parseFloat(n) || 0;
           const netTotal = val(s.total_amount) - val(s.discount);
           const grossProfit = netTotal - totalPurchaseCost;
           const netProfit = grossProfit - val(s.shipping_cost) - val(s.packaging_cost) - val(s.ad_spend) - val(s.other_expenses) - (val(s.total_amount) * val(s.commission_rate) / 100);

           updateSale.run(netTotal, grossProfit, netProfit, val(s.packaging_cost), val(s.ad_spend), val(s.other_expenses), s.id);
        }

      })();

      res.json({ success: true, message: "Fiyat verileri ve geçmiş satışlar onarıldı." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Restore is admin-only and uses a mutex flag to prevent concurrent access during the swap.
  let isRestoring = false;

  app.post("/api/backup/restore", requireAdmin, backupUpload.single("zipfile"), async (req, res) => {
    if (isRestoring) {
      return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Restore işlemi zaten devam ediyor.' } });
    }

    const uploadedPath = req.file?.path;
    let beforeRestorePath: string | null = null;
    try {
      if (!uploadedPath) {
        return res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'Yedek dosyası yüklenmedi.' } });
      }

      const zip = new AdmZip(uploadedPath);
      const zipEntries = zip.getEntries();

      const dbEntry = zipEntries.find((e) => e.entryName === "dsdst_panel.db");
      if (!dbEntry) {
        try { fs.unlinkSync(uploadedPath); } catch (_) {}
        return res.status(400).json({ success: false, error: { code: 'INVALID_BACKUP', message: 'Geçersiz yedek: dsdst_panel.db bulunamadı.' } });
      }

      isRestoring = true;

      // Write the restored DB to a temp location first for validation, then move it into place.
      const restoredDbPath = path.join(os.tmpdir(), `dsdst_restore_${Date.now()}.db`);
      fs.writeFileSync(restoredDbPath, dbEntry.getData());

      // Validate the restored DB is a valid SQLite file before swapping.
      let testDb: Database.Database | null = null;
      try {
        testDb = new Database(restoredDbPath, { readonly: true });
        testDb.pragma("integrity_check");
      } finally {
        testDb?.close();
      }

      if (fs.existsSync(DB_PATH)) {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        beforeRestorePath = `${DB_PATH}.before-restore-${safeTimestamp}.db`;
        await db.backup(beforeRestorePath);
      }

      // Swap: close current DB, replace file, reopen.
      db.close();

      try { fs.unlinkSync(`${DB_PATH}-wal`); } catch (_) {}
      try { fs.unlinkSync(`${DB_PATH}-shm`); } catch (_) {}
      fs.copyFileSync(restoredDbPath, DB_PATH);
      try { fs.unlinkSync(restoredDbPath); } catch (_) {}

      // Restore /uploads from the zip if present. Entries are resolved through
      // a path traversal guard before writing anything to disk.
      for (const entry of zipEntries) {
        restoreUploadEntry(entry);
      }

      db = openDatabase(DB_PATH);
      initializeDatabase(db);

      logActivity("DB_RESTORED", "system", "system", {
        restoredBy: req.user?.username,
        ip: req.ip,
        beforeRestorePath,
      }, req.user?.id);

      // Restore done. Imported routers (analytics, dashboard, recurring) hold a
      // reference to the OLD db object captured at startup. Rather than rewiring
      // every router to use a getter, exit the process — Docker / systemd / PM2
      // will restart it cleanly with the fresh DB. The client should redirect
      // to login after a few seconds.
      res.json({
        success: true,
        message: "Yedek başarıyla geri yüklendi. Sunucu 3 saniye içinde yeniden başlatılacak.",
        before_restore_backup: beforeRestorePath,
        restart_in_seconds: 3,
      });
      setTimeout(() => {
        AppLogger.info('SYSTEM', 'Exiting after backup restore — process manager will restart');
        process.exit(0);
      }, 3000);
      return;
    } catch (err: any) {
      AppLogger.error('RESTORE_ERROR', 'Backup restore failed', err);
      res.status(500).json({ success: false, error: { code: 'RESTORE_FAILED', message: err.message } });
    } finally {
      if (uploadedPath) try { fs.unlinkSync(uploadedPath); } catch (_) {}
      isRestoring = false;
    }
  });

  // --- VITE MIDDLEWARE ---

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global Error Handler must be last!
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    AppLogger.error('REQUEST_ERROR', `Error processing ${req.method} ${req.url}`, err);
    if (err instanceof z.ZodError) {
       return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.issues } });
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Bir hata oluştu' } });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
