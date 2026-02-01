import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import sharp from 'sharp';
import exifr from 'exifr';
import { createClient } from 'redis';
import crypto from 'crypto';
import { Readable } from 'node:stream';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || '/images';
// Upload/Delete are admin-only (cookie-based unlock).
const REDIS_URL = process.env.REDIS_URL || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

// Optional Redis cache (metadata only)
let redis = null;
async function initRedis(){
  if (!REDIS_URL) return null;
  try {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => {
      console.warn('redis error', String(err));
    });
    await redis.connect();
    console.log('Redis connected');
    return redis;
  } catch (e) {
    console.warn('Redis disabled:', String(e));
    try { if (redis) await redis.quit(); } catch {}
    redis = null;
    return null;
  }
}

function cacheKeyImages(subdir){
  const d = (subdir || '').toString();
  return 'ig:images:v2:' + d;
}
function cacheKeyLocalStats(){
  return 'ig:localstats:v1';
}
function cacheKeyMeta(imageAbs, mtimeMs){
  return 'ig:meta:v1:' + imageAbs + '|' + String(mtimeMs);
}
async function cacheGetJson(key){
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    if (!v) return null;
    return JSON.parse(v);
  } catch {
    return null;
  }
}
async function cacheSetJson(key, obj, ttlSec){
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(obj), { EX: ttlSec });
  } catch {}
}
async function invalidateImagesCache(subdir){
  if (!redis) return;
  const parts = (subdir || '').toString().split('/').filter(Boolean);
  const keys = new Set();
  keys.add(cacheKeyImages(''));
  // invalidate chain: a, a/b, a/b/c
  let cur = '';
  for (const p of parts) {
    cur = cur ? (cur + '/' + p) : p;
    keys.add(cacheKeyImages(cur));
  }
  // Also invalidate global local stats cache (counts can change).
  keys.add(cacheKeyLocalStats());
  try { await redis.del(Array.from(keys)); } catch {}
}

function hashToInt(str){
  let h = 2166136261;
  for (let i=0; i<str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededShuffle(arr, seedStr){
  const out = arr.slice();
  let s = hashToInt(seedStr || '0');
  // Fisher-Yates
  for (let i=out.length-1; i>0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

// 上传/删除等管理操作已统一为 ADMIN_PASS 解锁（cookie）控制。

function parseCookies(req){
  const h = (req.headers['cookie'] || '').toString();
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const [k, ...rest] = part.split('=');
    const key = (k || '').trim();
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

function signAdminToken(ts){
  const mac = crypto.createHmac('sha256', ADMIN_PASS);
  mac.update(String(ts));
  return mac.digest('hex');
}

function verifyAdminToken(token){
  try {
    const raw = Buffer.from(String(token), 'base64').toString('utf8');
    const [tsStr, sig] = raw.split('.', 2);
    const ts = parseInt(tsStr, 10);
    if (!ts || !sig) return false;
    // 30 days
    if (Date.now() - ts > 30*24*3600*1000) return false;
    const expected = signAdminToken(ts);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

function requireAdmin(req, res){
  if (!ADMIN_PASS) return true;

  // header (legacy)
  const p = (req.headers['x-admin-pass'] || '').toString();
  if (p === ADMIN_PASS) return true;

  // cookie session
  const cookies = parseCookies(req);
  const tok = cookies['gallery_admin'] || '';
  if (tok && verifyAdminToken(tok)) return true;

  res.status(401).json({ error: 'admin required' });
  return false;
}

// WebDAV feature removed

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

// For Immich upload: keep files in memory, then forward to Immich API
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 50
  }
});

app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const files = (req.files || []).map(f => ({
    name: f.filename,
    size: f.size,
  }));

  // invalidate cached directory listing
  const subdir = (req.query.dir || '').toString();
  await invalidateImagesCache(subdir);

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

app.post('/api/delete', express.json({ limit: '1mb' }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

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

  // invalidate cached directory listing
  await invalidateImagesCache(subdir);

  res.json({ ok: true, deleted, failed });
});

app.get('/api/images', async (req, res) => {
  const subdir = (req.query.dir || '').toString();
  const abs = safeJoin(IMAGES_DIR, subdir);
  if (!abs) return res.status(400).json({ error: 'bad dir' });

  const offset = Math.max(0, parseInt((req.query.offset ?? '0').toString(), 10) || 0);
  const limitRaw = parseInt((req.query.limit ?? '120').toString(), 10) || 120;
  const limit = Math.max(1, Math.min(500, limitRaw));

  const order = (req.query.order || '').toString();
  const seed = (req.query.seed || '').toString();

  try {
    // Try Redis cached listing first (metadata only)
    let cached = await cacheGetJson(cacheKeyImages(subdir));

    if (!cached) {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const dirs = [];
      const allFiles = [];

      for (const e of entries) {
        if (e.isDirectory()) {
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

      cached = { dir: subdir, dirs, allFiles, total: allFiles.length };
      // 30s is enough to absorb bursts while keeping directory changes responsive
      await cacheSetJson(cacheKeyImages(subdir), cached, 30);
    }

    const total = cached.total || (cached.allFiles ? cached.allFiles.length : 0);
    const baseAll = cached.allFiles || [];
    const dirs = cached.dirs || [];

    // random order (stable per request seed)
    const allFiles = (order === 'random') ? seededShuffle(baseAll, seed || String(Date.now())) : baseAll;

    const files = allFiles.slice(offset, offset + limit);
    const nextOffset = Math.min(total, offset + files.length);
    const hasMore = nextOffset < total;

    res.json({ dir: subdir, dirs, files, total, offset, limit, nextOffset, hasMore, cached: !!redis });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function computeLocalImageTotal(){
  // walk IMAGES_DIR recursively, excluding thumbs
  let totalImages = 0;
  const stack = [IMAGES_DIR];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === THUMBS_SUBDIR) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (isImageFile(e.name)) totalImages++;
      }
    }
  }
  return totalImages;
}

async function getLocalStats(){
  // Redis cache (short TTL) to avoid rescans
  const cached = await cacheGetJson(cacheKeyLocalStats());
  if (cached && typeof cached.totalImages === 'number') {
    return { totalImages: cached.totalImages, cached: true };
  }
  const totalImages = computeLocalImageTotal();
  const out = { totalImages };
  await cacheSetJson(cacheKeyLocalStats(), out, 60);
  return { totalImages, cached: false };
}

// Public: local images total (used by settings display)
app.get('/api/public/local-stats', async (req, res) => {
  try {
    const st = await getLocalStats();
    return res.json(st);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Admin-only: same stats (kept for potential future admin tooling)
app.get('/api/local/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const st = await getLocalStats();
    return res.json(st);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// --- likes (simple counters; optional, best-effort) ---
const LIKES_FILE = process.env.LIKES_FILE || path.join(IMAGES_DIR, '.likes.json');
let likesCache = null;
let likesCacheMtime = 0;
function readLikesFile(){
  try {
    if (!fs.existsSync(LIKES_FILE)) return {};
    const st = fs.statSync(LIKES_FILE);
    if (likesCache && likesCacheMtime === st.mtimeMs) return likesCache;
    const raw = fs.readFileSync(LIKES_FILE, 'utf8');
    const j = JSON.parse(raw || '{}');
    likesCache = (j && typeof j === 'object') ? j : {};
    likesCacheMtime = st.mtimeMs;
    return likesCache;
  } catch {
    return {};
  }
}
function writeLikesFile(obj){
  try {
    const dir = path.dirname(LIKES_FILE);
    fs.mkdirSync(dir, { recursive:true });
    const tmp = LIKES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, LIKES_FILE);
    try {
      const st = fs.statSync(LIKES_FILE);
      likesCache = obj;
      likesCacheMtime = st.mtimeMs;
    } catch {}
    return true;
  } catch {
    return false;
  }
}
function likeId(subdir, name){
  const d = (subdir || '').toString().replace(/^\/+/, '').replace(/\/+$/, '');
  return d ? (d + '/' + name) : name;
}

app.get('/api/likes', (req, res) => {
  const subdir = (req.query.dir || '').toString();
  const namesRaw = (req.query.names || '').toString();
  const names = namesRaw ? namesRaw.split(',').map(s => decodeURIComponent(s)).filter(Boolean) : [];
  const store = readLikesFile();
  const out = {};
  for (const n of names) {
    const key = likeId(subdir, n);
    const v = store[key];
    out[n] = (typeof v === 'number' && isFinite(v)) ? v : 0;
  }
  res.json({ ok:true, likes: out });
});

app.post('/api/like', express.json({ limit: '16kb' }), (req, res) => {
  const subdir = (req.body?.dir || '').toString();
  const name = (req.body?.name || '').toString();
  if (!name) return res.status(400).json({ error: 'bad name' });

  // Ensure the file exists
  const absDir = safeJoin(IMAGES_DIR, subdir);
  if (!absDir) return res.status(400).json({ error: 'bad dir' });
  const imageAbs = safeJoin(absDir, name);
  if (!imageAbs || !fs.existsSync(imageAbs)) return res.status(404).json({ error: 'not found' });

  const id = likeId(subdir, name);
  const store = readLikesFile();
  const cur = (typeof store[id] === 'number' && isFinite(store[id])) ? store[id] : 0;
  store[id] = cur + 1;
  writeLikesFile(store);
  res.json({ ok:true, name, count: store[id] });
});

// --- Immich endpoints (proxy; requires ADMIN_PASS) ---
const IMMICH_URL = process.env.IMMICH_URL || '';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';

// Public gallery config (persisted on disk)
const CONFIG_PATH = process.env.GALLERY_CONFIG_PATH || path.join(IMAGES_DIR, '.gallery_config.json');
function loadGalleryCfg(){
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}
function saveGalleryCfg(cfg){
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive:true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function immichCfgOk(){
  return !!(IMMICH_URL && IMMICH_API_KEY);
}
function immichHeaders(){
  return {
    'x-api-key': IMMICH_API_KEY,
    'Accept': 'application/json'
  };
}

async function immichJson(path){
  const url = IMMICH_URL.replace(/\/+$/,'') + path;
  const r = await fetch(url, { headers: immichHeaders() });
  if (!r.ok) throw new Error('immich ' + path + ' failed: ' + r.status);
  return r.json();
}

async function immichFetch(path, opts = {}){
  const url = IMMICH_URL.replace(/\/+$/,'') + path;
  const headers = Object.assign({}, immichHeaders(), (opts.headers || {}));
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  return r;
}

async function immichFetchJson(path, opts = {}){
  const r = await immichFetch(path, opts);
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, text, json: j };
}

async function immichStreamAny(res, candidates){
  // candidates: [{path, accept}]
  for (const c of candidates) {
    const url = IMMICH_URL.replace(/\/+$/,'') + c.path;
    const headers = Object.assign({}, immichHeaders());
    if (c.accept) headers['Accept'] = c.accept;
    const r = await fetch(url, { method:'GET', headers });
    if (!r.ok) continue;
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return Readable.fromWeb(r.body).pipe(res);
  }
  res.status(502).end();
}

app.get('/api/immich/albums', async (req, res) => {
  // Public read endpoint (gallery can be public)
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });
  try {
    const albums = await immichJson('/api/albums');
    const list = (Array.isArray(albums) ? albums : []).map(a => ({
      id: a.id,
      name: (a.albumName || a.name || '').trim() || '未命名相册',
      count: a.assetCount ?? a.assets?.length ?? 0,
      thumbnailAssetId: a.albumThumbnailAssetId || a.thumbnailAssetId,
    }));
    list.sort((x,y)=>String(x.name).localeCompare(String(y.name)));
    res.json({ ok:true, albums:list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/immich/images', async (req, res) => {
  // Public read endpoint (gallery can be public)
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });

  const albumId = (req.query.albumId || '').toString();
  const offset = Math.max(0, parseInt((req.query.offset ?? '0').toString(), 10) || 0);
  const limitRaw = parseInt((req.query.limit ?? '120').toString(), 10) || 120;
  const limit = Math.max(1, Math.min(500, limitRaw));
  const order = (req.query.order || '').toString();
  const seed = (req.query.seed || '').toString();

  try {
    // If no album specified, return albums as "dirs" (display as name (count))
    if (!albumId) {
      const albums = await immichJson('/api/albums');
      const list = (Array.isArray(albums) ? albums : []).map(a => ({
        id: a.id,
        name: (a.albumName || a.name || '').trim() || '未命名相册',
        count: a.assetCount ?? a.assets?.length ?? 0,
      }));
      list.sort((x,y)=>String(x.name).localeCompare(String(y.name)));
      const dirs = list.map(a => `${a.name} (${a.count})|${a.id}`);
      return res.json({ dir:'', dirs, files:[], total:0, offset:0, limit, nextOffset:0, hasMore:false });
    }

    // Album detail -> assets
    const album = await immichJson('/api/albums/' + encodeURIComponent(albumId));
    const assets = Array.isArray(album?.assets) ? album.assets : (Array.isArray(album?.asset) ? album.asset : []);

    // Only include images for now (avoid video playback/huge downloads)
    const allFiles = assets
      .filter(a => (a?.type || '').toString().toUpperCase() === 'IMAGE')
      .map(a => {
        const id = a.id || a.assetId;
        return {
          name: String(id),
          url: `/api/immich/file?id=${encodeURIComponent(String(id))}`,
          thumbUrl: `/api/immich/thumb?id=${encodeURIComponent(String(id))}`,
        };
      })
      .filter(f => f.name && f.name !== 'undefined');

    const baseAll = allFiles;
    const shuffled = (order === 'random') ? seededShuffle(baseAll, seed || String(Date.now())) : baseAll;

    const total = shuffled.length;
    const files = shuffled.slice(offset, offset + limit);
    const nextOffset = Math.min(total, offset + files.length);
    const hasMore = nextOffset < total;

    res.json({ dir: 'album:' + albumId, dirs: [], files, total, offset, limit, nextOffset, hasMore });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/immich/thumb', async (req, res) => {
  // Public read endpoint
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error:'missing id' });
  // try common Immich thumbnail endpoints
  return immichStreamAny(res, [
    { path: `/api/assets/${encodeURIComponent(id)}/thumbnail`, accept:'image/*' },
    { path: `/api/assets/${encodeURIComponent(id)}/thumbnail?size=thumbnail`, accept:'image/*' },
    { path: `/api/asset/thumbnail/${encodeURIComponent(id)}`, accept:'image/*' },
  ]);
});

app.get('/api/immich/file', async (req, res) => {
  // Public read endpoint
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error:'missing id' });
  return immichStreamAny(res, [
    { path: `/api/assets/${encodeURIComponent(id)}/original`, accept:'*/*' },
    { path: `/api/assets/${encodeURIComponent(id)}/download`, accept:'*/*' },
    { path: `/api/asset/file/${encodeURIComponent(id)}`, accept:'*/*' },
  ]);
});

async function immichAddAssetsToAlbum(albumId, assetIds){
  const ids = (assetIds || []).filter(Boolean).map(String);
  if (!albumId || !ids.length) return { ok:false, status:400, text:'missing albumId/ids' };

  // Try a few Immich API shapes (version differences)
  const payload = JSON.stringify({ ids });
  const candidates = [
    { method:'PUT', path:`/api/albums/${encodeURIComponent(albumId)}/assets` },
    { method:'POST', path:`/api/albums/${encodeURIComponent(albumId)}/assets` },
    { method:'PATCH', path:`/api/albums/${encodeURIComponent(albumId)}/assets` },
  ];

  let last = null;
  for (const c of candidates) {
    const r = await immichFetchJson(c.path, {
      method: c.method,
      headers: { 'Content-Type':'application/json' },
      body: payload
    });
    last = r;
    if (r.ok) return r;
  }
  return last || { ok:false, status:500, text:'unknown' };
}

// Admin: upload to Immich + add into current configured album (or specified albumId)
app.post('/api/immich/upload', uploadMem.array('files', 50), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });

  const cfg = loadGalleryCfg();
  const albumId = ((req.query.albumId || '').toString() || (cfg.immichAlbumId || '').toString()).trim();
  if (!albumId) return res.status(400).json({ error:'missing album id' });

  const files = (req.files || []);
  if (!files.length) return res.status(400).json({ error:'no files' });

  const uploaded = [];
  const failed = [];

  for (const f of files) {
    try {
      const form = new FormData();
      // Common Immich required fields
      form.set('deviceAssetId', crypto.randomUUID());
      form.set('deviceId', 'photo-gallery');
      const now = new Date().toISOString();
      form.set('fileCreatedAt', now);
      form.set('fileModifiedAt', now);
      form.set('isFavorite', 'false');

      // File field name differs across versions; try assetData first.
      const blob = new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' });
      form.set('assetData', blob, f.originalname || 'upload');

      let r = await immichFetchJson('/api/assets', { method:'POST', body: form });

      // Fallback: some builds expect "file" instead of "assetData"
      if (!r.ok) {
        const form2 = new FormData();
        form2.set('deviceAssetId', crypto.randomUUID());
        form2.set('deviceId', 'photo-gallery');
        form2.set('fileCreatedAt', now);
        form2.set('fileModifiedAt', now);
        form2.set('isFavorite', 'false');
        form2.set('file', blob, f.originalname || 'upload');
        r = await immichFetchJson('/api/assets', { method:'POST', body: form2 });
      }

      if (!r.ok) {
        failed.push({ name: f.originalname, error: `upload failed (${r.status})`, detail: r.json || r.text });
        continue;
      }

      const assetId = (r.json && (r.json.id || r.json.assetId)) ? String(r.json.id || r.json.assetId) : null;
      if (!assetId) {
        failed.push({ name: f.originalname, error: 'upload ok but missing asset id', detail: r.json || r.text });
        continue;
      }

      const add = await immichAddAssetsToAlbum(albumId, [assetId]);
      if (!add.ok) {
        failed.push({ name: f.originalname, assetId, error: `add-to-album failed (${add.status})`, detail: add.json || add.text });
        continue;
      }

      uploaded.push({ name: f.originalname, assetId });
    } catch (e) {
      failed.push({ name: f.originalname, error: String(e) });
    }
  }

  res.json({ ok: failed.length === 0, uploaded, failed });
});

// Admin: delete assets from Immich (irreversible)
app.post('/api/immich/delete', express.json({ limit:'1mb' }), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error:'missing ids' });

  // Try bulk delete first
  let bulk = await immichFetchJson('/api/assets', {
    method: 'DELETE',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ ids })
  });

  if (bulk.ok) return res.json({ ok:true, deleted: ids, failed: [] });

  // Fallback: delete one-by-one
  const deleted = [];
  const failed = [];
  for (const id of ids) {
    const r = await immichFetchJson(`/api/assets/${encodeURIComponent(id)}`, { method:'DELETE' });
    if (r.ok) deleted.push(id);
    else failed.push({ id, error: `delete failed (${r.status})`, detail: r.json || r.text });
  }

  res.json({ ok: failed.length === 0, deleted, failed, bulkError: bulk.json || bulk.text, bulkStatus: bulk.status });
});

// --- WebDAV endpoints removed ---

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

    // memory cache
    if (exifCache.has(cacheKey)) {
      return res.json({ ok: true, ...exifCache.get(cacheKey) });
    }

    // redis cache
    const rKey = cacheKeyMeta(imageAbs, st.mtimeMs);
    const cached = await cacheGetJson(rKey);
    if (cached) {
      exifCache.set(cacheKey, cached);
      return res.json({ ok: true, ...cached, cached: true });
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
    await cacheSetJson(rKey, out, 60 * 60 * 24 * 7); // 7 days
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
// Build id should change when frontend files change, otherwise reverse proxies may cache /assets too aggressively.
function getBuildId(){
  try {
    const p1 = path.join(__dirname, 'public', 'assets', 'app.js');
    const p2 = path.join(__dirname, 'public', 'assets', 'styles.css');
    const s1 = fs.statSync(p1).mtimeMs;
    const s2 = fs.statSync(p2).mtimeMs;
    const stamp = 'b' + Math.floor(Math.max(s1, s2));
    return (process.env.BUILD_ID ? (process.env.BUILD_ID + '-' + stamp) : stamp);
  } catch {
    return process.env.BUILD_ID || 'dev';
  }
}

app.get('/api/config', (req, res) => {
  res.json({ buildId: getBuildId(), autoplayMs: 3000 });
});

// admin unlock -> sets HttpOnly cookie for image requests (img tags can't send headers)
app.post('/api/admin/unlock', express.json({ limit:'50kb' }), (req, res) => {
  if (!ADMIN_PASS) return res.json({ ok:true, mode:'disabled' });
  const pass = (req.body?.pass || '').toString();
  if (pass !== ADMIN_PASS) return res.status(401).json({ error:'bad password' });

  const ts = Date.now();
  const sig = signAdminToken(ts);
  const token = Buffer.from(`${ts}.${sig}`, 'utf8').toString('base64');

  // Domain is HTTPS-only (per deployment). Force Secure to satisfy iOS Safari.
  const parts = [
    `gallery_admin=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    // 7 days
    `Max-Age=${7*24*3600}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok:true });
});

// Admin: set public library (for everyone)
app.post('/api/admin/public', express.json({ limit:'50kb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const source = (req.body?.source || '').toString();
  const immichAlbumId = (req.body?.immichAlbumId || '').toString();
  const likeEnabledRaw = req.body?.likeEnabled;

  const cfg = loadGalleryCfg();

  // likeEnabled: admin-controlled global toggle (default: off)
  if (typeof likeEnabledRaw === 'boolean') {
    cfg.likeEnabled = likeEnabledRaw;
  }

  if (source === 'local') {
    cfg.publicSource = 'local';
    cfg.immichAlbumId = '';
    saveGalleryCfg(cfg);
    return res.json({ ok:true, publicSource: cfg.publicSource, immichAlbumId: cfg.immichAlbumId, likeEnabled: !!cfg.likeEnabled });
  }

  if (source === 'immich') {
    if (!immichAlbumId) return res.status(400).json({ error:'missing album id' });
    cfg.publicSource = 'immich';
    cfg.immichAlbumId = immichAlbumId;
    saveGalleryCfg(cfg);
    return res.json({ ok:true, publicSource: cfg.publicSource, immichAlbumId: cfg.immichAlbumId, likeEnabled: !!cfg.likeEnabled });
  }

  // Allow updating likeEnabled without changing source
  if (!source) {
    saveGalleryCfg(cfg);
    return res.json({ ok:true, publicSource: cfg.publicSource || 'local', immichAlbumId: cfg.immichAlbumId || '', likeEnabled: !!cfg.likeEnabled });
  }

  return res.status(400).json({ error:'unsupported source' });
});

app.get('/api/public', (req, res) => {
  const cfg = loadGalleryCfg();
  res.json({
    publicSource: cfg.publicSource || 'local',
    immichAlbumId: cfg.immichAlbumId || '',
    likeEnabled: !!cfg.likeEnabled
  });
});

// Public images feed (used by visitors)
app.get('/api/public/images', async (req, res) => {
  const cfg = loadGalleryCfg();
  const source = (cfg.publicSource || 'local').toString();

  const offset = Math.max(0, parseInt((req.query.offset ?? '0').toString(), 10) || 0);
  const limitRaw = parseInt((req.query.limit ?? '120').toString(), 10) || 120;
  const limit = Math.max(1, Math.min(500, limitRaw));
  const order = (req.query.order || '').toString();
  const seed = (req.query.seed || '').toString();

  // Default: local
  if (source === 'local') {
    const subdir = (req.query.dir || '').toString();
    const abs = safeJoin(IMAGES_DIR, subdir);
    if (!abs) return res.status(400).json({ error: 'bad dir' });

    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const dirs = [];
      const baseAll = [];

      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name === THUMBS_SUBDIR) continue;
          dirs.push(e.name);
        } else if (e.isFile() && isImageFile(e.name)) {
          const rel = path.posix.join('/', subdir.split(path.sep).join('/'), e.name).replace(/\\/g, '/');
          baseAll.push({
            name: e.name,
            url: `/images${rel}`,
            thumbUrl: `/api/thumb?dir=${encodeURIComponent(subdir)}&name=${encodeURIComponent(e.name)}`,
          });
        }
      }

      dirs.sort((a, b) => a.localeCompare(b));
      baseAll.sort((a, b) => a.name.localeCompare(b.name));

      // If root is empty, try a recursive scan so first-time visitors still see local images.
      let allFiles = baseAll;
      if (!subdir && allFiles.length === 0) {
        const stack = [{ rel: '', abs: IMAGES_DIR }];
        const flat = [];

        while (stack.length) {
          const cur = stack.pop();
          let ents = [];
          try { ents = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { ents = []; }

          for (const ent of ents) {
            if (ent.isDirectory()) {
              if (ent.name === THUMBS_SUBDIR) continue;
              const nextRel = cur.rel ? (cur.rel + '/' + ent.name) : ent.name;
              const nextAbs = path.join(cur.abs, ent.name);
              stack.push({ rel: nextRel, abs: nextAbs });
            } else if (ent.isFile() && isImageFile(ent.name)) {
              const d = cur.rel;
              const relUrl = path.posix.join('/', (d ? d : ''), ent.name).replace(/\\/g, '/');
              flat.push({
                name: ent.name,
                url: `/images${relUrl}`,
                thumbUrl: `/api/thumb?dir=${encodeURIComponent(d)}&name=${encodeURIComponent(ent.name)}`,
              });
            }
          }
        }

        flat.sort((a, b) => (a.url || '').localeCompare(b.url || ''));
        allFiles = flat;
      }

      const ordered = (order === 'random') ? seededShuffle(allFiles, seed || String(Date.now())) : allFiles;
      const total = ordered.length;
      const files = ordered.slice(offset, offset + limit);
      const nextOffset = Math.min(total, offset + files.length);
      const hasMore = nextOffset < total;
      const empty = total === 0;

      return res.json({
        dir: subdir,
        dirs,
        files,
        total,
        offset,
        limit,
        nextOffset,
        hasMore,
        empty,
        emptyHint: empty ? '暂无图片：请先上传图片，或在设置里切换图片源（如 Immich）。' : ''
      });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }

  // Immich: public album selected by admin
  if (source === 'immich') {
    if (!immichCfgOk()) return res.status(400).json({ error:'immich not configured' });
    const albumId = (cfg.immichAlbumId || '').toString();
    if (!albumId) return res.status(400).json({ error:'public album not configured' });

    try {
      const album = await immichJson('/api/albums/' + encodeURIComponent(albumId));
      const assets = Array.isArray(album?.assets) ? album.assets : [];
      const allFiles = assets
        .filter(a => (a?.type || '').toString().toUpperCase() === 'IMAGE')
        .map(a => ({
          name: String(a.id),
          url: `/api/immich/file?id=${encodeURIComponent(String(a.id))}`,
          thumbUrl: `/api/immich/thumb?id=${encodeURIComponent(String(a.id))}`,
        }));

      const shuffled = (order === 'random') ? seededShuffle(allFiles, seed || String(Date.now())) : allFiles;
      const total = shuffled.length;
      const files = shuffled.slice(offset, offset + limit);
      const nextOffset = Math.min(total, offset + files.length);
      const hasMore = nextOffset < total;

      return res.json({ dir:'public', dirs:[], files, total, offset, limit, nextOffset, hasMore });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }

  return res.status(400).json({ error:'public source not configured' });
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
    const html = fs.readFileSync(p, 'utf8').replaceAll('__BUILD_ID__', getBuildId());
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
