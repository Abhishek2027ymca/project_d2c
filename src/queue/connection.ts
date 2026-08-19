import type { ConnectionOptions } from 'bullmq';
import 'dotenv/config';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error('REDIS_URL is not set. Copy .env.example to .env and fill it in.');
}

const parsed = new URL(redisUrl);

/**
 * Options rather than a constructed client: BullMQ ships its own ioredis copy,
 * and handing it a client built from a separately installed one causes a
 * dual-package type clash. Letting BullMQ build the client keeps one copy.
 *
 * `maxRetriesPerRequest: null` is required — BullMQ's blocking commands hold a
 * connection open for minutes, which ioredis's default retry cap treats as a
 * failed request and kills mid-wait.
 */
export const redisConnection: ConnectionOptions = {
  host: parsed.hostname,
  port: Number(parsed.port || 6379),
  username: parsed.username || undefined,
  password: parsed.password || undefined,
  // rediss:// means TLS. Upstash and most hosted Redis require it.
  tls: parsed.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null,
};
