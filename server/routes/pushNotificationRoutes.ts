import express, { type Request, type Response } from 'express';
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

export function createPushNotificationRouter(service: PushNotificationService, audit?: AuditWriter) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const endpointHash = typeof req.query.endpoint_hash === 'string' ? req.query.endpoint_hash : undefined;
    res.json({ success: true, data: service.status(req.user!.id, endpointHash) });
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
