import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webpush from 'web-push';
import { Pool } from 'pg';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in env');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arrahnu_clients (
      client_id TEXT PRIMARY KEY,
      records JSONB NOT NULL DEFAULT '[]'::jsonb,
      pending_ops JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_ts BIGINT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arrahnu_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

app.get('/health', async (req, res) => {
  const q = await pool.query('SELECT NOW() as now');
  res.json({ ok: true, dbTime: q.rows[0].now });
});

app.post('/arrahnu/sync', async (req, res) => {
  const { records = [], pendingOps = [], clientTs } = req.body || {};
  const clientId = req.header('x-client-id') || req.ip;

  await pool.query(
    `INSERT INTO arrahnu_clients (client_id, records, pending_ops, updated_at, client_ts)
     VALUES ($1, $2::jsonb, $3::jsonb, NOW(), $4)
     ON CONFLICT (client_id)
     DO UPDATE SET records = EXCLUDED.records,
                   pending_ops = EXCLUDED.pending_ops,
                   updated_at = NOW(),
                   client_ts = EXCLUDED.client_ts`,
    [clientId, JSON.stringify(records), JSON.stringify(pendingOps), clientTs || null]
  );

  res.json({ ok: true, syncedAt: Date.now(), recordsCount: records.length, opsCount: pendingOps.length });
});

app.get('/arrahnu/sync/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const q = await pool.query('SELECT client_id, records, pending_ops, updated_at, client_ts FROM arrahnu_clients WHERE client_id = $1', [clientId]);
  if (!q.rows.length) return res.status(404).json({ ok: false, error: 'Client not found' });
  res.json({ ok: true, data: q.rows[0] });
});

app.post('/arrahnu/subscribe', async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });

  await pool.query(
    `INSERT INTO arrahnu_subscriptions (endpoint, subscription, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (endpoint)
     DO UPDATE SET subscription = EXCLUDED.subscription, updated_at = NOW()`,
    [subscription.endpoint, JSON.stringify(subscription)]
  );

  const c = await pool.query('SELECT COUNT(*)::int AS total FROM arrahnu_subscriptions');
  res.json({ ok: true, totalSubscriptions: c.rows[0].total });
});

app.post('/arrahnu/push-test', async (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return res.status(400).json({ ok: false, error: 'Missing VAPID env config' });
  }

  const { title = 'Ar-Rahnu Reminder', body = 'Ini notifikasi ujian', url = '/timun-sales-page/ar-rahnu/' } = req.body || {};
  const payload = JSON.stringify({ title, body, url });

  const q = await pool.query('SELECT endpoint, subscription FROM arrahnu_subscriptions');
  const results = await Promise.allSettled(q.rows.map((r) => webpush.sendNotification(r.subscription, payload)));

  let sent = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') sent++;
    else {
      failed++;
      const statusCode = r.reason?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await pool.query('DELETE FROM arrahnu_subscriptions WHERE endpoint = $1', [q.rows[i].endpoint]);
      }
    }
  }

  res.json({ ok: true, sent, failed, total: results.length });
});

app.get('/arrahnu/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Ar-Rahnu backend (Postgres) running on :${PORT}`);
  });
}).catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});