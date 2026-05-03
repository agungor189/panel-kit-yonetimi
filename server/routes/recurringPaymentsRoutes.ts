import express from "express";
import { v4 as uuidv4 } from "uuid";

// Note: we can't directly inject `db` safely if we don't import it or pass it.
// In this project, `server.ts` uses `db = new Database(...)`.
// So we need to export `createRecurringPaymentsRouter` and pass `db`.

export function createRecurringPaymentsRouter(db: any) {
  const router = express.Router();

  const insertActivity = (req: express.Request | undefined, action: string, entityType: string, entityId: string, details?: any) => {
    const actor = (req as any)?.user;
    try {
      db.prepare(`
        INSERT INTO activity_logs (id, action, entity_type, entity_id, details, user_id, actor_username)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        action,
        entityType,
        entityId,
        details ? JSON.stringify(details) : null,
        actor?.id || null,
        actor?.username || null,
      );
    } catch (_) {}
  };

  // Helper to get active exchange rate
  const getExchangeRate = () => {
    try {
      const row = db.prepare("SELECT rate FROM exchange_rates WHERE is_active = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      return row && row.rate ? row.rate : 35; // Fallback
    } catch {
      return 35;
    }
  };

  // Helper to calculate next payment date
  const calculateNextDueDate = (plan: any) => {
    // simplified: just fallback to start_date or current date
    return plan.start_date || new Date().toISOString().split('T')[0];
  };

  // GET all plans
  router.get("/", (req, res) => {
    try {
      const plans = db.prepare("SELECT * FROM recurring_payment_plans ORDER BY created_at DESC").all();
      res.json(plans);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST create new plan
  router.post("/", (req, res) => {
    try {
      const p = req.body;
      const id = uuidv4();
      
      const activeRate = getExchangeRate();
      const planExchangeRate = p.exchange_rate || activeRate;
      const amountTry = p.currency === 'USD' ? p.amount * planExchangeRate : 
                        p.currency === 'EUR' ? p.amount * (planExchangeRate * 1.1) : p.amount; // crude eur logic fallback

      // Next due date logic
      const nextDue = calculateNextDueDate(p);

      db.prepare(`
        INSERT INTO recurring_payment_plans (
          id, title, description, category, payment_type, amount, currency, 
          amount_try, exchange_rate, due_day, due_month, start_month, week_day, custom_interval_days, frequency, start_date, 
          end_date, next_due_date, auto_process, is_active, payment_account_id, 
          expense_category_id, tax_type, related_party, document_required, notes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id, p.title, p.description || '', p.category, p.payment_type || 'expense',
        p.amount, p.currency || 'TRY', amountTry, planExchangeRate, p.due_day || null, 
        p.due_month || null, p.start_month || null, p.week_day || null, p.custom_interval_days || null, p.frequency || 'monthly', p.start_date || new Date().toISOString().split('T')[0],
        p.end_date || null, nextDue, p.auto_process ? 1 : 0, p.is_active !== undefined ? (p.is_active ? 1 : 0) : 1,
        p.payment_account_id || null, p.expense_category_id || p.category, p.tax_type || null, 
        p.related_party || null, p.document_required ? 1 : 0, p.notes || ''
      );

      insertActivity(req, 'CREATE', 'recurring_payment_plan', id, p);

      res.status(201).json({ success: true, id });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE plan
  router.delete("/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM recurring_payment_plans WHERE id = ?").run(req.params.id);
      db.prepare("DELETE FROM recurring_payment_occurrences WHERE recurring_payment_id = ?").run(req.params.id);
      
      insertActivity(req, 'DELETE', 'recurring_payment_plan', req.params.id);

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET calendar occurrences for a month (e.g. month=2026-05)
  router.get("/calendar", (req, res) => {
    try {
      const monthStr = req.query.month as string; // 'YYYY-MM' format
      if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
         return res.status(400).json({ error: 'Valid month query required (YYYY-MM)' });
      }

      // Automatically generate occurrences for this month if missing
      generateOccurrencesForMonth(monthStr);

      const occurrences = db.prepare(`
        SELECT o.*, 
               p.title as plan_title, p.category as plan_category, p.auto_process as plan_auto_process,
               p.payment_type as plan_payment_type, p.frequency as plan_frequency
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON o.recurring_payment_id = p.id
        WHERE o.due_date LIKE ?
        ORDER BY o.due_date ASC
      `).all(`${monthStr}%`);

      res.json(occurrences);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const generateOccurrencesForMonth = (monthStr: string) => {
    const [year, month] = monthStr.split('-').map(Number);
    const activePlans = db.prepare("SELECT * FROM recurring_payment_plans WHERE is_active = 1").all();
    
    db.transaction(() => {
      for (const p of activePlans) {
        // Stop if end_date has passed for this month (approx) or start_date is in future
        const lastDayOfMonth = new Date(year, month, 0).getDate();
        const monthEndStr = `${year}-${month.toString().padStart(2, '0')}-${lastDayOfMonth.toString().padStart(2, '0')}`;
        const monthStartStr = `${year}-${month.toString().padStart(2, '0')}-01`;

        if (p.end_date && monthStartStr > p.end_date) continue;
        if (p.start_date && monthEndStr < p.start_date) continue;

        let dueDates: string[] = [];

        const freq = p.frequency || 'monthly';
        const startMonth = p.start_month || 1;
        
        if (freq === 'monthly') {
          const actualDay = Math.min(p.due_day || 1, lastDayOfMonth);
          dueDates.push(`${year}-${month.toString().padStart(2, '0')}-${actualDay.toString().padStart(2, '0')}`);
        } else if (freq === 'quarterly') {
          if ((month - startMonth) % 3 === 0) {
            const actualDay = Math.min(p.due_day || 1, lastDayOfMonth);
            dueDates.push(`${year}-${month.toString().padStart(2, '0')}-${actualDay.toString().padStart(2, '0')}`);
          }
        } else if (freq === 'semi_annually') {
          if ((month - startMonth) % 6 === 0) {
            const actualDay = Math.min(p.due_day || 1, lastDayOfMonth);
            dueDates.push(`${year}-${month.toString().padStart(2, '0')}-${actualDay.toString().padStart(2, '0')}`);
          }
        } else if (freq === 'yearly') {
          if (month === (p.due_month || 1)) {
            const actualDay = Math.min(p.due_day || 1, lastDayOfMonth);
            dueDates.push(`${year}-${month.toString().padStart(2, '0')}-${actualDay.toString().padStart(2, '0')}`);
          }
        } else if (freq === 'weekly') {
          const targetWeekDay = p.week_day || 1; // 1=Mon, 7=Sun
          for (let d = 1; d <= lastDayOfMonth; d++) {
            const date = new Date(year, month - 1, d);
            let dayOfWeek = date.getDay(); // 0=Sun, 1=Mon...
            if (dayOfWeek === 0) dayOfWeek = 7;
            if (dayOfWeek === targetWeekDay) {
              dueDates.push(`${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`);
            }
          }
        } else if (freq === 'custom') {
           if (p.start_date && p.custom_interval_days && p.custom_interval_days > 0) {
              const start = new Date(p.start_date);
              const customInterval = p.custom_interval_days;
              // naive brute force forward from start date. It's fast in JS.
              let curr = start;
              const monthStart = new Date(year, month - 1, 1);
              const monthEnd = new Date(year, month - 1, lastDayOfMonth);
              
              const MAX_ITERS = 10000;
              let iters = 0;
              while (curr <= monthEnd && iters < MAX_ITERS) {
                 if (curr >= monthStart) {
                    const y = curr.getFullYear();
                    const m = (curr.getMonth()+1).toString().padStart(2, '0');
                    const dStr = curr.getDate().toString().padStart(2, '0');
                    dueDates.push(`${y}-${m}-${dStr}`);
                 }
                 curr.setDate(curr.getDate() + customInterval);
                 iters++;
              }
           }
        }

        for (const dueStr of dueDates) {
          if (p.end_date && dueStr > p.end_date) continue;
          if (p.start_date && dueStr < p.start_date) continue;

          try {
            db.prepare(`
              INSERT INTO recurring_payment_occurrences (
                id, recurring_payment_id, due_date, amount, currency, exchange_rate, amount_try, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            `).run(
              uuidv4(), p.id, dueStr, p.amount, p.currency, p.exchange_rate, p.amount_try
            );
          } catch(e: any) {
            // UNIQUE constraint failed means it's already there
          }
        }
      }
    })();
  };

  // POST manually generate for month
  router.post("/generate", (req, res) => {
    try {
      const monthStr = req.query.month as string;
      generateOccurrencesForMonth(monthStr);
      res.json({ success: true });
    } catch(error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST process due payments manually (all valid 'auto_process = true' up to today)
  router.post("/process-due", (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const dueOccurrences = db.prepare(`
        SELECT o.*, p.title, p.category, p.expense_category_id, p.payment_account_id, p.payment_type 
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON o.recurring_payment_id = p.id
        WHERE o.status IN ('pending', 'due', 'overdue') 
          AND o.due_date <= ?
          AND p.auto_process = 1
          AND p.is_active = 1
      `).all(today);

      let count = 0;
      db.transaction(() => {
        for (const o of dueOccurrences) {
          processSingleOccurrence(o, req);
          count++;
        }
      })();

      res.json({ success: true, processed_count: count });
    } catch(error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const processSingleOccurrence = (occ: any, req?: express.Request) => {
    // 1. Create expense
    const expenseId = uuidv4();
    const activeRate = getExchangeRate();
    const txExchangeRate = occ.exchange_rate || activeRate;
    
    db.prepare(`
      INSERT INTO transactions (
        id, date, type, category, platform, amount, note, title, description, 
        cash_account_id, currency, exchange_rate_at_transaction, amount_try, is_invoice
      )
      VALUES (?, ?, 'Expense', ?, 'Periyodik', ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      expenseId, occ.due_date, occ.expense_category_id || occ.category, occ.amount,
      `Otomatik işleme: ${occ.title}`, occ.title, `Bu gider periyodik ödeme planından oluşturulmuştur.`,
      occ.payment_account_id, occ.currency, txExchangeRate, occ.amount_try
    );

    // 2. Create cash transaction if account provided
    if (occ.payment_account_id) {
       db.prepare(`
        INSERT INTO cash_transactions (id, account_id, type, amount, currency, exchange_rate_at_transaction, source_type, source_id, description)
        VALUES (?, ?, 'OUT', ?, ?, ?, 'expense', ?, ?)
       `).run(uuidv4(), occ.payment_account_id, occ.amount, occ.currency || 'TRY', txExchangeRate, expenseId, `Periyodik Ödeme: ${occ.title}`);
    }

    // 3. Mark processed
    db.prepare(`
      UPDATE recurring_payment_occurrences 
      SET status = 'processed', expense_id = ?, processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(expenseId, occ.id);

    insertActivity(req, 'PROCESS', 'recurring_occurrence', occ.id, { expense_id: expenseId });
  };

  // POST process single
  router.post("/occurrences/:id/process", (req, res) => {
    try {
      const occ = db.prepare(`
        SELECT o.*, p.title, p.category, p.expense_category_id, p.payment_account_id, p.payment_type 
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON o.recurring_payment_id = p.id
        WHERE o.id = ?
      `).get(req.params.id);

      if (!occ || occ.status === 'processed') return res.status(400).json({ error: 'Cannot process this occurrence' });

      db.transaction(() => {
        processSingleOccurrence(occ, req);
      })();
      res.json({ success: true });
    } catch(error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST skip single
  router.post("/occurrences/:id/skip", (req, res) => {
    try {
      db.prepare("UPDATE recurring_payment_occurrences SET status = 'skipped' WHERE id = ?").run(req.params.id);
      insertActivity(req, 'SKIP', 'recurring_occurrence', req.params.id);
      res.json({ success: true });
    } catch(error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST cancel single
  router.post("/occurrences/:id/cancel", (req, res) => {
    try {
      db.prepare("UPDATE recurring_payment_occurrences SET status = 'cancelled' WHERE id = ?").run(req.params.id);
      insertActivity(req, 'CANCEL', 'recurring_occurrence', req.params.id);
      res.json({ success: true });
    } catch(error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
