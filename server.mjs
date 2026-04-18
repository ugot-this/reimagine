// Reimagine — Gemini NanoBanana 2 proxy server
// Serves the static frontend and proxies image-generation requests to Google's
// generative-language API. The API key never leaves the server.

import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from the same directory as this server file, regardless of CWD.
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 4173;
const API_KEY = process.env.GEMINI_API_KEY;
// Gemini image-generation model — "NanoBanana 2" refers to the Gemini 2.5
// Flash Image model family. Override via env if you're using a different variant.
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- Static frontend ----------
app.use(express.static(__dirname, { extensions: ['html'] }));

// ---------- Image generation proxy ----------
app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.',
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded.' });
  }

  const { mode = 'restore', output = 'preview', system_prompt = '', prompt = '' } = req.body;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: req.file.mimetype || 'image/jpeg',
              data: req.file.buffer.toString('base64'),
            },
          },
        ],
      },
    ],
    // The system prompt drives content-aware enhancement (portrait / product / low-quality).
    ...(system_prompt && {
      systemInstruction: { role: 'system', parts: [{ text: system_prompt }] },
    }),
    generationConfig: {
      responseModalities: ['IMAGE'],
      // Preview is optimized for speed; final is optimized for quality.
      temperature: output === 'final' ? 0.4 : 0.6,
    },
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('[Gemini] API error', r.status, text);
      return res.status(r.status).json({ error: 'Upstream API error', detail: text });
    }

    const json = await r.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inline_data || p.inlineData);
    const inline = imagePart?.inline_data || imagePart?.inlineData;

    if (!inline?.data) {
      console.error('[Gemini] No image in response', JSON.stringify(json).slice(0, 500));
      return res.status(502).json({ error: 'No image returned by model.' });
    }

    const mime = inline.mime_type || inline.mimeType || 'image/png';
    return res.json({
      mime,
      data: inline.data, // base64
      output,
      mode,
      model: MODEL,
    });
  } catch (err) {
    console.error('[Gemini] Request failed', err);
    return res.status(500).json({ error: 'Request failed', detail: String(err) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, keyConfigured: Boolean(API_KEY) });
});

app.listen(PORT, () => {
  console.log(`\n  Reimagine → http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  API key: ${API_KEY ? 'configured ✓' : 'MISSING — set GEMINI_API_KEY in .env'}\n`);
});
