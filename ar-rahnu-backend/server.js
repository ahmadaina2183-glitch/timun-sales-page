import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webpush from 'web-push';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_clients (client_id TEXT PRIMARY KEY, records JSONB NOT NULL DEFAULT '[]'::jsonb, pending_ops JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), client_ts BIGINT);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_subscriptions (endpoint TEXT PRIMARY KEY, subscription JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_staff_users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_audit_logs (id BIGSERIAL PRIMARY KEY, actor_email TEXT, action TEXT NOT NULL, target TEXT, meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);

  // Seed 1 admin from env if missing
  if (process.env.STAFF_EMAIL && process.env.STAFF_PASSWORD) {
    const hash = await bcrypt.hash(process.env.STAFF_PASSWORD, 10);
    await pool.query(
      `INSERT INTO arrahnu_staff_users (email, password_hash, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [process.env.STAFF_EMAIL, hash]
    );
  }
}

async function logAudit(actorEmail, action, target = null, meta = null) {
  await pool.query(
    `INSERT INTO arrahnu_audit_logs (actor_email, action, target, meta) VALUES ($1,$2,$3,$4::jsonb)`,
    [actorEmail || null, action, target, meta ? JSON.stringify(meta) : null]
  );
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ ok: false, error: 'Invalid token' }); }
}
function adminOnly(req,res,next){ if(req.user?.role!=='admin') return res.status(403).json({ok:false,error:'Admin only'}); next(); }

app.post('/auth/login', async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const q = await pool.query('SELECT email, password_hash, role FROM arrahnu_staff_users WHERE email=$1', [email]);
  if (!q.rows.length) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const u = q.rows[0];
  const valid = await bcrypt.compare(password, u.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const token = jwt.sign({ role: u.role, email: u.email }, JWT_SECRET, { expiresIn: '7d' });
  await logAudit(u.email, 'auth.login', u.email, { role: u.role });
  res.json({ ok: true, token, user: { email: u.email, role: u.role } });
});

app.get('/auth/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

app.post('/staff/create', auth, adminOnly, async (req, res) => {
  const { email, password, role = 'staff' } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email/password required' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`INSERT INTO arrahnu_staff_users (email, password_hash, role) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`, [email, hash, role]);
  await logAudit(req.user.email, 'staff.upsert', email, { role });
  res.json({ ok: true });
});

app.get('/staff/list', auth, adminOnly, async (req, res) => {
  const q = await pool.query('SELECT email, role, created_at FROM arrahnu_staff_users ORDER BY created_at DESC');
  res.json({ ok: true, staff: q.rows });
});

app.post('/staff/change-password', auth, async (req, res) => {
  const { email, oldPassword, newPassword } = req.body || {};
  const targetEmail = email || req.user.email;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, error: 'newPassword min 6 chars' });
  if (req.user.role !== 'admin' && targetEmail !== req.user.email) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const q = await pool.query('SELECT email, password_hash FROM arrahnu_staff_users WHERE email=$1', [targetEmail]);
  if (!q.rows.length) return res.status(404).json({ ok: false, error: 'Staff not found' });

  if (req.user.role !== 'admin') {
    const ok = await bcrypt.compare(oldPassword || '', q.rows[0].password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'oldPassword salah' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE arrahnu_staff_users SET password_hash=$1 WHERE email=$2', [hash, targetEmail]);
  await logAudit(req.user.email, 'staff.change_password', targetEmail);
  res.json({ ok: true });
});

app.get('/audit/recent', auth, adminOnly, async (req, res) => {
  const q = await pool.query('SELECT id, actor_email, action, target, meta, created_at FROM arrahnu_audit_logs ORDER BY id DESC LIMIT 200');
  res.json({ ok: true, logs: q.rows });
});

app.get('/health', async (req, res) => {
  const q = await pool.query('SELECT NOW() as now');
  res.json({ ok: true, dbTime: q.rows[0].now });
});

app.post('/arrahnu/sync', auth, async (req, res) => {
  const { records = [], pendingOps = [], clientTs } = req.body || {};
  const clientId = req.header('x-client-id') || req.user.email;
  await pool.query(`INSERT INTO arrahnu_clients (client_id, records, pending_ops, updated_at, client_ts) VALUES ($1,$2::jsonb,$3::jsonb,NOW(),$4)
     ON CONFLICT (client_id) DO UPDATE SET records=EXCLUDED.records,pending_ops=EXCLUDED.pending_ops,updated_at=NOW(),client_ts=EXCLUDED.client_ts`, [clientId, JSON.stringify(records), JSON.stringify(pendingOps), clientTs || null]);
  await logAudit(req.user.email, 'sync.push', clientId, { recordsCount: records.length, opsCount: pendingOps.length });
  res.json({ ok: true, syncedAt: Date.now(), recordsCount: records.length, opsCount: pendingOps.length });
});

app.get('/arrahnu/sync/:clientId', auth, async (req, res) => {
  const q = await pool.query('SELECT client_id, records, pending_ops, updated_at, client_ts FROM arrahnu_clients WHERE client_id=$1', [req.params.clientId]);
  if (!q.rows.length) return res.status(404).json({ ok: false, error: 'Client not found' });
  res.json({ ok: true, data: q.rows[0] });
});

app.post('/arrahnu/subscribe', auth, async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  await pool.query(`INSERT INTO arrahnu_subscriptions (endpoint, subscription, updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (endpoint) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=NOW()`, [subscription.endpoint, JSON.stringify(subscription)]);
  await logAudit(req.user.email, 'push.subscribe', subscription.endpoint);
  const c = await pool.query('SELECT COUNT(*)::int AS total FROM arrahnu_subscriptions');
  res.json({ ok: true, totalSubscriptions: c.rows[0].total });
});

app.post('/arrahnu/push-test', auth, async (req, res) => {
  const { title = 'Ar-Rahnu Reminder', body = 'Ini notifikasi ujian', url = '/timun-sales-page/ar-rahnu/' } = req.body || {};
  const payload = JSON.stringify({ title, body, url });
  const q = await pool.query('SELECT endpoint, subscription FROM arrahnu_subscriptions');
  const results = await Promise.allSettled(q.rows.map((r) => webpush.sendNotification(r.subscription, payload)));
  let sent = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') sent++; else failed++;
  }
  await logAudit(req.user.email, 'push.test', null, { sent, failed, total: results.length });
  res.json({ ok: true, sent, failed, total: results.length });
});

app.get('/arrahnu/vapid-public-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' }));

initDb().then(() => app.listen(PORT, () => console.log(`Ar-Rahnu backend running on :${PORT}`))).catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});