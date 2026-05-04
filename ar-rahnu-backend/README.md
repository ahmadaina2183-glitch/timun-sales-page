# Ar-Rahnu Backend (Production Template)

Backend production-ready asas menggunakan **Express + PostgreSQL + Web Push**.

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

## 4) Run
```bash
npm run dev
```

## Endpoint
- `GET /health`
- `POST /arrahnu/sync`
- `GET /arrahnu/sync/:clientId`
- `POST /arrahnu/subscribe`
- `POST /arrahnu/push-test`
- `GET /arrahnu/vapid-public-key`

## Integrasi Frontend
Dalam web app Ar-Rahnu:
- `API Base URL` = domain backend ni
- `VAPID Public Key` = key public dari backend
