import type { Kysely } from 'kysely';
import crypto from 'crypto';
import type { Database } from '../db';
import { logger } from '../lib/logger';
import { retry, isTransientError } from '../lib/retry';

export type WebhookEvent =
  | 'member.joined'
  | 'member.left'
  | 'member.approved'
  | 'member.rejected'
  | 'member.removed'
  | 'record.created'
  | 'record.updated'
  | 'record.deleted';

/**
 * Standard Webhooks payload format.
 * @see https://www.standardwebhooks.com/
 */
interface WebhookPayload {
  type: WebhookEvent;
  timestamp: string;
  data: Record<string, any>;
}

export function createWebhookService(db: Kysely<Database>) {
  async function dispatch(event: WebhookEvent, communityDid: string, data: Record<string, any>) {
    try {
      const webhooks = await db
        .selectFrom('webhooks')
        .selectAll()
        .where('active', '=', true)
        .where((eb) =>
          eb.or([
            eb('community_did', 'is', null),
            eb('community_did', '=', communityDid),
          ])
        )
        .execute();

      const matchingWebhooks = webhooks.filter((w) => {
        const events = typeof w.events === 'string' ? JSON.parse(w.events) : w.events;
        return events.includes(event);
      });

      const payload: WebhookPayload = {
        type: event,
        timestamp: new Date().toISOString(),
        data: { ...data, communityDid },
      };

      for (const webhook of matchingWebhooks) {
        retry(
          () => fireWebhook(webhook.url, payload, webhook.secret),
          {
            maxRetries: 3,
            initialDelay: 1000,
            shouldRetry: (error) => isTransientError(error),
            context: {
              webhookUrl: webhook.url,
              event,
              communityDid,
            },
          }
        ).catch((err) => {
          logger.error({
            webhookUrl: webhook.url,
            event,
            communityDid,
            error: err.message,
            errorStack: err.stack,
          }, 'Webhook delivery failed after all retries');
        });
      }
    } catch (err) {
      logger.error({ error: err, event, communityDid }, 'Webhook dispatch error');
    }
  }

  return { dispatch };
}

/**
 * Sign and deliver a webhook per the Standard Webhooks spec.
 *
 * Headers:
 * - webhook-id:        unique message ID (idempotency key, stable across retries)
 * - webhook-timestamp: unix seconds of this delivery attempt
 * - webhook-signature: v1,{base64 HMAC-SHA256 of msg_id.timestamp.body}
 *
 * @see https://www.standardwebhooks.com/
 */
async function fireWebhook(url: string, payload: WebhookPayload, secret?: string | null) {
  const body = JSON.stringify(payload);
  const msgId = `msg_${crypto.randomBytes(16).toString('base64url')}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenSocial-Webhooks/1.0',
    'webhook-id': msgId,
    'webhook-timestamp': timestamp,
  };

  if (secret) {
    const toSign = `${msgId}.${timestamp}.${body}`;
    // Secrets are stored with whsec_ prefix per Standard Webhooks
    const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const secretBytes = Buffer.from(rawSecret, 'base64');
    const signature = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');
    headers['webhook-signature'] = `v1,${signature}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }
}

/**
 * Generate a Standard Webhooks signing secret.
 * Format: whsec_{base64 random bytes}
 */
export function generateWebhookSecret(): string {
  const bytes = crypto.randomBytes(32);
  return `whsec_${bytes.toString('base64')}`;
}
