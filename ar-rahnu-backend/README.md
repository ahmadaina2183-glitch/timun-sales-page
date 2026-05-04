# Ar-Rahnu Backend (Production Template)

Backend production-ready asas menggunakan **Express + PostgreSQL + JWT Staff Auth + Web Push**.

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
- `STAFF_PASSWORD` (atau `STAFF_PASSWORD_HASH`)
- `JWT_SECRET`

## 5) Run
```bash
npm run dev
```

## Endpoint
- `POST /auth/login`
- `GET /auth/me`
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
