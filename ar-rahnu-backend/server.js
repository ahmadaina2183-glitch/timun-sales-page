import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webpush from 'web-push';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

const db = {
  recordsByClient: new Map(),
  subscriptions: []
};

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/arrahnu/sync', (req, res) => {
  const { records = [], pendingOps = [], clientTs } = req.body || {};
  const clientId = req.header('x-client-id') || req.ip;

  db.recordsByClient.set(clientId, {
    records,
    pendingOps,
    updatedAt: Date.now(),
    clientTs
  });

  res.json({ ok: true, syncedAt: Date.now(), recordsCount: records.length, opsCount: pendingOps.length });
});

app.post('/arrahnu/subscribe', (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });

  const exists = db.subscriptions.some((s) => s.endpoint === subscription.endpoint);
  if (!exists) db.subscriptions.push(subscription);

  res.json({ ok: true, totalSubscriptions: db.subscriptions.length });
});

app.post('/arrahnu/push-test', async (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return res.status(400).json({ ok: false, error: 'Missing VAPID env config' });
  }

  const { title = 'Ar-Rahnu Reminder', body = 'Ini notifikasi ujian', url = '/timun-sales-page/ar-rahnu/' } = req.body || {};
  const payload = JSON.stringify({ title, body, url });

  const results = await Promise.allSettled(db.subscriptions.map((sub) => webpush.sendNotification(sub, payload)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;

  res.json({ ok: true, sent: ok, failed: fail, total: results.length });
});

app.get('/arrahnu/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.listen(PORT, () => {
  console.log(`Ar-Rahnu backend template running on :${PORT}`);
});