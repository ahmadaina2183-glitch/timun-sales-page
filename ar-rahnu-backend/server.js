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
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_staff_users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', token_version INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_audit_logs (id BIGSERIAL PRIMARY KEY, actor_email TEXT, action TEXT NOT NULL, target TEXT, meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_app_users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, full_name TEXT, sub_plan TEXT, sub_start DATE, sub_expire DATE, is_active BOOLEAN NOT NULL DEFAULT TRUE, token_version INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`ALTER TABLE arrahnu_app_users ADD COLUMN IF NOT EXISTS sub_plan TEXT;`);
  await pool.query(`ALTER TABLE arrahnu_app_users ADD COLUMN IF NOT EXISTS sub_start DATE;`);
  await pool.query(`ALTER TABLE arrahnu_app_users ADD COLUMN IF NOT EXISTS sub_expire DATE;`);
  await pool.query(`ALTER TABLE arrahnu_app_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arrahnu_password_resets (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);

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

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const table = payload.role === 'user' ? 'arrahnu_app_users' : 'arrahnu_staff_users';
    const q = await pool.query(`SELECT token_version FROM ${table} WHERE email=$1`, [payload.email]);
    if (!q.rows.length) return res.status(401).json({ ok: false, error: 'User not found' });
    if ((payload.tokenVersion ?? 0) !== q.rows[0].token_version) return res.status(401).json({ ok: false, error: 'Session revoked' });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}
function adminOnly(req,res,next){ if(req.user?.role!=='admin') return res.status(403).json({ok:false,error:'Admin only'}); next(); }
function staffOrAdmin(req,res,next){ if(!['staff','admin'].includes(req.user?.role)) return res.status(403).json({ok:false,error:'Staff/Admin only'}); next(); }

app.post('/auth/register-user', async (req, res) => {
  const { email = '', password = '', fullName = '' } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email/password required' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'password min 6 chars' });

  const exists = await pool.query('SELECT email FROM arrahnu_app_users WHERE email=$1', [email]);
  if (exists.rows.length) return res.status(409).json({ ok: false, error: 'Email dah wujud' });

  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO arrahnu_app_users (email, password_hash, full_name) VALUES ($1,$2,$3)', [email, hash, fullName || null]);
  await logAudit(email, 'user.register', email);
  res.json({ ok: true });
});

app.post('/auth/request-password-reset', async (req, res) => {
  const { email = '' } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'email required' });

  const exists = await pool.query('SELECT email FROM arrahnu_app_users WHERE email=$1', [email]);
  if (!exists.rows.length) return res.json({ ok: true, message: 'Jika email wujud, kod reset dihantar.' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await pool.query(
    `INSERT INTO arrahnu_password_resets (email, code, expires_at, updated_at)
     VALUES ($1,$2,NOW() + INTERVAL '15 minutes', NOW())
     ON CONFLICT (email) DO UPDATE SET code=EXCLUDED.code, expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [email, code]
  );
  await logAudit(email, 'user.request_reset', email);

  // Template mode: return code directly (for production, send by email/SMS)
  res.json({ ok: true, resetCode: code, message: 'Kod reset dijana (template mode).' });
});

app.post('/auth/confirm-password-reset', async (req, res) => {
  const { email = '', code = '', newPassword = '' } = req.body || {};
  if (!email || !code || !newPassword) return res.status(400).json({ ok: false, error: 'email/code/newPassword required' });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'newPassword min 6 chars' });

  const q = await pool.query('SELECT code, expires_at FROM arrahnu_password_resets WHERE email=$1', [email]);
  if (!q.rows.length) return res.status(400).json({ ok: false, error: 'Kod reset tiada' });
  const rec = q.rows[0];
  if (String(rec.code) !== String(code)) return res.status(400).json({ ok: false, error: 'Kod reset salah' });
  if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ ok: false, error: 'Kod reset expired' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE arrahnu_app_users SET password_hash=$1, token_version=token_version+1 WHERE email=$2', [hash, email]);
  await pool.query('DELETE FROM arrahnu_password_resets WHERE email=$1', [email]);
  await logAudit(email, 'user.confirm_reset', email);
  res.json({ ok: true });
});

app.post('/auth/login-user', async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const q = await pool.query('SELECT email, password_hash, full_name, token_version FROM arrahnu_app_users WHERE email=$1', [email]);
  if (!q.rows.length) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const u = q.rows[0];
  const valid = await bcrypt.compare(password, u.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const token = jwt.sign({ role: 'user', email: u.email, fullName: u.full_name || '', tokenVersion: u.token_version || 0 }, JWT_SECRET, { expiresIn: '7d' });
  await logAudit(u.email, 'user.login', u.email);
  res.json({ ok: true, token, user: { email: u.email, role: 'user', fullName: u.full_name || '' } });
});

app.post('/auth/login', async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const q = await pool.query('SELECT email, password_hash, role, token_version FROM arrahnu_staff_users WHERE email=$1', [email]);
  if (!q.rows.length) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const u = q.rows[0];
  const valid = await bcrypt.compare(password, u.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Login gagal' });

  const token = jwt.sign({ role: u.role, email: u.email, tokenVersion: u.token_version || 0 }, JWT_SECRET, { expiresIn: '7d' });
  await logAudit(u.email, 'auth.login', u.email, { role: u.role });
  res.json({ ok: true, token, user: { email: u.email, role: u.role } });
});

app.get('/auth/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

app.post('/auth/reset-password', auth, async (req, res) => {
  const { oldPassword = '', newPassword = '' } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, error: 'newPassword min 6 chars' });

  const table = req.user.role === 'user' ? 'arrahnu_app_users' : 'arrahnu_staff_users';
  const q = await pool.query(`SELECT email, password_hash FROM ${table} WHERE email=$1`, [req.user.email]);
  if (!q.rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

  const ok = await bcrypt.compare(oldPassword, q.rows[0].password_hash);
  if (!ok) return res.status(401).json({ ok: false, error: 'oldPassword salah' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE ${table} SET password_hash=$1 WHERE email=$2`, [hash, req.user.email]);
  await logAudit(req.user.email, 'auth.reset_password', req.user.email);
  res.json({ ok: true });
});

app.post('/auth/logout-all', auth, async (req, res) => {
  const table = req.user.role === 'user' ? 'arrahnu_app_users' : 'arrahnu_staff_users';
  await pool.query(`UPDATE ${table} SET token_version = token_version + 1 WHERE email=$1`, [req.user.email]);
  await logAudit(req.user.email, 'auth.logout_all', req.user.email);
  res.json({ ok: true, message: 'All devices logged out' });
});

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

app.delete('/staff/:email', auth, adminOnly, async (req, res) => {
  const email = req.params.email;
  if (email === req.user.email) return res.status(400).json({ ok: false, error: 'Tak boleh padam diri sendiri' });
  await pool.query('DELETE FROM arrahnu_staff_users WHERE email=$1', [email]);
  await logAudit(req.user.email, 'staff.delete', email);
  res.json({ ok: true });
});

app.get('/users/list', auth, staffOrAdmin, async (req, res) => {
  const q = await pool.query('SELECT email, full_name, sub_plan, sub_start, sub_expire, is_active, created_at FROM arrahnu_app_users ORDER BY created_at DESC');
  res.json({ ok: true, users: q.rows });
});

app.post('/users/create', auth, staffOrAdmin, async (req, res) => {
  const { email = '', fullName = '', password = 'User@1234', subPlan = 'basic', subStart = null, subExpire = null, isActive = true } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'email required' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`INSERT INTO arrahnu_app_users (email, full_name, password_hash, sub_plan, sub_start, sub_expire, is_active)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                    ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, sub_plan=EXCLUDED.sub_plan, sub_start=EXCLUDED.sub_start, sub_expire=EXCLUDED.sub_expire, is_active=EXCLUDED.is_active`,
    [email, fullName || null, hash, subPlan || null, subStart || null, subExpire || null, isActive]);
  await logAudit(req.user.email, 'user.upsert_staff', email);
  res.json({ ok: true });
});

app.delete('/users/:email', auth, staffOrAdmin, async (req, res) => {
  const email = req.params.email;
  await pool.query('DELETE FROM arrahnu_app_users WHERE email=$1', [email]);
  await logAudit(req.user.email, 'user.delete_admin', email);
  res.json({ ok: true });
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