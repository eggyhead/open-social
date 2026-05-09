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
        // Generate msgId once per webhook so it's stable across retries (idempotency key)
        const msgId = `msg_${crypto.randomBytes(16).toString('base64url')}`;
        retry(
          () => fireWebhook(webhook.url, payload, webhook.secret, msgId),
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
async function fireWebhook(url: string, payload: WebhookPayload, secret: string | null | undefined, msgId: string) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenSocial-Webhooks/1.0',
    'webhook-id': msgId,
    'webhook-timestamp': timestamp,
  };

  if (secret) {
    const toSign = `${msgId}.${timestamp}.${body}`;
    // Decode the secret: whsec_ prefix → base64, hex string → hex, otherwise raw bytes
    let secretBytes: Buffer;
    if (secret.startsWith('whsec_')) {
      secretBytes = Buffer.from(secret.slice(6), 'base64');
    } else if (/^[0-9a-f]{32,}$/i.test(secret)) {
      secretBytes = Buffer.from(secret, 'hex');
    } else {
      secretBytes = Buffer.from(secret, 'utf-8');
    }
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
