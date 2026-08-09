/**
 * Dividr Mobile backend.
 *
 *   POST /api/invoke   request/response channels (ipcMain.handle equivalent)
 *   WS   /events       streaming channels (webContents.send equivalent)
 *   POST /api/upload   phone uploads media → stored under MEDIA_ROOT
 *   GET  /media/:name  serve uploaded media / render outputs back to the phone
 *
 * Run on a host with FFmpeg + Python (../../../requirements.txt) + the Claude CLI.
 */
import cors from 'cors';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { addClient } from './events';
import './handlers/index'; // registers all handlers as a side effect
import { invokeRoute } from './invokeRouter';
import { MEDIA_ROOT } from './handlers/files';

const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64mb' }));

// Request/response channels.
app.post('/api/invoke', invokeRoute);

// Media upload (phone → server). Field name: "file".
const upload = multer({ dest: MEDIA_ROOT });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file' });
    return;
  }
  // Keep the original filename so create-preview-url paths line up.
  const finalName = req.file.originalname || req.file.filename;
  const finalPath = path.join(MEDIA_ROOT, finalName);
  res.json({ success: true, path: finalPath, url: `/media/${encodeURIComponent(finalName)}` });
});

// Serve media + render outputs back to the phone.
app.use('/media', express.static(MEDIA_ROOT));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// Streaming channels over a single WebSocket.
const wss = new WebSocketServer({ server, path: '/events' });
wss.on('connection', (ws) => addClient(ws));

server.listen(PORT, () => {
  console.log(`[dividr-mobile] server on :${PORT}  (media root: ${MEDIA_ROOT})`);
});
