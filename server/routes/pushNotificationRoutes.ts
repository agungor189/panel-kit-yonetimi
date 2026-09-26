import express, { type Request, type RequestHandler, type Response } from 'express';
import {
  PushOwnershipError,
  PushSubscriptionNotFoundError,
  PushUnavailableError,
  PushValidationError,
  type PushNotificationService,
} from '../modules/notifications/pushNotificationService.js';

type AuditWriter = (action: string, entityType: string, entityId: string, details?: unknown, userId?: string) => void;

const sendError = (res: Response, status: number, code: string, message: string) => (
  res.status(status).json({ success: false, error: { code, message } })
);

export function createPushNotificationRouter(
  service: PushNotificationService,
  audit: AuditWriter | undefined,
  requireTemplateAdmin: RequestHandler,
) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const endpointHash = typeof req.query.endpoint_hash === 'string' ? req.query.endpoint_hash : undefined;
    res.json({ success: true, data: service.status(req.user!.id, endpointHash) });
  });

  router.get('/preferences', (req, res) => {
    res.json({ success: true, data: service.getPreferences(req.user!.id) });
  });

  router.put('/preferences', (req, res) => {
    try {
      const preferences = service.updatePreferences(req.user!.id, req.body);
      audit?.('PUSH_PREFERENCES_UPDATED', 'user_notification_preferences', req.user!.id, preferences, req.user!.id);
      res.json({ success: true, data: preferences });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_PREFERENCES_INVALID', error.message);
      return sendError(res, 500, 'PUSH_PREFERENCES_UPDATE_FAILED', 'Bildirim tercihleri güncellenemedi.');
    }
  });

  router.get('/templates', (_req, res) => {
    res.json({ success: true, data: service.getTemplates() });
  });

  router.put('/templates/:category', requireTemplateAdmin, (req, res) => {
    try {
      const template = service.updateTemplate(req.params.category, req.body, req.user!.id);
      audit?.('PUSH_TEMPLATE_UPDATED', 'notification_template', template.category, template, req.user!.id);
      res.json({ success: true, data: template });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_TEMPLATE_INVALID', error.message);
      return sendError(res, 500, 'PUSH_TEMPLATE_UPDATE_FAILED', 'Bildirim şablonu güncellenemedi.');
    }
  });

  router.post('/templates/:category/reset', requireTemplateAdmin, (req, res) => {
    try {
      const template = service.resetTemplate(req.params.category);
      audit?.('PUSH_TEMPLATE_RESET', 'notification_template', template.category, { reset: true }, req.user!.id);
      res.json({ success: true, data: template });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_TEMPLATE_INVALID', error.message);
      return sendError(res, 500, 'PUSH_TEMPLATE_RESET_FAILED', 'Bildirim şablonu varsayılana döndürülemedi.');
    }
  });

  router.post('/subscribe', (req, res) => {
    try {
      const result = service.subscribe(req.user!.id, req.body);
      audit?.('PUSH_SUBSCRIBED', 'push_subscription', req.user!.id, { created: result.created }, req.user!.id);
      res.status(result.created ? 201 : 200).json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_SUBSCRIPTION_INVALID', error.message);
      if (error instanceof PushOwnershipError) return sendError(res, 409, 'PUSH_ENDPOINT_OWNERSHIP_CONFLICT', error.message);
      if (error instanceof PushUnavailableError) return sendError(res, 503, 'PUSH_UNAVAILABLE', error.message);
      return sendError(res, 500, 'PUSH_SUBSCRIBE_FAILED', 'Push subscription kaydedilemedi.');
    }
  });

  router.post('/rebind', (req, res) => {
    try {
      const result = service.rebind(req.user!.id, req.body);
      audit?.(
        'PUSH_SUBSCRIPTION_REBOUND',
        'push_subscription',
        result.endpointHash,
        { previous_user_id: result.previousOwnerId, new_user_id: req.user!.id, rebound: result.rebound },
        req.user!.id,
      );
      res.json({
        success: true,
        data: { created: result.created, subscribed: result.subscribed, rebound: result.rebound },
      });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_SUBSCRIPTION_INVALID', error.message);
      if (error instanceof PushUnavailableError) return sendError(res, 503, 'PUSH_UNAVAILABLE', error.message);
      return sendError(res, 500, 'PUSH_REBIND_FAILED', 'Push subscription bu hesaba taşınamadı.');
    }
  });

  router.post('/unsubscribe', (req, res) => {
    try {
      const result = service.unsubscribe(req.user!.id, req.body?.endpoint);
      audit?.('PUSH_UNSUBSCRIBED', 'push_subscription', req.user!.id, { removed: result.removed }, req.user!.id);
      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PushValidationError) return sendError(res, 400, 'PUSH_SUBSCRIPTION_INVALID', error.message);
      return sendError(res, 500, 'PUSH_UNSUBSCRIBE_FAILED', 'Push subscription kaldırılamadı.');
    }
  });

  router.post('/test', async (req: Request, res: Response) => {
    try {
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
      const result = await service.sendTest(req.user!.id, endpoint);
      audit?.('PUSH_TEST_SENT', 'push_subscription', req.user!.id, result, req.user!.id);
      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PushUnavailableError) return sendError(res, 503, 'PUSH_UNAVAILABLE', error.message);
      if (error instanceof PushSubscriptionNotFoundError) return sendError(res, 404, 'PUSH_SUBSCRIPTION_NOT_FOUND', error.message);
      return sendError(res, 500, 'PUSH_TEST_FAILED', 'Test bildirimi gönderilemedi.');
    }
  });

  return router;
}
