import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import sharp from 'sharp';
import exifr from 'exifr';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || '/images';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

// 测试模式：不设置 token 时允许删除（不安全）。生产环境强烈建议设置 UPLOAD_TOKEN。

const THUMBS_SUBDIR = '.thumbs';
const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '480', 10) || 480;
const THUMB_QUALITY = parseInt(process.env.THUMB_QUALITY || '70', 10) || 70;

// EXIF + geocoding caches
const exifCache = new Map(); // key: absPath|mtimeMs -> { takenAt, gps }
const geoCache = new Map();  // key: "lat,lon" -> place string

const exts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

function isImageFile(p) {
  return exts.has(path.extname(p).toLowerCase());
}

function safeJoin(base, target) {
  const targetPath = path.normalize(target).replace(/^([/\\])+/, '');
  const full = path.join(base, targetPath);
  if (!full.startsWith(path.normalize(base))) return null;
  return full;
}

function thumbPathFor(imageAbs) {
  const dir = path.dirname(imageAbs);
  const base = path.basename(imageAbs);
  const thumbsDir = path.join(dir, THUMBS_SUBDIR);
  const outName = base + '.w' + THUMB_WIDTH + '.q' + THUMB_QUALITY + '.webp';
  const outAbs = path.join(thumbsDir, outName);
  return { thumbsDir, outAbs, outName };
}

async function ensureThumb(imageAbs) {
  const { thumbsDir, outAbs } = thumbPathFor(imageAbs);

  // 已存在就直接复用
  try {
    const st = fs.statSync(outAbs);
    if (st.isFile() && st.size > 0) return outAbs;
  } catch {}

  fs.mkdirSync(thumbsDir, { recursive: true });

  // 生成缩略图（webp）
  await sharp(imageAbs)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toFile(outAbs);

  return outAbs;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const subdir = (req.query.dir || '').toString();
      const abs = safeJoin(IMAGES_DIR, subdir);
      if (!abs) return cb(new Error('bad dir'));
      try {
        fs.mkdirSync(abs, { recursive: true });
        return cb(null, abs);
      } catch (e) {
        return cb(e);
      }
    },
    filename: (req, file, cb) => {
      // 尽量保留原文件名（去掉路径），并做一个很轻的清洗
      const base = path.basename(file.originalname || 'upload');
      const clean = base.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_');
      cb(null, clean);
    }
  }),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB/张（可调）
    files: 50
  }
});

app.post('/api/upload', upload.array('files', 50), (req, res) => {
  if (UPLOAD_TOKEN) {
    const token = (req.headers['x-upload-token'] || req.body?.token || '').toString();
    if (token !== UPLOAD_TOKEN) return res.status(401).json({ error: 'bad token' });
  }

  const files = (req.files || []).map(f => ({
    name: f.filename,
    size: f.size,
  }));
  res.json({ ok: true, uploaded: files.length, files });
});

app.get('/api/thumb', async (req, res) => {
  const subdir = (req.query.dir || '').toString();
  const name = (req.query.name || '').toString();

  const dirAbs = safeJoin(IMAGES_DIR, subdir);
  if (!dirAbs) return res.status(400).json({ error: 'bad dir' });

  const imageAbs = safeJoin(dirAbs, name);
  if (!imageAbs) return res.status(400).json({ error: 'bad name' });

  try {
    if (!fs.existsSync(imageAbs)) return res.status(404).end();

    // svg/gif 之类不做缩略图（避免复杂），直接返回原图
    const ext = path.extname(name).toLowerCase();
    if (ext === '.svg' || ext === '.gif') {
      return res.sendFile(imageAbs);
    }

    const thumbAbs = await ensureThumb(imageAbs);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(thumbAbs);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post('/api/delete', express.json({ limit: '1mb' }), (req, res) => {
  // 简单鉴权：如果设置了 UPLOAD_TOKEN，则删除也必须带 token
  if (UPLOAD_TOKEN) {
    const token = (req.headers['x-upload-token'] || req.body?.token || '').toString();
    if (token !== UPLOAD_TOKEN) return res.status(401).json({ error: 'bad token' });
  }

  // NOTE: frontend historically passed dir via querystring; accept both for compatibility.
  const subdir = ((req.body?.dir ?? req.query?.dir) || '').toString();
  const names = Array.isArray(req.body?.names) ? req.body.names.map(String) : [];

  const dirAbs = safeJoin(IMAGES_DIR, subdir);
  if (!dirAbs) return res.status(400).json({ error: 'bad dir' });

  const deleted = [];
  const failed = [];

  for (const name of names) {
    try {
      const imageAbs = safeJoin(dirAbs, name);
      if (!imageAbs) throw new Error('bad name');

      // 删原图
      if (fs.existsSync(imageAbs)) fs.unlinkSync(imageAbs);

      // 删缩略图（如果存在）
      try {
        const { outAbs } = thumbPathFor(imageAbs);
        if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
      } catch {}

      deleted.push(name);
    } catch (e) {
      failed.push({ name, error: String(e) });
    }
  }

  res.json({ ok: true, deleted, failed });
});

app.get('/api/images', async (req, res) => {
  const subdir = (req.query.dir || '').toString();
  const abs = safeJoin(IMAGES_DIR, subdir);
  if (!abs) return res.status(400).json({ error: 'bad dir' });

  const offset = Math.max(0, parseInt((req.query.offset ?? '0').toString(), 10) || 0);
  const limitRaw = parseInt((req.query.limit ?? '120').toString(), 10) || 120;
  const limit = Math.max(1, Math.min(500, limitRaw));

  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });

    const dirs = [];
    const allFiles = [];

    for (const e of entries) {
      if (e.isDirectory()) {
        // 跳过缩略图目录
        if (e.name === THUMBS_SUBDIR) continue;
        dirs.push(e.name);
      } else if (e.isFile() && isImageFile(e.name)) {
        const rel = path.posix.join('/', subdir.split(path.sep).join('/'), e.name).replace(/\\/g, '/');
        allFiles.push({
          name: e.name,
          url: `/images${rel}`,
          thumbUrl: `/api/thumb?dir=${encodeURIComponent(subdir)}&name=${encodeURIComponent(e.name)}`,
        });
      }
    }

    dirs.sort((a, b) => a.localeCompare(b));
    allFiles.sort((a, b) => a.name.localeCompare(b.name));

    const total = allFiles.length;
    const files = allFiles.slice(offset, offset + limit);
    const nextOffset = Math.min(total, offset + files.length);
    const hasMore = nextOffset < total;

    res.json({ dir: subdir, dirs, files, total, offset, limit, nextOffset, hasMore });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/meta', async (req, res) => {
  const subdir = (req.query.dir || '').toString();
  const name = (req.query.name || '').toString();
  const absDir = safeJoin(IMAGES_DIR, subdir);
  if (!absDir) return res.status(400).json({ error: 'bad dir' });
  const imageAbs = safeJoin(absDir, name);
  if (!imageAbs) return res.status(400).json({ error: 'bad name' });

  try {
    const st = fs.statSync(imageAbs);
    const cacheKey = imageAbs + '|' + st.mtimeMs;
    if (exifCache.has(cacheKey)) {
      return res.json({ ok: true, ...exifCache.get(cacheKey) });
    }

    let takenAt = null;
    let gps = null;
    try {
      const exif = await exifr.parse(imageAbs, { tiff: true, exif: true, gps: true });
      if (exif) {
        const dt = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
        if (dt) takenAt = (dt instanceof Date) ? dt.toISOString() : String(dt);
        if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
          gps = { lat: exif.latitude, lon: exif.longitude };
        }
      }
    } catch {}

    // fallback: filesystem mtime
    if (!takenAt) takenAt = new Date(st.mtimeMs).toISOString();

    let place = null;
    if (gps) {
      const key = gps.lat.toFixed(3) + ',' + gps.lon.toFixed(3);
      if (geoCache.has(key)) {
        place = geoCache.get(key);
      } else {
        try {
          const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + encodeURIComponent(gps.lat) + '&lon=' + encodeURIComponent(gps.lon);
          const r = await fetch(url, {
            headers: {
              'User-Agent': 'image-gallery/1.0 (reverse-geocode; contact=local)'
            }
          });
          if (r.ok) {
            const j = await r.json();
            place = j.display_name || null;
            geoCache.set(key, place);
          }
        } catch {}
      }
    }

    const out = { takenAt, gps, place };
    exifCache.set(cacheKey, out);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.use('/images', express.static(IMAGES_DIR, {
  fallthrough: false,
  maxAge: '1h'
}));

// Serve SPA frontend from ./public
// (index.html + assets/app.js + assets/styles.css)
const BUILD_ID = process.env.BUILD_ID || 'dev';

app.get('/api/config', (req, res) => {
  res.json({ buildId: BUILD_ID, autoplayMs: 3000 });
});

// Avoid stale frontend on mobile/desktop browsers & reverse proxies
app.use((req, res, next) => {
  const p = req.path || '';
  if (req.method === 'GET' && (p === '/' || p.endsWith('.html') || p.startsWith('/assets/'))) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), {
  maxAge: 0,
  setHeaders(res){
    res.setHeader('Cache-Control', 'no-store');
  }
}));
// Serve index.html with BUILD_ID injected for cache-busting
app.get('/', (req, res) => {
  try {
    const p = path.join(__dirname, 'public', 'index.html');
    const html = fs.readFileSync(p, 'utf8').replaceAll('__BUILD_ID__', BUILD_ID);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (e) {
    res.status(500).send('index render failed');
  }
});

app.use('/', express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: 0,
  setHeaders(res){
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Image Gallery listening on :${PORT}`);
  console.log(`Serving images from ${IMAGES_DIR}`);
});
