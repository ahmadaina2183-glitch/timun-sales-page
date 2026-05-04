# Ar-Rahnu Backend Template

## Quick start
```bash
cd ar-rahnu-backend
cp .env.example .env
npm install
npm run dev
```

## Generate VAPID key
```bash
npx web-push generate-vapid-keys
```
Paste into `.env`.

## Endpoints
- `GET /health`
- `POST /arrahnu/sync`
- `POST /arrahnu/subscribe`
- `POST /arrahnu/push-test`
- `GET /arrahnu/vapid-public-key`

## Notes
Template ini simpan data in-memory (akan hilang bila restart). Untuk production, sambung ke database (PostgreSQL/MySQL/MongoDB).
