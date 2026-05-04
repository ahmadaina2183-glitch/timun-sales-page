# Ar-Rahnu Backend (Production Template)

Backend production-ready asas menggunakan **Express + PostgreSQL + JWT Staff Auth + Web Push + Audit Log**.

## 1) Setup
```bash
cd ar-rahnu-backend
cp .env.example .env
npm install
```

## 2) Sediakan PostgreSQL
- Create DB: `arrahnu`
- Jalankan schema:
```bash
psql "$DATABASE_URL" -f schema.sql
```

## 3) VAPID key (untuk push)
```bash
npx web-push generate-vapid-keys
```
Masukkan ke `.env`.

## 4) Staff Login config
Set dalam `.env`:
- `STAFF_EMAIL`
- `STAFF_PASSWORD`
- `JWT_SECRET`

Opsyen hash password:
```bash
npm run hash -- "passwordBaru"
```
Lepas tu guna endpoint `/staff/change-password` untuk rotate password.

## 5) Run (local)
```bash
npm run dev
```

## 6) Run (Docker production-style)
```bash
cp .env.example .env
# edit .env (ALLOWED_ORIGIN, JWT_SECRET, VAPID keys, STAFF credentials)
docker compose up -d --build
```

Selepas container up, apply schema (sekali je):
```bash
docker compose exec -T db psql -U postgres -d arrahnu < schema.sql
```

## Endpoint
- `POST /auth/register-user`
- `POST /auth/login-user`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/reset-password` (auth)
- `POST /auth/logout-all` (auth)
- `POST /staff/create` (admin)
- `GET /staff/list` (admin)
- `POST /staff/change-password` (auth)
- `GET /audit/recent` (admin)
- `GET /health`
- `POST /arrahnu/sync` (auth)
- `GET /arrahnu/sync/:clientId` (auth)
- `POST /arrahnu/subscribe` (auth)
- `POST /arrahnu/push-test` (auth)
- `GET /arrahnu/vapid-public-key`

## Integrasi Frontend
Dalam web app Ar-Rahnu:
- `API Base URL` = domain backend
- `VAPID Public Key` = key public
- Login staff dulu (auto-login disimpan di localStorage)
