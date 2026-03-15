# vibra

A minimalist, end-to-end encrypted realtime chat with file sharing.  
Keys are generated in the browser — the server never sees your plaintext or private keys.

---

## How the encryption works

```
Alice                          Server                          Bob
  │                              │                              │
  │  generate ECDH P-256 keypair │                              │
  │  send public key on join ───>│  relay public keys ─────────>│
  │                              │                              │  generate ECDH P-256 keypair
  │<─────────────────────────────│  relay public keys ──────────│  send public key on join
  │                              │                              │
  │  ECDH(Alice.private,         │                              │  ECDH(Bob.private,
  │       Bob.public)            │                              │       Alice.public)
  │  → shared secret             │                              │  → same shared secret
  │  HKDF-SHA-256                │                              │  HKDF-SHA-256
  │  → AES-256-GCM key           │                              │  → AES-256-GCM key
  │                              │                              │
  │  encrypt(plaintext) ────────>│  relay ciphertext ──────────>│  decrypt(ciphertext)
  │                              │  (server sees only bytes)    │
```

**The server only relays ciphertext.** It never has access to private keys, shared secrets, or plaintext messages.

### Stack

| Layer        | Technology                             |
|--------------|----------------------------------------|
| Key exchange | ECDH P-256 (Web Crypto API)            |
| Key derivation | HKDF-SHA-256                         |
| Cipher       | AES-256-GCM                            |
| Transport    | Socket.IO (WebSocket)                  |
| File upload  | Multer (Express)                       |
| Server       | Node.js + Express                      |
| Frontend     | Vanilla HTML / CSS / JS (no framework) |

---

## Getting started

### Local development

```bash
npm install
npm start
# open http://localhost:3000
```

```bash
# Auto-restart on file changes
npm run dev
```

---

## Deploy to Railway

> **Why Railway?** Vercel and Netlify are serverless — they kill connections after ~10s and don't support WebSocket. Railway runs your app as a persistent process, which is what Socket.IO requires.

### Option A — GitHub (recommended)

1. Push this project to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/vibra.git
   git push -u origin main
   ```

2. Go to **[railway.app](https://railway.app)** → sign in with GitHub.

3. Click **New Project → Deploy from GitHub repo** → select your repo.

4. Railway auto-detects Node.js and runs `npm start`. No config needed.

5. Go to your service → **Settings → Networking → Generate Domain**.
   You'll get a URL like `vibra.up.railway.app` with HTTPS + WSS already set up.

6. Open the URL — vibra is live.

### Option B — Railway CLI

```bash
# Install CLI
npm install -g @railway/cli

# Login
railway login

# Create project and deploy
railway init
railway up

# Get public URL
railway domain
```

### Environment variables

| Variable | Value | Notes |
|----------|-------|-------|
| `PORT`   | auto  | Set by Railway automatically — do not override |

To add custom variables: Railway dashboard → project → **Variables** tab.

### Notes

- `PORT` is injected by Railway automatically. The app reads `process.env.PORT`.
- Server binds to `0.0.0.0` so Railway's reverse proxy can reach it.
- HTTPS and WSS are handled by Railway's proxy — your app speaks plain HTTP internally.
- Free Hobby plan: 500 hours/month — plenty for a personal project.
- Uploaded files live in the container filesystem and reset on redeploy. For persistent uploads, add a Railway Volume or connect an S3-compatible bucket.

---

## File sharing

Files are uploaded to the server and served statically. Supported types:

| Category | Formats               | Max size |
|----------|-----------------------|----------|
| Image    | JPG, PNG, GIF, WebP   | 20 MB    |
| Audio    | MP3, OGG, WAV, FLAC   | 20 MB    |
| Video    | MP4, WebM, OGG        | 20 MB    |
| Document | PDF, TXT, ZIP, DOCX   | 20 MB    |

> Note: files are not end-to-end encrypted in transit to the server in this version.  
> For full file E2E, encrypt the ArrayBuffer with AES-GCM before uploading and share the file key over the existing encrypted channel.

---

## Project structure

```
vibra/
├── server.js          # Express + Socket.IO relay server
├── package.json
├── README.md
├── uploads/           # Created automatically on first run
└── public/
    └── index.html     # Single-file frontend (HTML + CSS + JS)
```

---

## Environment variables

| Variable | Default | Description  |
|----------|---------|--------------|
| `PORT`   | `3000`  | Listening port |

```bash
PORT=8080 npm start
```

---

## Security notes

- Private keys never leave the browser.
- The server relays only JWK **public** keys and opaque ciphertexts.
- All data is ephemeral — no database, no logs. A server restart clears everything.
- For production, always serve over **HTTPS / WSS** to protect the public key exchange from MITM.
- Group key is derived by XOR-combining all pairwise ECDH shared keys. For larger groups, consider a proper group key agreement protocol.

---

`vibra · ecdh · aes-256-gcm · zero logs`
