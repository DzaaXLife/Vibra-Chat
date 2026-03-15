'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const crypto     = require('crypto');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 25e6
});

const PORT       = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE   = 20 * 1024 * 1024; // 20 MB

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── MULTER ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => {
    const id  = crypto.randomBytes(10).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  }
});

const ALLOWED_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
  'audio/mpeg','audio/ogg','audio/wav','audio/webm','audio/flac','audio/aac',
  'video/mp4','video/webm','video/ogg',
  'application/pdf','text/plain','application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE },
  fileFilter: (_, file, cb) =>
    ALLOWED_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('File type not permitted'))
});

// ── STATIC ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.json());

// ── STATE ──────────────────────────────────────────────────────────────
// rooms: Map<roomName, { users: Map<socketId, {userId,username,pubKey}> }>
// Server never stores or derives the encryption key — it only relays
// ECDH public keys and encrypted payloads.
const rooms = new Map();
const users = new Map();

const uid = () => crypto.randomBytes(8).toString('hex').toUpperCase();

// ── FILE UPLOAD ────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({
    url:          `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    mimetype:     req.file.mimetype,
    size:         req.file.size,
    fileType:     fileCategory(req.file.mimetype)
  });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

function fileCategory(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// ── SOCKET ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = uid();
  users.set(socket.id, { userId, username: null, room: null, pubKey: null });
  console.log(`[+] ${userId} connected`);

  // ── JOIN ──────────────────────────────────────────────────────────
  socket.on('join_room', ({ username, room, pubKey }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Leave previous room
    if (user.room) {
      leaveRoom(socket, user);
    }

    // Create room if absent
    if (!rooms.has(room)) {
      rooms.set(room, { users: new Map() });
    }

    const roomData = rooms.get(room);
    const cleanName = (username || '').trim().slice(0, 20) || `user_${userId.slice(0, 6)}`;

    user.username = cleanName;
    user.room     = room;
    user.pubKey   = pubKey; // ECDH public key (JWK, sent by client)
    users.set(socket.id, user);
    roomData.users.set(socket.id, user);
    socket.join(room);

    // Send existing peers' public keys to the newcomer
    const peers = [];
    for (const [sid, peer] of roomData.users) {
      if (sid !== socket.id && peer.pubKey) {
        peers.push({ userId: peer.userId, username: peer.username, pubKey: peer.pubKey });
      }
    }

    socket.emit('room_joined', {
      userId,
      room,
      userCount: roomData.users.size,
      peers      // existing peers so newcomer can derive shared secrets
    });

    // Announce newcomer's public key to existing peers
    socket.to(room).emit('peer_joined', {
      userId:   user.userId,
      username: cleanName,
      pubKey
    });

    io.to(room).emit('user_count', roomData.users.size);
    io.to(room).emit('system', { text: `${cleanName} joined`, type: 'join' });
    console.log(`[>] ${cleanName} → room "${room}" (${roomData.users.size} online)`);
  });

  // ── TEXT MESSAGE (encrypted payload — server never decrypts) ──────
  socket.on('message', ({ ciphertext, iv, recipientId, checksum }) => {
    const user = users.get(socket.id);
    if (!user?.room) return;

    // Integrity: checksum is sha256(ciphertext + sender userId).slice(0,8)
    // Server validates structure only — cannot verify content (no key)
    if (typeof ciphertext !== 'string' || typeof iv !== 'string') return;

    io.to(user.room).emit('message', {
      id:         crypto.randomBytes(4).toString('hex'),
      senderId:   user.userId,
      username:   user.username,
      ciphertext,
      iv,
      recipientId,  // null = broadcast to room, string = DM target userId
      checksum,
      timestamp:  Date.now()
    });
  });

  // ── FILE MESSAGE ──────────────────────────────────────────────────
  socket.on('file_message', (payload) => {
    const user = users.get(socket.id);
    if (!user?.room) return;
    io.to(user.room).emit('file_message', {
      id:        crypto.randomBytes(4).toString('hex'),
      senderId:  user.userId,
      username:  user.username,
      timestamp: Date.now(),
      ...payload
    });
  });

  // ── TYPING ────────────────────────────────────────────────────────
  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user?.room) return;
    socket.to(user.room).emit('typing', { username: user.username, isTyping });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user?.room) leaveRoom(socket, user);
    users.delete(socket.id);
    console.log(`[-] ${user?.userId || socket.id} disconnected`);
  });
});

function leaveRoom(socket, user) {
  const roomData = rooms.get(user.room);
  if (roomData) {
    roomData.users.delete(socket.id);
    io.to(user.room).emit('system', { text: `${user.username} left`, type: 'leave' });
    io.to(user.room).emit('user_count', roomData.users.size);
    io.to(user.room).emit('peer_left', { userId: user.userId });
    if (roomData.users.size === 0) rooms.delete(user.room);
  }
  socket.leave(user.room);
}

// ── STATS ──────────────────────────────────────────────────────────────
app.get('/api/stats', (_, res) => res.json({
  rooms: rooms.size,
  users: users.size,
  uptime: Math.floor(process.uptime())
}));

// Trust Railway's reverse proxy (needed for HTTPS headers)
app.set('trust proxy', 1);

// ── LISTEN ────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
┌──────────────────────────────────────┐
│           vibra chat server           │
│  port ${PORT}  ·  ECDH + AES-256-GCM  │
│  server never sees plaintext keys     │
└──────────────────────────────────────┘
`);
});
