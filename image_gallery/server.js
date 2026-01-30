import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';

const app = express();

const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || '/images';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

// 测试模式：不设置 token 时允许删除（不安全）。生产环境强烈建议设置 UPLOAD_TOKEN。

const THUMBS_SUBDIR = '.thumbs';
const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '480', 10) || 480;
const THUMB_QUALITY = parseInt(process.env.THUMB_QUALITY || '70', 10) || 70;

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

  const subdir = (req.body?.dir || '').toString();
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

  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });

    const dirs = [];
    const files = [];

    for (const e of entries) {
      if (e.isDirectory()) {
        // 跳过缩略图目录
        if (e.name === THUMBS_SUBDIR) continue;
        dirs.push(e.name);
      } else if (e.isFile() && isImageFile(e.name)) {
        const rel = path.posix.join('/', subdir.split(path.sep).join('/'), e.name).replace(/\\/g, '/');
        files.push({
          name: e.name,
          url: `/images${rel}`,
          thumbUrl: `/api/thumb?dir=${encodeURIComponent(subdir)}&name=${encodeURIComponent(e.name)}`,
        });
      }
    }

    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ dir: subdir, dirs, files });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.use('/images', express.static(IMAGES_DIR, {
  fallthrough: false,
  maxAge: '1h'
}));

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Image Gallery</title>
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <meta http-equiv="Pragma" content="no-cache" />
  <meta http-equiv="Expires" content="0" />
  <style>
    :root { --bg:#0b0e14; --card:#121828; --text:#e6e9f2; --muted:#9aa3b2; --accent:#6ea8fe; }
    *{ box-sizing:border-box; }
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      color:var(--text);
      background: #050611;
      overscroll-behavior: none;
      position: relative;
      min-height: 100vh;
    }
    body::before{
      content:'';
      position: fixed;
      inset: -20%;
      z-index: -1;
      background: conic-gradient(
        from 180deg at 50% 50%,
        rgba(255, 0, 153, .38),
        rgba(255, 102, 0, .28),
        rgba(255, 214, 0, .26),
        rgba(0, 255, 170, .26),
        rgba(0, 170, 255, .30),
        rgba(167, 139, 250, .34),
        rgba(255, 0, 153, .38)
      );
      filter: blur(40px) saturate(1.25);
      opacity: .95;
      transform: translate3d(0,0,0);
      animation: bgSpin 22s linear infinite;
    }
    @keyframes bgSpin{
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    header{ padding:6px 10px; border-bottom:0; position:sticky; top:0; background:transparent; }
    .row{ display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .title{ font-weight:700; letter-spacing:.2px; }
    .crumbs{ color:var(--muted); font-size:14px; }
    .crumbs a{ color:var(--accent); text-decoration:none; }
    .wrap{ padding:8px 10px 18px; max-width:1200px; margin:0 auto; }
    /* Masonry：用 columns 避免“大面积空洞” */
    .grid{ column-gap: 4px; column-count: var(--cols, 2); }
    .tile{ display:inline-block; width:100%; margin: 0 0 4px; background:transparent; border:0; border-radius:10px; overflow:hidden; cursor:pointer; break-inside: avoid; position:relative; aspect-ratio: 4 / 5; }
    .tile.r1{ aspect-ratio: 1 / 1; }
    .tile.r2{ aspect-ratio: 4 / 5; }
    .tile.r3{ aspect-ratio: 3 / 4; }
    .tile.r4{ aspect-ratio: 16 / 9; }
    .tile.r5{ aspect-ratio: 9 / 16; }
    .tile.wide{ column-span: all; aspect-ratio: 21 / 9; margin-bottom: 6px; }
    .tile img{ width:100%; height:100%; object-fit:cover; display:block; background:#0f1320; }
    .tile.sel{ outline: 2px solid rgba(110,168,254,.9); outline-offset: -2px; }
    .check{ position:absolute; top:8px; left:8px; width:26px; height:26px; border-radius:10px; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.18); display:none; align-items:center; justify-content:center; color:#fff; font-weight:900; }
    .tile.sel .check{ display:flex; }

    .actionBar{ position:fixed; left:14px; right:14px; bottom:16px; z-index:40; display:none; gap:10px; align-items:center; justify-content:space-between; padding:12px; background: rgba(18,24,40,.78); border:1px solid rgba(255,255,255,.10); border-radius:16px; backdrop-filter: blur(10px); }
    .actionBar.show{ display:flex; }
    .actionBar .count{ color:rgba(255,255,255,.85); font-weight:800; }
    .actionBar .btns{ display:flex; gap:10px; }
    .danger{ background: rgba(255, 73, 73, .92) !important; color:#1a0303 !important; }
    .ghost{ background: rgba(255,255,255,.12) !important; border:1px solid rgba(255,255,255,.18) !important; color:#fff !important; }
    .tile .cap{ display:none; }
    .dirs{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px; }
    .dir{ border:1px dashed rgba(255,255,255,.18); color:var(--text); background:rgba(255,255,255,.03); padding:8px 10px; border-radius:10px; cursor:pointer; font-size:13px; }
    .empty{ color:var(--muted); padding:16px; border:1px dashed rgba(255,255,255,.15); border-radius:12px; }

    /* loading */
    @keyframes glow {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes shimmer {
      0% { transform: translateX(-60%); }
      100% { transform: translateX(120%); }
    }
    .loadingWrap{ padding: 8px 0; }
    .loadingTitle{ color: rgba(255,255,255,.75); font-weight: 800; letter-spacing:.2px; margin: 8px 2px 10px; }
    .skeletonGrid{ column-gap: 4px; column-count: var(--cols, 2); }
    .sk{ display:inline-block; width:100%; margin:0 0 4px; border-radius:10px; overflow:hidden; break-inside: avoid; background: rgba(255,255,255,.06); position:relative; }
    .sk::after{ content:''; position:absolute; inset:0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.14), transparent); transform: translateX(-60%); animation: shimmer 1.1s ease-in-out infinite; }
    .sk.h1{ height: 160px; }
    .sk.h2{ height: 220px; }
    .sk.h3{ height: 300px; }
    .bar{ display:flex; gap:10px; align-items:center; }
    input{ background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.12); color:var(--text); border-radius:12px; padding:10px 12px; min-width:240px; outline:none; }
    input:focus{ border-color: rgba(110,168,254,.55); box-shadow: 0 0 0 3px rgba(110,168,254,.15); }
    button{ background:var(--accent); border:0; color:#061225; padding:10px 12px; border-radius:12px; cursor:pointer; font-weight:800; }
    button:active{ transform: translateY(1px); }

    /* floating action buttons */
    .fab{ position: fixed; right: 14px; bottom: 88px; display:flex; flex-direction:column; gap:10px; z-index: 30; }
    body.immersive .fab #settingsBtn, body.immersive .fab #uploadBtn{ display:none; }
    /* autoplay(immersive) 时把播放按钮放到底部中间，方便点停 */
    body.immersive .fab{ left:50%; right:auto; bottom:18px; transform:translateX(-50%); }
    body.immersive .fab button{ width:56px; height:56px; border-radius:18px; font-size:28px; }
    body.immersive #lbX{ display:none !important; }
    .fab button{ width: 44px; height: 44px; padding:0; display:grid; place-items:center; border-radius: 14px; background: rgba(18,24,40,.78); border: 1px solid rgba(255,255,255,.10); color: var(--text); backdrop-filter: blur(10px); font-size: 24px; line-height: 1; }
    /* upload button no longer uses special primary style */

    /* lightbox */
    .lb{ position:fixed; inset:0; background:rgba(0,0,0,.25); display:none; align-items:center; justify-content:center; padding:10px; overscroll-behavior: contain; touch-action: none; backdrop-filter: blur(10px); }
    .lb.open{ display:flex; }
    .lb-inner{ width:100%; max-width: min(1400px, 100vw); height: min(96vh, 980px); }

    /* 预览区按 4:1 分配：上面主图 4fr，下面缩略条 1fr */
    .lb-stage{ height:100%; display:grid; grid-template-rows: 4fr 1fr; gap:10px; min-height:0; }
    .mainWrap{ position:relative; min-height:0; border-radius:18px; overflow:hidden; background:transparent; box-shadow: 0 18px 50px rgba(0,0,0,.35); padding:0; border:1px solid rgba(255,255,255,.10); }
    /* 主图填满外框：用 cover（会裁切一点边缘） */
    .lb-img{ width:100%; height:100%; object-fit:cover; border-radius:18px; background:transparent; display:block; transform-origin: 50% 50%; transition: transform .12s ease; will-change: transform; }

    .thumbs{ height: 100%; min-height: 64px; display:flex; align-items:center; gap:8px; overflow-x:auto; padding:8px 6px; -webkit-overflow-scrolling: touch; scrollbar-width: none; background: rgba(0,0,0,.18); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; touch-action: pan-x; }
    .immersive .thumbs{ display:none; }
    .immersive .lb-stage{ grid-template-rows: 1fr; }
    .thumbs::-webkit-scrollbar{ display:none; }
    .thumb{ flex: 0 0 auto; width:92px; height:64px; border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); cursor:pointer; }
    .thumb img{ width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
    .thumb.active{ border-color: rgba(110,168,254,.8); box-shadow: 0 0 0 2px rgba(110,168,254,.22); }

    /* one-time hints */
    .hint{ position:absolute; padding:8px 10px; border-radius:12px; background:rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.18); color:#fff; font-weight:800; font-size:12px; letter-spacing:.2px; backdrop-filter: blur(8px); pointer-events:none; opacity:0; transform: translateY(6px); }
    .hint.show{ opacity:1; transform: translateY(0); transition: opacity .25s ease, transform .25s ease; }
    .hint.fade{ opacity:0; transform: translateY(10px); transition: opacity .6s ease, transform .6s ease; }

    /* lightbox controls auto-hide */
    .ctl{ transition: opacity .25s ease, transform .25s ease; }
    .ctlHide .ctl{ opacity:0; transform: translateY(6px); pointer-events:none; }
    @media (max-width: 520px){
      input{ min-width: 180px; width:100%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <div>
        <!-- crumbs hidden for clean UI -->
        <div class="crumbs" id="crumbs" style="display:none"></div>
      </div>
      <!-- controls moved into settings -->
    </div>
  </header>

  <div class="wrap">
    <div class="dirs" id="dirs"></div>
    <div id="content"></div>
  </div>

  <div class="actionBar" id="actionBar">
    <div class="count" id="selCount">已选择 0</div>
    <div class="btns">
      <button id="toggleAll" class="ghost">全选</button>
      <button id="cancelSel" class="ghost">取消</button>
      <button id="deleteSel" class="danger">删除</button>
    </div>
  </div>

  <div class="fab">
    <button id="playPref" title="自动播放" aria-label="自动播放">▶</button>
    <button id="settingsBtn" title="配置" aria-label="配置">⚙️</button>
    <button id="uploadBtn" title="上传" aria-label="上传">↑</button>
  </div>

  <input id="file" type="file" accept="image/*" multiple style="display:none" />

  <div class="lb" id="lb">
    <div class="lb-inner">
      <div class="lb-stage">
        <div class="mainWrap" style="position:relative;">
          <img class="lb-img" id="lbImg" />
          <button id="lbPrev" class="ctl" aria-label="上一张" style="position:absolute;left:12px;top:65%;transform:translateY(-50%);background:rgba(255, 0, 153, .38);border:1px solid rgba(255, 0, 153, .55);color:#fff;border-radius:12px;padding:8px 10px;cursor:pointer;">‹</button>
          <button id="lbNext" class="ctl" aria-label="下一张" style="position:absolute;right:12px;top:65%;transform:translateY(-50%);background:rgba(0, 255, 240, .30);border:1px solid rgba(0, 255, 240, .55);color:#fff;border-radius:12px;padding:8px 10px;cursor:pointer;">›</button>
          <button id="lbX" aria-label="关闭" style="position:absolute;right:12px;top:12px;background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.22);color:#fff;border-radius:14px;width:44px;height:44px;padding:0;cursor:pointer;font-size:24px;line-height:1;display:grid;place-items:center;">✕</button>

          <div id="hintSwipe" class="hint" style="left:50%;top:14px;transform:translate(-50%,6px);">左右滑动切换 · 双击/双指放大</div>
          <div id="hintThumbs" class="hint" style="left:50%;bottom:78px;transform:translate(-50%,6px);">底部滑动选图</div>
        </div>
        <div class="thumbs" id="thumbs"></div>
      </div>
      <a id="lbOpen" target="_blank" rel="noreferrer" style="display:none;">open</a>
      <div id="lbName" style="display:none"></div>
    </div>
  </div>

  <!-- settings modal -->
  <div class="lb" id="settings" style="background:rgba(0,0,0,.55)">
    <div class="lb-inner" style="max-width:520px;">
      <div style="background:var(--card);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="font-weight:800;">显示配置</div>
          <a href="#" id="settingsClose" style="color:var(--accent);text-decoration:none;">关闭</a>
        </div>
        <div style="margin-top:12px;color:var(--muted);font-size:13px;">本地图片展示（Gallery）</div>
        <div style="margin-top:6px;color:var(--muted);font-size:13px;">手机建议 2~3 列，空洞会更少。</div>
<!-- autoplay moved to big-image toolbar -->
        <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap;">
          <label style="display:flex;gap:8px;align-items:center;">
            <span style="min-width:60px;color:var(--muted);">目录</span>
            <input id="dir" placeholder="子目录（例如: 2026/01）" style="min-width:180px;" />
          </label>
          <button id="go" style="background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);color:#fff;">打开</button>
        </div>

        <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap;">
          <label style="display:flex;gap:8px;align-items:center;">
            <span style="min-width:60px;color:var(--muted);">列数</span>
            <select id="cols" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:var(--text);border-radius:10px;padding:10px 12px;">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
          </label>
          <button id="apply" style="background:var(--accent);border:0;color:#061225;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:800;">应用</button>
          <button id="uploadInSettings" style="background:rgba(54,211,153,.85);border:0;color:#062015;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:800;">上传图片</button>
        </div>
      </div>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);

  function esc(s){ return (s||'').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }

  function setCrumbs(dir){
    const parts = (dir || '').split(/[\\/]+/).filter(Boolean);
    let html = '<a href="#" data-dir="">/</a>';
    let cur = '';
    for (const p of parts){
      cur = cur ? (cur + '/' + p) : p;
      html += ' / ' + '<a href="#" data-dir="' + esc(cur) + '">' + esc(p) + '</a>';
    }
    $('crumbs').innerHTML = html;
    [...$('crumbs').querySelectorAll('a[data-dir]')].forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        load(a.getAttribute('data-dir') || '');
      });
    });
  }

  let currentFiles = [];
  let currentIndex = -1;

  // selection
  let selectMode = false;
  const selected = new Set();

  function updateActionBar(){
    const bar = $('actionBar');
    const n = selected.size;
    $('selCount').textContent = '已选择 ' + n;
    if (selectMode && n > 0) bar.classList.add('show');
    else bar.classList.remove('show');

    // 同步“全选/取消全选”文案
    const total = document.querySelectorAll('.tile[data-name]').length;
    const btn = $('toggleAll');
    if (btn) btn.textContent = (total > 0 && n >= total) ? '取消全选' : '全选';
  }

  function enterSelectMode(){
    selectMode = true;
    updateActionBar();
  }

  function exitSelectMode(){
    selectMode = false;
    selected.clear();
    document.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
    updateActionBar();
  }

  function selectAll(){
    if (!selectMode) enterSelectMode();
    selected.clear();
    document.querySelectorAll('.tile[data-name]').forEach(t => {
      const name = t.getAttribute('data-name');
      if (!name) return;
      selected.add(name);
      t.classList.add('sel');
    });
    updateActionBar();
  }

  function clearAll(){
    selected.clear();
    document.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
    updateActionBar();
  }

  function toggleSelect(name, tile, forceOn=false){
    if (!selectMode) return;
    const on = forceOn ? false : selected.has(name);
    if (on) {
      selected.delete(name);
      tile.classList.remove('sel');
    } else {
      selected.add(name);
      tile.classList.add('sel');
    }
    updateActionBar();
  }

  function renderSkeleton(){
    const cols = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cols') || '2', 10) || 2;
    const count = Math.max(10, cols * 10);
    const heights = ['h1','h1','h2','h1','h2','h3','h1','h2','h1','h2'];
    let html = '<div class="loadingWrap">' +
      '<div class="loadingTitle">加载中…</div>' +
      '<div class="skeletonGrid">';
    for (let i=0;i<count;i++){
      const h = heights[i % heights.length];
      html += '<div class="sk ' + h + '"></div>';
    }
    html += '</div></div>';
    $('content').innerHTML = html;
  }

  async function load(dir){
    $('dir').value = dir;
    setCrumbs(dir);
    $('dirs').innerHTML = '';
    renderSkeleton();

    const r = await fetch('/api/images?dir=' + encodeURIComponent(dir));
    const data = await r.json();

    if (data.error){
      $('content').innerHTML = '<div class="empty">错误：' + esc(data.error) + '</div>';
      return;
    }

    if (data.dirs && data.dirs.length){
      for (const d of data.dirs){
        const el = document.createElement('div');
        el.className = 'dir';
        el.textContent = '📁 ' + d;
        el.onclick = () => load(dir ? (dir + '/' + d) : d);
        $('dirs').appendChild(el);
      }
    }

    if (!data.files || !data.files.length){
      currentFiles = [];
      currentIndex = -1;
      $('content').innerHTML = '<div class="empty">这个目录没有图片（支持 jpg/png/webp/gif…）。</div>';
      return;
    }

    currentFiles = data.files;
    currentIndex = -1;

    const grid = document.createElement('div');
    grid.className = 'grid';
    function hashString(s){
      let h = 2166136261;
      for (let i=0;i<s.length;i++){
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0);
    }

    for (let i = 0; i < data.files.length; i++){
      const f = data.files[i];
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.setAttribute('data-name', f.name);

      // 稳定“随机”尺寸：同一张图每次都一样（按文件名 hash）
      const h = hashString(f.name);
      const r = (h % 1000) / 1000;
      const ar = (h % 5) + 1;
      tile.classList.add('r' + ar);
      if (r < 0.10) tile.classList.add('wide');

      const thumb = f.thumbUrl || f.url;
      tile.innerHTML = '<div class="check">✓</div>' +
        '<img loading="lazy" src="' + esc(thumb) + '" data-full="' + esc(f.url) + '" alt="" />' +
        '<div class="cap"></div>';

      // click 打开预览（在“选择模式”下改为切换选择）
      tile.addEventListener('click', (e) => {
        if (selectMode) {
          e.preventDefault();
          toggleSelect(f.name, tile);
          return;
        }
        openLb(i);
      });

      // 长按进入选择模式并选中
      let lp = null;
      tile.addEventListener('touchstart', (e) => {
        if (selectMode) return;
        lp = setTimeout(() => {
          enterSelectMode();
          toggleSelect(f.name, tile, true);
        }, 420);
      }, { passive: true });
      tile.addEventListener('touchend', () => { if (lp) clearTimeout(lp); lp = null; }, { passive: true });
      tile.addEventListener('touchmove', () => { if (lp) clearTimeout(lp); lp = null; }, { passive: true });

      // 右键（桌面）进入选择
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!selectMode) enterSelectMode();
        toggleSelect(f.name, tile);
      });

      grid.appendChild(tile);
    }
    $('content').innerHTML = '';
    $('content').appendChild(grid);
  }

  function applyCols(cols){
    const n = Math.max(1, Math.min(8, parseInt(cols || '2', 10) || 2));
    document.documentElement.style.setProperty('--cols', String(n));
    localStorage.setItem('gallery_cols', String(n));
    $('cols').value = String(n);
  }

  function renderThumbs(){
    const el = $('thumbs');
    if (!el) return;
    if (!currentFiles.length){ el.innerHTML = ''; return; }

    // 只渲染附近一段，避免几千张时卡
    const total = currentFiles.length;
    const radius = 12;
    let start = Math.max(0, currentIndex - radius);
    let end = Math.min(total, currentIndex + radius + 1);

    // 如果开头/结尾不足，尽量补齐数量
    const want = Math.min(total, radius * 2 + 1);
    while (end - start < want) {
      if (start > 0) start--;
      else if (end < total) end++;
      else break;
    }

    let html = '';
    for (let i = start; i < end; i++){
      const f = currentFiles[i];
      const t = f.thumbUrl || f.url;
      html += '<div class="thumb' + (i === currentIndex ? ' active' : '') + '" data-idx="' + i + '">' +
        '<img loading="eager" src="' + esc(t) + '" alt="" />' +
      '</div>';
    }
    el.innerHTML = html;
    [...el.querySelectorAll('.thumb[data-idx]')].forEach(n => {
      n.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(n.getAttribute('data-idx') || '0', 10);
        showLb(idx);
      });
    });

    // 滚动让当前缩略图尽量在中间
    const active = el.querySelector('.thumb.active');
    if (active) {
      const left = active.offsetLeft - (el.clientWidth / 2) + (active.clientWidth / 2);
      el.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }

  let zoom = 1;
  let panX = 0;
  let panY = 0;

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  let rafPending = false;
  function applyZoom(){
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const img = $('lbImg');
      // translate3d 更容易走 GPU 合成
      img.style.transform = 'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + zoom + ')';
    });
  }

  function resetZoom(){
    zoom = 1; panX = 0; panY = 0;
    $('lbImg').style.transformOrigin = '50% 50%';
    applyZoom();
  }

  function zoomAt(clientX, clientY){
    const img = $('lbImg');
    const rect = img.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    img.style.transformOrigin = clamp(x, 0, 100) + '% ' + clamp(y, 0, 100) + '%';

    // 1x -> 2x -> 3x -> 1x
    if (zoom === 1) zoom = 2;
    else if (zoom === 2) zoom = 3;
    else { zoom = 1; panX = 0; panY = 0; }
    applyZoom();
  }

  function showHintsOnce(){
    try {
      if (localStorage.getItem('gallery_hints_v1') === '1') return;
    } catch {}

    const h1 = $('hintSwipe');
    const h2 = $('hintThumbs');
    if (!h1 || !h2) return;

    // show
    h1.classList.add('show');
    h2.classList.add('show');

    // fade out
    setTimeout(() => {
      h1.classList.remove('show');
      h2.classList.remove('show');
      h1.classList.add('fade');
      h2.classList.add('fade');
    }, 2200);

    // remove
    setTimeout(() => {
      h1.remove();
      h2.remove();
    }, 3200);

    try { localStorage.setItem('gallery_hints_v1', '1'); } catch {}
  }

  // controls: 只做一次性引导（后续不再弹出左右/关闭按钮）
  let ctlTimer = null;
  function showControlsOnce(){
    const lb = $('lb');
    try {
      if (localStorage.getItem('gallery_controls_v1') === '1') {
        lb.classList.add('ctlHide');
        return;
      }
    } catch {}

    lb.classList.remove('ctlHide');
    if (ctlTimer) clearTimeout(ctlTimer);
    ctlTimer = setTimeout(() => {
      lb.classList.add('ctlHide');
    }, 1800);

    try { localStorage.setItem('gallery_controls_v1', '1'); } catch {}
  }

  const AUTOPLAY_MS = 3000;
  let autoplayEnabled = false;
  let autoplayTimer = null;

  function updatePlayBtn(){
    const btn = $('playPref');
    if (!btn) return;
    // 开关状态跟随播放状态
    btn.textContent = autoplayTimer ? '❚❚' : '▶';
  }

  let pausedByTouch = false;

  function stopAutoplay(){
    if (autoplayTimer) clearInterval(autoplayTimer);
    autoplayTimer = null;
    updatePlayBtn();
  }

  function pauseAutoplayForTouch(){
    if (!autoplayEnabled) return;
    if (!autoplayTimer) return;
    pausedByTouch = true;
    stopAutoplay();
  }

  function resumeAutoplayAfterTouch(){
    if (!pausedByTouch) return;
    pausedByTouch = false;
    if (autoplayEnabled) startAutoplay();
  }

  function startAutoplay(){
    stopAutoplay();
    if (!autoplayEnabled) return;
    autoplayTimer = setInterval(() => {
      nextLb();
    }, AUTOPLAY_MS);
    updatePlayBtn();
  }

  function setAutoplayEnabled(on){
    autoplayEnabled = !!on;
    const lb = $('lb');
    if (autoplayEnabled) {
      lb.classList.add('immersive');
      document.body.classList.add('immersive');
      startAutoplay();
    } else {
      lb.classList.remove('immersive');
      document.body.classList.remove('immersive');
      stopAutoplay();
    }
  }

  function showLbInternal(index){
    if (!currentFiles.length) return;
    if (index < 0) index = currentFiles.length - 1;
    if (index >= currentFiles.length) index = 0;
    currentIndex = index;
    const f = currentFiles[currentIndex];

    // 切换图片时才加载原图
    $('lbImg').src = f.url;
    $('lbOpen').href = f.url;

    resetZoom();
    renderThumbs();
    const lb = $('lb');
    lb.classList.add('open');
    lb.classList.add('ctlHide');
    showControlsOnce();
    showHintsOnce();

    // 注意：这里不再重置 autoplay，避免自动播放切一张就停
    updatePlayBtn();
  }

  function openLb(index){
    // 每次“进入大图模式”默认关闭自动播放
    autoplayEnabled = false;
    stopAutoplay();
    showLbInternal(index);
  }

  function closeLb(){
    const lb = $('lb');
    lb.classList.remove('open');
    lb.classList.remove('immersive');
    document.body.classList.remove('immersive');
    autoplayEnabled = false;
    pausedByTouch = false;
    stopAutoplay();
    resetZoom();
    updatePlayBtn();
  }

  function prevLb(){
    showLbInternal(currentIndex - 1);
  }

  function nextLb(){
    showLbInternal(currentIndex + 1);
  }

  // floating play button: if not in lightbox, open first image then start autoplay
  const playPref = $('playPref');
  if (playPref) {
    // 防误触：自动播放(immersive)时，需要“长按”播放按钮才会暂停
    let holdTimer = null;
    let holdArmed = false;

    playPref.addEventListener('touchstart', (e) => {
      if (!document.body.classList.contains('immersive')) return;
      if (!autoplayTimer) return;
      holdArmed = false;
      holdTimer = setTimeout(() => {
        holdArmed = true;
      }, 320);
    }, { passive: true });

    playPref.addEventListener('touchend', (e) => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      if (!document.body.classList.contains('immersive')) return;
      if (!autoplayTimer) return;
      if (!holdArmed) {
        // 短点按不做事
        e.preventDefault();
        e.stopPropagation();
      }
    }, { passive: false });

    playPref.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 如果大图没打开：打开第一张并开始播放
      if (!$('lb').classList.contains('open')) {
        if (!currentFiles || !currentFiles.length) return;
        openLb(0);
        setAutoplayEnabled(true);
        startAutoplay();
        return;
      }

      // 如果正在自动播放且处于沉浸模式：必须长按才允许暂停（避免误触）
      if (document.body.classList.contains('immersive') && autoplayTimer && !holdArmed) {
        return;
      }
      holdArmed = false;

      // 大图已打开：切换播放/暂停
      setAutoplayEnabled(!autoplayEnabled);
      if (autoplayEnabled) startAutoplay();
      else stopAutoplay();
    });
  }

  // lbPlay removed; use floating playPref only

  $('lbX').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeLb(); });
  $('lbPrev').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); prevLb(); });
  $('lbNext').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); nextLb(); });
  $('lb').addEventListener('click', (e) => {
    // 点击遮罩关闭；内容区点击不再弹出按钮（保持干净）
    if (e.target === $('lb')) closeLb();
  });

  // 键盘左右 / Esc
  document.addEventListener('keydown', (e) => {
    if (!$('lb').classList.contains('open')) return;
    if (e.key === 'ArrowLeft') prevLb();
    else if (e.key === 'ArrowRight') nextLb();
    else if (e.key === 'Escape') closeLb();
  });

  // 触摸滑动（手机左右滑） + 缩放后拖动查看细节 + 双指捏合缩放
  let touchX = null;
  let touchY = null;
  let dragX = null;
  let dragY = null;

  let pinchStartDist = null;
  let pinchStartZoom = 1;

  function dist(t1, t2){
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  function midpoint(t1, t2){
    return { x: (t1.clientX + t2.clientX)/2, y: (t1.clientY + t2.clientY)/2 };
  }

  const lbEl = $('lb');
  lbEl.addEventListener('touchstart', (e) => {
    if (!lbEl.classList.contains('open')) return;

    // 在缩略图条上允许横向滚动
    if (e.target && e.target.closest && e.target.closest('#thumbs')) return;

    // 用户开始手势操作：先临时暂停自动播放，手指离开后再恢复
    pauseAutoplayForTouch();

    if (e.touches && e.touches.length === 2) {
      // pinch start
      pinchStartDist = dist(e.touches[0], e.touches[1]);
      pinchStartZoom = zoom;
      const m = midpoint(e.touches[0], e.touches[1]);
      const img = $('lbImg');
      // pinch 时关掉 transition，避免每帧补间导致卡顿
      img.style.transition = 'none';
      const rect = img.getBoundingClientRect();
      const ox = ((m.x - rect.left) / rect.width) * 100;
      const oy = ((m.y - rect.top) / rect.height) * 100;
      img.style.transformOrigin = clamp(ox,0,100) + '% ' + clamp(oy,0,100) + '%';
      e.preventDefault();
      return;
    }

    const t = e.touches && e.touches[0];
    if (!t) return;
    touchX = t.clientX;
    touchY = t.clientY;
    dragX = t.clientX;
    dragY = t.clientY;
  }, { passive: false });

  lbEl.addEventListener('touchmove', (e) => {
    if (!lbEl.classList.contains('open')) return;
    if (e.target && e.target.closest && e.target.closest('#thumbs')) return;

    // pinch zoom
    if (e.touches && e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const scale = d / pinchStartDist;
      zoom = clamp(pinchStartZoom * scale, 1, 4);
      applyZoom();
      return;
    }

    const t = e.touches && e.touches[0];
    if (!t || touchX == null || touchY == null) return;
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;

    // 缩放状态：拖动平移看细节
    if (zoom > 1 && dragX != null && dragY != null) {
      e.preventDefault();
      panX += (t.clientX - dragX);
      panY += (t.clientY - dragY);
      dragX = t.clientX;
      dragY = t.clientY;
      applyZoom();
      return;
    }

    // 非缩放：横向滑动为主时，preventDefault 尝试阻止浏览器导航手势
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  }, { passive: false });

  lbEl.addEventListener('touchend', (e) => {
    if (!lbEl.classList.contains('open')) return;

    // pinch end
    if (pinchStartDist && (!e.touches || e.touches.length < 2)) {
      pinchStartDist = null;
      pinchStartZoom = zoom;
      // pinch 结束恢复 transition
      const img = $('lbImg');
      img.style.transition = 'transform .12s ease';
    }

    // 所有手指离开后，恢复自动播放
    if (!e.touches || e.touches.length === 0) {
      resumeAutoplayAfterTouch();
    }

    if (touchX == null) {
      dragX = dragY = null;
      return;
    }

    // 缩放中不做翻页（避免误触）
    if (zoom > 1) {
      touchX = touchY = dragX = dragY = null;
      return;
    }

    const endX = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : null;
    if (endX == null) return;

    // 左侧边缘“禁滑区”：避免触发浏览器返回手势
    const EDGE = 24; // px
    if (touchX <= EDGE) {
      touchX = touchY = dragX = dragY = null;
      return;
    }

    const dx = endX - touchX;
    touchX = touchY = dragX = dragY = null;
    const TH = 40; // 触发阈值
    if (dx > TH) prevLb();
    else if (dx < -TH) nextLb();
  }, { passive: true });

  // 双击/双击（移动端双击）放大查看细节（1x->2x->3x->1x）
  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  $('lbImg').addEventListener('click', (e) => {
    if (!lbEl.classList.contains('open')) return;
    const now = Date.now();
    const dx = Math.abs((e.clientX || 0) - (lastClickX || 0));
    const dy = Math.abs((e.clientY || 0) - (lastClickY || 0));

    if (now - lastClickAt < 320 && dx < 24 && dy < 24) {
      // double click
      zoomAt(e.clientX, e.clientY);
      lastClickAt = 0;
      lastClickX = 0;
      lastClickY = 0;
    } else {
      lastClickAt = now;
      lastClickX = e.clientX || 0;
      lastClickY = e.clientY || 0;
    }
  });

  async function doUpload(files){
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);

    const dir = ($('dir').value || '').trim();
    const r = await fetch('/api/upload?dir=' + encodeURIComponent(dir), {
      method: 'POST',
      body: fd
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert('上传失败：' + (data.error || r.status));
      return;
    }
    await load(dir);
  }

  // settings
  const settings = $('settings');
  function openSettings(){ settings.classList.add('open'); }
  function closeSettings(){ settings.classList.remove('open'); }

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', (e) => { e.preventDefault(); closeSettings(); });
  settings.addEventListener('click', (e) => { if (e.target === settings) closeSettings(); });
  $('apply').addEventListener('click', () => { applyCols($('cols').value); closeSettings(); });

  // init cols
  applyCols(localStorage.getItem('gallery_cols') || '2');

  // autoplay 默认关闭（进入大图由用户手动点 ▶ 才开始）
  updatePlayBtn();

  // selection actions
  $('toggleAll').addEventListener('click', (e) => {
    e.preventDefault();
    const total = document.querySelectorAll('.tile[data-name]').length;
    if (selected.size >= total && total > 0) {
      clearAll();
      $('toggleAll').textContent = '全选';
    } else {
      selectAll();
      $('toggleAll').textContent = '取消全选';
    }
  });

  $('cancelSel').addEventListener('click', (e) => { e.preventDefault(); exitSelectMode(); $('toggleAll').textContent = '全选'; });
  $('deleteSel').addEventListener('click', async (e) => {
    e.preventDefault();
    if (!selected.size) return;
    const ok = confirm('确定删除选中的 ' + selected.size + ' 张图片？');
    if (!ok) return;

    const dir = ($('dir').value || '').trim();
    const names = [...selected];
    const r = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, names })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert('删除失败：' + (data.error || r.status));
      return;
    }
    exitSelectMode();
    await load(dir);
  });

  // upload (fab + settings)
  $('uploadBtn').addEventListener('click', () => $('file').click());
  $('uploadInSettings').addEventListener('click', () => $('file').click());

  // autoplay: 持续播放直到用户关闭（不因操作而停止）
  $('file').addEventListener('change', async () => {
    const files = [...$('file').files];
    $('file').value = '';
    await doUpload(files);
  });

  $('go').addEventListener('click', () => load(($('dir').value || '').trim()));
  $('dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(($('dir').value || '').trim()); });

  load('');
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Image Gallery listening on :${PORT}`);
  console.log(`Serving images from ${IMAGES_DIR}`);
});
