(async function(){
  const $ = (id) => document.getElementById(id);

  // Visible error reporter (so you don't need DevTools)
  function showFatal(err){
    try {
      const el = document.getElementById('content');
      if (el) {
        el.innerHTML = '<div class="empty">脚本错误：' + String(err).replace(/</g,'&lt;') + '</div>';
      }
    } catch {}
  }
  window.addEventListener('error', (e) => {
    showFatal(e && e.message ? e.message : e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    showFatal(e && e.reason ? e.reason : e);
  });
  const on = (id, ev, fn, opts) => {
    const el = $(id);
    if (!el) return false;
    el.addEventListener(ev, fn, opts);
    return true;
  };
  let AUTOPLAY_MS = 3000;
  const PAGE_SIZE = 120;

  // --- config (build id + autoplay) ---
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const cfg = await r.json();
      if ($('buildId')) $('buildId').textContent = cfg.buildId || '';
      const ms = parseInt(cfg.autoplayMs, 10);
      if (!isNaN(ms) && ms > 300 && ms < 600000) AUTOPLAY_MS = ms;
    }
  } catch (e) {
    console.warn('config load failed', e);
  }

  function esc(s){
    return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // --- state ---
  let currentDir = '';
  // bubble mode resources need cleanup on reload (intervals/runner/raf)
  let bubbleCleanup = null;
  let currentFiles = [];
  let currentIndex = -1;
  let nextOffset = 0;
  let hasMore = false;
  let isLoadingMore = false;
  let gridEl = null;
  let io = null;

  // settings toggles
  let bubbleMode = true;
  try {
    const v = localStorage.getItem('gallery_bubble');
    if (v === '0') bubbleMode = false;
    else if (v === '1') bubbleMode = true;
  } catch {}

  // theme: dark | light (two modes)
  // default: light for first-time users
  let themeMode = 'light';
  try {
    const raw = localStorage.getItem('gallery_theme');
    const tm = (raw == null ? 'light' : raw).toString();
    if (tm === 'light' || tm === 'dark') themeMode = tm;
    // migration: old "system" treated as light
  } catch {}

  // view mode: bubble | masonry | collage
  let viewMode = 'bubble';
  try {
    const vm = (localStorage.getItem('gallery_view_mode') || '').toString();
    if (vm === 'bubble' || vm === 'masonry' || vm === 'collage') viewMode = vm;
  } catch {}

  // bubble count (user adjustable)
  const defaultBubbleCount = () => (isMobileLike() ? 20 : 25);
  let bubbleCount = defaultBubbleCount();
  try {
    const bc = parseInt(localStorage.getItem('gallery_bubble_count') || '', 10);
    if (!isNaN(bc)) bubbleCount = bc;
  } catch {}

  // metaEnabled (shooting info) feature removed

  // selection
  let selectMode = false;
  const selected = new Set();

  // upload/delete token (client-side)
  function getUploadToken(){
    try { return (localStorage.getItem('gallery_upload_token') || '').trim(); } catch { return ''; }
  }

  // admin pass (session-scoped)
  function getAdminPass(){
    try { return (sessionStorage.getItem('gallery_admin_pass') || '').trim(); } catch { return ''; }
  }
  function setAdminPass(v){
    try { sessionStorage.setItem('gallery_admin_pass', String(v||'').trim()); } catch {}
  }

  // source mode
  function getSourceMode(){
    try { return (localStorage.getItem('gallery_source_mode') || 'auto').trim(); } catch { return 'auto'; }
  }
  function isImmichMode(){
    const m = getSourceMode();
    return m === 'immich';
  }
  function setSourceMode(v){
    try { localStorage.setItem('gallery_source_mode', String(v||'auto')); } catch {}
  }

  // immich
  function getImmichAlbumId(){
    try { return (localStorage.getItem('gallery_immich_album') || '').trim(); } catch { return ''; }
  }
  function setImmichAlbumId(v){
    try { localStorage.setItem('gallery_immich_album', String(v||'')); } catch {}
  }

  // WebDAV config is server-side (env). Web UI no longer collects credentials.

  // likes
  const likes = new Map(); // name -> count (currentDir scoped)
  function likeKey(name){ return (currentDir || '') + '|' + String(name || ''); }
  function isLiked(name){
    try { return localStorage.getItem('liked:' + likeKey(name)) === '1'; } catch { return false; }
  }
  function markLiked(name){
    try { localStorage.setItem('liked:' + likeKey(name), '1'); } catch {}
  }
  function setLikeUI(el, name){
    if (!el) return;
    const btn = el.querySelector('.likeBtn');
    if (!btn) return;
    const n = likes.get(String(name)) || 0;
    const c = btn.querySelector('.count');
    if (c) c.textContent = String(n);
    btn.classList.toggle('liked', isLiked(name));
  }
  async function fetchLikesFor(names){
    try {
      const q = names.map(encodeURIComponent).join(',');
      const r = await fetch('/api/likes?dir=' + encodeURIComponent(currentDir || '') + '&names=' + q);
      const j = await r.json();
      if (!j || !j.ok || !j.likes) return;
      for (const [k,v] of Object.entries(j.likes)) {
        likes.set(k, v || 0);
      }
    } catch {}
  }

  // lightbox images (crossfade)
  function getActiveImg(){
    return document.querySelector('.lb-img.isActive') || $('lbImgA') || $('lbImgB');
  }
  function getInactiveImg(){
    const a = $('lbImgA');
    const b = $('lbImgB');
    const active = getActiveImg();
    return (active === a) ? b : a;
  }
  function swapActiveImg(nextEl){
    const cur = getActiveImg();
    if (cur) cur.classList.remove('isActive');
    if (nextEl) nextEl.classList.add('isActive');
  }

  // --- UI helpers ---
  function isMobileLike(){
    return (window.matchMedia && window.matchMedia('(max-width: 520px)').matches) || (window.innerWidth && window.innerWidth <= 520);
  }

  function clampInt(n, lo, hi){
    n = parseInt(String(n || ''), 10);
    if (isNaN(n)) return null;
    return Math.max(lo, Math.min(hi, n));
  }

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

  function updateActionBar(){
    const bar = $('actionBar');
    const n = selected.size;
    if ($('selCount')) $('selCount').textContent = '已选择 ' + n;
    if (selectMode) bar.classList.add('show');
    else bar.classList.remove('show');

    const total = document.querySelectorAll('.tile[data-name]').length;
    const btn = $('toggleAll');
    if (btn) btn.textContent = (total > 0 && n >= total) ? '取消全选' : '全选';
  }

  function enterSelectMode(){
    selectMode = true;
    updateActionBar();
    if ($('enterDelete')) $('enterDelete').textContent = '退出删除模式';
  }
  function exitSelectMode(){
    selectMode = false;
    selected.clear();
    document.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
    updateActionBar();
    if ($('enterDelete')) $('enterDelete').textContent = '删除模式';
  }

  function toggleSelect(name, tile, forceOn){
    const on = (forceOn !== undefined) ? forceOn : !selected.has(name);
    if (on) { selected.add(name); tile.classList.add('sel'); }
    else { selected.delete(name); tile.classList.remove('sel'); }
    updateActionBar();
  }

  function selectAll(){
    document.querySelectorAll('.tile[data-name]').forEach(t => {
      const n = t.getAttribute('data-name');
      if (!n) return;
      selected.add(n);
      t.classList.add('sel');
    });
    updateActionBar();
  }

  function clearAll(){
    selected.clear();
    document.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
    updateActionBar();
  }

  function setBubbleMode(on){
    bubbleMode = !!on;
    try { localStorage.setItem('gallery_bubble', bubbleMode ? '1' : '0'); } catch {}
    if ($('bubbleModeBtn')) $('bubbleModeBtn').textContent = '泡泡布局：' + (bubbleMode ? '开' : '关');
  }

  // setMetaEnabled removed

  // --- paging (masonry) ---
  function ensureObserver(){
    if (io) return;
    io = new IntersectionObserver(async (entries) => {
      if (!entries || !entries.length) return;
      if (!entries.some(e => e.isIntersecting)) return;
      await loadMore();
    }, { rootMargin: '800px 0px' });
  }

  function mountSentinel(){
    if (!gridEl) return;
    let s = document.getElementById('sentinel');
    if (!hasMore) {
      if (s) s.remove();
      if (io) { try { io.disconnect(); } catch {} io = null; }
      return;
    }
    if (!s) {
      s = document.createElement('div');
      s.id = 'sentinel';
      s.style.cssText = 'height:56px; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,.55); font-size:12px;';
      s.textContent = '加载更多…';
      gridEl.appendChild(s);
    }
    ensureObserver();
    io.observe(s);
  }

  function hashString(s){
    let h = 2166136261;
    for (let i=0;i<s.length;i++){
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  }

  function makeTile(globalIndex, f, totalCount){
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('data-name', f.name);

    const h = hashString(f.name);
    const rr = (h % 1000) / 1000;

    // shape sprinkle (middle band only)
    const inMiddle = (globalIndex >= 2) && (globalIndex <= totalCount - 3);
    // shape ratio: 25% circle + 25% ellipse (only for middle band)
    if (inMiddle && rr < 0.25) tile.classList.add('circle', 'r1');
    else if (inMiddle && rr < 0.50) tile.classList.add('ellipse', 'r2');
    else tile.classList.add('r' + ((h % 6) + 1));

    // edge effects
    const fx = ((h >> 3) % 1000) / 1000;
    if (fx < 0.35) tile.classList.add('edgeGlow');
    else if (fx < 0.60) tile.classList.add('edgeSoft');

    const thumb = f.thumbUrl || f.url;
    tile.innerHTML = '<div class="check">✓</div>' +
      '<img loading="lazy" src="' + esc(thumb) + '" alt="" />' +
      '<div class="likeBtn" role="button" aria-label="点赞"><span class="heart">❤</span><span class="count">0</span></div>';

    const likeBtn = tile.querySelector('.likeBtn');
    if (likeBtn) {
      likeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isLiked(f.name)) return;
        try {
          const r = await fetch('/api/like', {
            method:'POST',
            headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify({ dir: currentDir || '', name: f.name })
          });
          const j = await r.json();
          if (j && j.ok && typeof j.count === 'number') {
            likes.set(String(f.name), j.count);
            markLiked(f.name);
            setLikeUI(tile, f.name);
          }
        } catch {}
      });
    }

    tile.addEventListener('click', (e) => {
      if (selectMode) { e.preventDefault(); toggleSelect(f.name, tile); return; }
      openLb(globalIndex);
    });

    // initial count / state
    setLikeUI(tile, f.name);

    // long-press on mobile enters select
    let lp = null;
    tile.addEventListener('touchstart', () => {
      if (selectMode) return;
      lp = setTimeout(() => { enterSelectMode(); toggleSelect(f.name, tile, true); }, 420);
    }, { passive:true });
    tile.addEventListener('touchend', () => { if (lp) clearTimeout(lp); lp = null; }, { passive:true });
    tile.addEventListener('touchmove', () => { if (lp) clearTimeout(lp); lp = null; }, { passive:true });

    // right click enters select
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectMode) enterSelectMode();
      toggleSelect(f.name, tile);
    });

    return tile;
  }

  async function loadMore(){
    if (!hasMore || isLoadingMore) return;
    isLoadingMore = true;
    try {
      const seed = (viewMode === 'masonry') ? (window.__masonrySeed || (window.__masonrySeed = String(Date.now()))) : '';
      const order = (viewMode === 'masonry') ? '&order=random&seed=' + encodeURIComponent(seed) : '';

      const src = (window.__activeSource || 'local');
      let r2;
      if (src === 'immich') {
        const albumId = getImmichAlbumId();
        r2 = await apiFetch('/api/immich/images?albumId=' + encodeURIComponent(albumId) + '&offset=' + nextOffset + '&limit=' + PAGE_SIZE + order);
      } else {
        const base = (src === 'dav') ? '/api/dav/images' : '/api/images';
        r2 = await apiFetch(base + '?dir=' + encodeURIComponent(currentDir) + '&offset=' + nextOffset + '&limit=' + PAGE_SIZE + order);
      }
      const d2 = await r2.json();
      if (d2.error) throw new Error(d2.error);

      const startIndex = currentFiles.length;
      currentFiles = currentFiles.concat(d2.files || []);
      nextOffset = d2.nextOffset || currentFiles.length;
      hasMore = !!d2.hasMore;

      const s = document.getElementById('sentinel');
      if (s) s.remove();

      const newFiles = (d2.files || []);
      // fetch likes for newly appended items
      await fetchLikesFor(newFiles.map(f => f.name));

      const totalCount = d2.total || currentFiles.length;
      for (let i=0;i<newFiles.length;i++){
        gridEl.appendChild(makeTile(startIndex + i, newFiles[i], totalCount));
      }
      mountSentinel();
    } finally {
      isLoadingMore = false;
    }
  }

  // --- lightbox (pan/zoom) ---
  let zoom = 1, panX = 0, panY = 0;
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 6;
  let rafPending = false;

  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  function setOriginFromEvent(img, clientX, clientY){
    if (!img || clientX == null || clientY == null) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = clamp((clientX - r.left) / r.width, 0, 1);
    const py = clamp((clientY - r.top) / r.height, 0, 1);
    img.style.transformOrigin = (px * 100).toFixed(2) + '% ' + (py * 100).toFixed(2) + '%';
  }

  function applyZoom(){
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const img = getActiveImg();
      if (!img) return;
      img.style.transform = 'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + zoom + ')';
      const z = zoom > 1.02;
      try {
        document.body.classList.toggle('lbZoomed', z);
      } catch {}
      if (z) {
        // when user wants details, force upgrade to full-res
        ensureFullRes(img);
      }
    });
  }

  function resetZoom(){
    zoom = 1; panX = 0; panY = 0;
    const img = getActiveImg();
    if (img) img.style.transformOrigin = '50% 50%';
    applyZoom();
  }

  // autoplay progress
  let apRaf = 0;
  let apFrom = 0;
  let autoplayEnabled = false;
  let autoplayRunning = false;

  function apSet(p){
    const bar = $('apProgBar');
    if (!bar) return;
    const pct = Math.max(0, Math.min(1, p));
    bar.style.width = (pct * 100).toFixed(1) + '%';
  }
  function apStop(){ if (apRaf) cancelAnimationFrame(apRaf); apRaf = 0; apFrom = 0; apSet(0); }
  function apStartShown(){ apFrom = performance.now(); }

  function apLoop(){
    if (apRaf) cancelAnimationFrame(apRaf);
    const tick = () => {
      if (!autoplayEnabled || !autoplayRunning || !$('lb').classList.contains('open')) { apStop(); return; }
      if (!apFrom) { apSet(0); apRaf = requestAnimationFrame(tick); return; }
      const p = (performance.now() - apFrom) / AUTOPLAY_MS;
      if (p >= 1) {
        apSet(1);
        apFrom = 0;
        nextLb();
      } else {
        apSet(p);
      }
      apRaf = requestAnimationFrame(tick);
    };
    apRaf = requestAnimationFrame(tick);
  }

  // updateMetaOverlay removed (shooting info feature removed)

  function ensureFullRes(imgEl){
    try {
      const fullUrl = imgEl?.dataset?.fullUrl || '';
      if (!fullUrl) return;
      if (imgEl.src === fullUrl) return;
      // begin upgrade
      const full = new Image();
      full.decoding = 'async';
      full.src = fullUrl;
      full.onload = () => {
        // only upgrade if still showing same image
        const active = getActiveImg();
        if (active === imgEl) imgEl.src = fullUrl;
      };
    } catch {}
  }

  function showLbInternal(index){
    if (!currentFiles.length) return;
    if (index < 0) index = currentFiles.length - 1;
    if (index >= currentFiles.length) index = 0;
    currentIndex = index;
    const f = currentFiles[currentIndex];

    const lb = $('lb');
    lb.classList.add('open');

    // blurred background to avoid black bars when using object-fit:contain
    const bg = $('lbBg');
    if (bg) bg.src = f.url;

    // prefer instant preview: show thumb first, then upgrade to full-res
    const thumbUrl = f.thumbUrl || f.url;
    const fullUrl = f.url;

    // auto-hide controls a moment after opening
    lb.classList.remove('ctlHide');
    if (!window.__lbCtlTimer) window.__lbCtlTimer = 0;
    try { if (window.__lbCtlTimer) clearTimeout(window.__lbCtlTimer); } catch {}
    window.__lbCtlTimer = setTimeout(() => {
      // don't hide if user is interacting
      lb.classList.add('ctlHide');
    }, 1800);

    const nextImg = getInactiveImg();
    if (nextImg) {
      nextImg.style.transform = 'translate3d(0px,0px,0) scale(1)';
      nextImg.style.transformOrigin = '50% 50%';

      if (autoplayEnabled && autoplayRunning) { apFrom = 0; apSet(0); }

      // annotate urls on element for later upgrades (e.g., when zooming)
      try {
        nextImg.dataset.thumbUrl = thumbUrl;
        nextImg.dataset.fullUrl = fullUrl;
      } catch {}

      nextImg.addEventListener('load', () => {
        swapActiveImg(nextImg);
        resetZoom();
        // after showing thumb, upgrade to full-res in background
        ensureFullRes(nextImg);
        if (autoplayEnabled && autoplayRunning) apStartShown();
      }, { once:true });

      nextImg.src = thumbUrl;
    } else {
      const img = getActiveImg();
      if (img) img.src = f.url;
      if (autoplayEnabled && autoplayRunning) {
        apFrom = 0; apSet(0);
        const img2 = getActiveImg();
        if (img2 && img2.complete && img2.naturalWidth > 0) apStartShown();
        else if (img2) img2.addEventListener('load', () => apStartShown(), { once:true });
      }
    }

    $('lbOpen').href = f.url;
    renderThumbs();
  }

  function openLb(index){
    autoplayEnabled = false;
    autoplayRunning = false;
    apStop();
    // ensure FAB is visible when entering lightbox
    try { document.body.classList.remove('fabHidden'); } catch {}
    showLbInternal(index);
  }

  function closeLb(){
    $('lb').classList.remove('open');
    $('lb').classList.remove('immersive');
    document.body.classList.remove('immersive');

    // exit detail mode
    detailMode = false;
    try { document.body.classList.remove('lbDetail'); } catch {}

    autoplayEnabled = false;
    autoplayRunning = false;
    apStop();
    resetZoom();
    // show FAB when leaving lightbox
    try { document.body.classList.remove('fabHidden'); } catch {}
  }

  function renderThumbs(){
    const el = $('thumbs');
    if (!el) return;
    if (!currentFiles.length){ el.innerHTML = ''; return; }

    const total = currentFiles.length;
    const radius = 12;
    let start = Math.max(0, currentIndex - radius);
    let end = Math.min(total, currentIndex + radius + 1);

    const want = Math.min(total, radius * 2 + 1);
    while (end - start < want) {
      if (start > 0) start--;
      else if (end < total) end++;
      else break;
    }

    let html = '';
    for (let i=start;i<end;i++){
      const f = currentFiles[i];
      const t = f.thumbUrl || f.url;
      html += '<div class="thumb' + (i === currentIndex ? ' active' : '') + '" data-idx="' + i + '"><img loading="eager" src="' + esc(t) + '" alt="" /></div>';
    }
    el.innerHTML = html;
    [...el.querySelectorAll('.thumb[data-idx]')].forEach(n => {
      n.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(n.getAttribute('data-idx') || '0', 10);
        showLbInternal(idx);
      });
    });

    const active = el.querySelector('.thumb.active');
    if (active) {
      const left = active.offsetLeft - (el.clientWidth/2) + (active.clientWidth/2);
      el.scrollTo({ left: Math.max(0,left), behavior: 'smooth' });
    }
  }

  function nextLb(){
    showLbInternal(currentIndex + 1);
  }
  function prevLb(){
    showLbInternal(currentIndex - 1);
    if (autoplayEnabled) startAutoplay();
  }

  function startAutoplay(){
    if (!$('lb').classList.contains('open')) return;
    autoplayEnabled = true;
    autoplayRunning = true;
    $('lb').classList.add('immersive');
    document.body.classList.add('immersive');
    apStop();
    apSet(0);
    apLoop();

    const img = getActiveImg();
    if (img && img.complete && img.naturalWidth > 0) apStartShown();
    else if (img) img.addEventListener('load', () => apStartShown(), { once:true });

    const btn = $('playPref');
    if (btn) btn.style.display = 'none';
  }

  function stopAutoplay(){
    autoplayEnabled = false;
    autoplayRunning = false;
    apStop();
    $('lb').classList.remove('immersive');
    document.body.classList.remove('immersive');
    const btn = $('playPref');
    if (btn) btn.style.display = '';
  }

  // --- events ---
  on('lbX','click', (e) => { e.preventDefault(); e.stopPropagation(); closeLb(); });
  on('lbPrev','click', (e) => { e.preventDefault(); e.stopPropagation(); prevLb(); });
  on('lbNext','click', (e) => { e.preventDefault(); e.stopPropagation(); nextLb(); });
  on('lb','click', (e) => { if (e.target === $('lb')) closeLb(); });

  const lb = $('lb');

  // show controls on interaction, then hide after a delay
  let lbCtlTimer = 0;
  function showLbControls(){
    if (!lb || !lb.classList.contains('open')) return;
    lb.classList.remove('ctlHide');
    try { if (lbCtlTimer) clearTimeout(lbCtlTimer); } catch {}
    // keep right-bottom FAB in sync with lightbox controls
    try { document.body.classList.remove('fabHidden'); } catch {}

    lbCtlTimer = setTimeout(() => {
      // keep controls while zoomed (user likely navigating/panning)
      if (zoom > 1.02) return;
      lb.classList.add('ctlHide');
      try { document.body.classList.add('fabHidden'); } catch {}
    }, 2200);
  }
  if (lb) {
    for (const ev of ['pointerdown','pointermove','touchstart','wheel','keydown']) {
      lb.addEventListener(ev, showLbControls, { passive:true });
    }
  }

  // detail mode (fit-to-screen, hide thumbs bar)
  let detailMode = false;
  function setDetailMode(on){
    detailMode = !!on;
    try { document.body.classList.toggle('lbDetail', detailMode); } catch {}
    // reset zoom/pan when toggling modes
    zoom = 1; panX = 0; panY = 0;
    applyZoom();
    // keep controls visible briefly
    try { if (detailMode) document.body.classList.remove('fabHidden'); } catch {}
  }
  function toggleDetailMode(){ setDetailMode(!detailMode); }

  // lightbox zoom (wheel + double click) and pan (drag when zoomed) + swipe navigation
  if (lb) {
    lb.addEventListener('wheel', (e) => {
      if (!lb.classList.contains('open')) return;
      e.preventDefault();
      const img = getActiveImg();
      if (!img) return;
      setOriginFromEvent(img, e.clientX, e.clientY);
      const dir = (e.deltaY > 0) ? -1 : 1;
      const step = 0.18;
      zoom = clamp(zoom * (1 + dir * step), ZOOM_MIN, ZOOM_MAX);
      if (zoom === 1) { panX = 0; panY = 0; }
      applyZoom();
    }, { passive:false });

    lb.addEventListener('dblclick', (e) => {
      if (!lb.classList.contains('open')) return;
      // double click behaves like the magnifier: toggle detail mode
      e.preventDefault();
      toggleDetailMode();
    });

    // drag to pan when zoomed
    let dragging = false;
    let dragSX = 0, dragSY = 0, dragPX = 0, dragPY = 0;
    const startDrag = (e) => {
      if (!lb.classList.contains('open')) return;
      if (zoom <= 1.02) return;
      const img = getActiveImg();
      if (!img) return;
      dragging = true;
      dragSX = e.clientX; dragSY = e.clientY;
      dragPX = panX; dragPY = panY;
      try { img.setPointerCapture(e.pointerId); } catch {}
    };
    const moveDrag = (e) => {
      if (!dragging) return;
      panX = dragPX + (e.clientX - dragSX);
      panY = dragPY + (e.clientY - dragSY);
      applyZoom();
    };
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      const img = getActiveImg();
      try { if (img) img.releasePointerCapture(e.pointerId); } catch {}
    };
    const bindImg = (id) => {
      const img = $(id);
      if (!img) return;
      img.addEventListener('pointerdown', (e) => { e.preventDefault(); startDrag(e); });
      img.addEventListener('pointermove', (e) => { if (dragging) e.preventDefault(); moveDrag(e); });
      img.addEventListener('pointerup', endDrag);
      img.addEventListener('pointercancel', endDrag);
    };
    bindImg('lbImgA');
    bindImg('lbImgB');

    // swipe left/right to navigate (only when not zoomed)
    const stage = $('lbStage');
    let sActive = false;
    let sX0 = 0, sY0 = 0;
    let sDx = 0, sDy = 0;
    const swipeStart = (e) => {
      if (!lb.classList.contains('open')) return;
      if (zoom > 1.02) return;
      const t = (e.touches && e.touches[0]) ? e.touches[0] : null;
      if (!t) return;
      sActive = true;
      sX0 = t.clientX; sY0 = t.clientY;
      sDx = 0; sDy = 0;
    };
    const swipeMove = (e) => {
      if (!sActive) return;
      const t = (e.touches && e.touches[0]) ? e.touches[0] : null;
      if (!t) return;
      sDx = t.clientX - sX0;
      sDy = t.clientY - sY0;
      if (Math.abs(sDx) > 10 && Math.abs(sDx) > Math.abs(sDy) * 1.2) {
        e.preventDefault();
      }
    };
    const swipeEnd = () => {
      if (!sActive) return;
      sActive = false;
      if (zoom > 1.02) return;
      if (Math.abs(sDx) > 55 && Math.abs(sDx) > Math.abs(sDy) * 1.2) {
        if (sDx < 0) nextLb();
        else prevLb();
      }
      sDx = 0; sDy = 0;
    };
    if (stage) {
      stage.addEventListener('touchstart', swipeStart, { passive:true });
      stage.addEventListener('touchmove', swipeMove, { passive:false });
      stage.addEventListener('touchend', swipeEnd, { passive:true });
      stage.addEventListener('touchcancel', swipeEnd, { passive:true });
    }

    // edge guards: block browser back/forward swipe when lightbox is open
    for (const sel of ['.swipeGuard.left', '.swipeGuard.right']) {
      const g = document.querySelector(sel);
      if (!g) continue;
      g.addEventListener('touchstart', (e) => { if (lb.classList.contains('open')) e.preventDefault(); }, { passive:false });
      g.addEventListener('touchmove', (e) => { if (lb.classList.contains('open')) e.preventDefault(); }, { passive:false });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!$('lb').classList.contains('open')) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (autoplayRunning) stopAutoplay();
      else startAutoplay();
      return;
    }
    if (e.key === 'ArrowLeft') prevLb();
    else if (e.key === 'ArrowRight') nextLb();
    else if (e.key === 'Escape') closeLb();
  });

  // floating buttons auto-hide
  let fabTimer = 0;
  function showFab(){
    try { document.body.classList.remove('fabHidden'); } catch {}
    try { if (fabTimer) clearTimeout(fabTimer); } catch {}
    fabTimer = setTimeout(() => {
      // don't hide while settings/lightbox is open
      const s = $('settings');
      const lb = $('lb');
      if (s && s.classList.contains('open')) return;
      if (lb && lb.classList.contains('open')) return;
      try { document.body.classList.add('fabHidden'); } catch {}
    }, 2600);
  }
  // show on user activity
  for (const ev of ['pointerdown','pointermove','touchstart','scroll','keydown']) {
    window.addEventListener(ev, showFab, { passive:true });
  }
  // show initially then hide
  showFab();

  // settings modal toggle
  const settings = $('settings');
  function isAdminUnlocked(){
    return !!getAdminPass();
  }
  function syncSettingsLockUI(){
    const unlocked = isAdminUnlocked();
    // hide all adminOnly sections when locked
    document.querySelectorAll('.adminOnly').forEach(el => {
      el.style.display = unlocked ? '' : 'none';
    });
    // show unlock section only when locked
    if ($('adminUnlock')) $('adminUnlock').style.display = unlocked ? 'none' : '';

    // immichOnly rows only when unlocked + mode immich
    const immichShow = unlocked && ($('sourceMode') ? ($('sourceMode').value === 'immich') : (getSourceMode() === 'immich'));
    document.querySelectorAll('.immichOnly').forEach(el => {
      el.style.display = immichShow ? '' : 'none';
    });
  }

  function openSettings(){
    settings.classList.add('open');

    // clear admin pass field on open (avoid iOS Keychain autofill confusion)
    if ($('adminPass')) {
      try { $('adminPass').value = ''; } catch {}
    }

    // init token field
    if ($('uploadToken')) {
      try { $('uploadToken').value = getUploadToken(); } catch {}
    }

    // init webdav/source UI
    if ($('sourceMode')) {
      try { $('sourceMode').value = getSourceMode(); } catch {}
      $('sourceMode').addEventListener('change', () => {
        syncSettingsLockUI();
        if ($('sourceMode').value === 'immich') {
          loadImmichAlbums();
        }
      });
    }
    // WebDAV credentials are server-side; no UI fields

    // immich album
    if ($('immichAlbum')) {
      $('immichAlbum').value = getImmichAlbumId();
      $('immichAlbum').addEventListener('change', () => setImmichAlbumId($('immichAlbum').value || ''));
    }

    syncSettingsLockUI();
    if (isAdminUnlocked() && ($('sourceMode')?.value === 'immich' || getSourceMode() === 'immich')) {
      loadImmichAlbums();
    }
    showFab();
  }
  function closeSettings(){ settings.classList.remove('open'); showFab(); }
  on('settingsBtn','click', (e) => {
    e.preventDefault();
    if (settings.classList.contains('open')) closeSettings(); else openSettings();
  });
  on('settingsClose','click', (e) => { e.preventDefault(); closeSettings(); });
  on('cancelSettings','click', (e) => { e.preventDefault(); closeSettings(); });
  if (settings) settings.addEventListener('click', (e) => { if (e.target === settings) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (settings.classList.contains('open') && e.key === 'Escape') closeSettings(); });

  // admin unlock
  on('adminUnlockBtn','click', async (e) => {
    e.preventDefault();
    const p = ($('adminPass') ? $('adminPass').value : '').trim();
    if (!p) { alert('请输入管理员密码'); return; }
    // Establish cookie session (img tags can't send custom headers)
    try {
      const r0 = await fetch('/api/admin/unlock', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ pass: p })
      });
      if (r0.status === 401) { alert('密码不正确'); return; }
    } catch {}

    // best-effort verify by calling a protected endpoint
    try {
      const r = await fetch('/api/immich/albums', { headers: { 'x-admin-pass': p } });
      if (r.status === 401) { alert('密码不正确'); return; }
    } catch {}

    setAdminPass(p);
    syncSettingsLockUI();
  });

  // apply cols
  function applyCols(cols){
    const v = (cols == null ? '' : String(cols)).trim();
    if (v === 'auto') {
      document.body.classList.add('autoCols');
      document.documentElement.style.setProperty('--cols', '3');
      try { localStorage.setItem('gallery_cols', 'auto'); } catch {}
      if ($('cols')) $('cols').value = 'auto';
      return;
    }
    document.body.classList.remove('autoCols');
    const n = Math.max(1, Math.min(8, parseInt(v || '3', 10) || 3));
    document.documentElement.style.setProperty('--cols', String(n));
    try { localStorage.setItem('gallery_cols', String(n)); } catch {}
    if ($('cols')) $('cols').value = String(n);
  }
  on('apply','click', async () => {
    // Apply all settings at once
    applyCols($('cols') ? $('cols').value : 'auto');

    if ($('viewMode')) {
      const v = ($('viewMode').value || 'bubble');
      const vm = (v === 'bubble' || v === 'masonry' || v === 'collage') ? v : 'bubble';
      setViewMode(vm);
    }

    if ($('bubbleCount')) {
      const def = (isMobileLike() ? 20 : 25);
      const n = clampInt($('bubbleCount').value, 5, 80) || def;
      bubbleCount = n;
      try { localStorage.setItem('gallery_bubble_count', String(n)); } catch {}
    }

    if ($('uploadToken')) {
      try { localStorage.setItem('gallery_upload_token', String($('uploadToken').value || '').trim()); } catch {}
    }

    // Remote sources (admin only)
    if (!isAdminUnlocked()) {
      // allow saving non-admin options, but do not apply admin settings
    } else {
      if ($('sourceMode')) setSourceMode($('sourceMode').value || 'auto');

      // immich
      if ($('immichAlbum')) setImmichAlbumId($('immichAlbum').value || '');
    }

    closeSettings();
    await load(currentDir);
  });

  // init cols
  let savedCols = null;
  try { savedCols = localStorage.getItem('gallery_cols'); } catch {}
  if (savedCols) applyCols(savedCols);
  else applyCols(isMobileLike() ? '3' : 'auto');

  // dir open
  on('go','click', async (e) => {
    e.preventDefault();
    const d = ($('dir') ? $('dir').value : '').trim();
    await load(d);
    closeSettings();
  });

  // mode selector
  function themeLabel(tm){
    if (tm === 'light') return '亮色';
    return '暗黑';
  }
  function applyTheme(tm){
    const t = (tm === 'light' || tm === 'dark') ? tm : 'light';
    themeMode = t;
    try { localStorage.setItem('gallery_theme', themeMode); } catch {}
    document.body.classList.remove('themeLight');
    if (themeMode === 'light') document.body.classList.add('themeLight');

    // sync top-right icon
    if ($('themeTopIcon')) $('themeTopIcon').textContent = (themeMode === 'light') ? '☀︎' : '☾';
  }

  function modeLabel(vm){
    if (vm === 'bubble') return '泡泡';
    if (vm === 'collage') return '拼贴';
    if (vm === 'masonry') return '瀑布';
    return '泡泡';
  }
  function syncModeUI(vm){
    const mode = (vm === 'bubble' || vm === 'masonry' || vm === 'collage') ? vm : 'bubble';
    if ($('bubbleCountWrap')) $('bubbleCountWrap').style.display = (mode === 'bubble') ? 'flex' : 'none';
    if ($('collageHint')) $('collageHint').style.display = (mode === 'collage') ? 'flex' : 'none';
    if ($('colsWrap')) $('colsWrap').style.display = (mode === 'masonry') ? 'flex' : 'none';
    if ($('modeQuick')) $('modeQuick').innerHTML = '<div class="mqTop">' + modeLabel(mode) + '</div><div class="mqBottom">模式</div>';
  }

  function setViewMode(next){
    const mode = (next === 'bubble' || next === 'masonry' || next === 'collage') ? next : 'bubble';
    viewMode = mode;
    try { localStorage.setItem('gallery_view_mode', viewMode); } catch {}
    if ($('viewMode')) {
      try { $('viewMode').value = viewMode; } catch {}
    }
    syncModeUI(viewMode);
  }

  if ($('viewMode')) {
    try { $('viewMode').value = viewMode; } catch {}
    syncModeUI(viewMode);
    $('viewMode').addEventListener('change', () => {
      const v = ($('viewMode').value || 'bubble');
      const vm = (v === 'bubble' || v === 'masonry' || v === 'collage') ? v : 'bubble';
      // preview-only: update dependent UI; apply happens on "保存并应用"
      syncModeUI(vm);
    });
  }

  // quick mode button (cycles immediately)
  if ($('modeQuick')) {
    syncModeUI(viewMode);
    on('modeQuick','click', async (e) => {
      e.preventDefault();
      const order = ['bubble','collage','masonry'];
      const cur = order.indexOf(viewMode);
      const next = order[(cur + 1 + order.length) % order.length];
      setViewMode(next);
      await load(currentDir);
    });
  }

  // top-right theme toggle (two modes)
  applyTheme(themeMode);
  on('themeTop','click', (e) => {
    e.preventDefault();
    applyTheme(themeMode === 'light' ? 'dark' : 'light');
  });

  // bubble count input
  if ($('bubbleCount')) {
    const def = (isMobileLike() ? 20 : 25);
    const v = clampInt(bubbleCount, 5, 80) || def;
    $('bubbleCount').value = String(v);
    if ($('bubbleCountWrap')) $('bubbleCountWrap').style.display = (viewMode === 'bubble') ? 'flex' : 'none';

    $('bubbleCount').addEventListener('change', () => {
      // preview-only; apply happens on "保存并应用"
    });
  }
  // metaToggle removed

  // delete actions
  on('toggleAll','click', (e) => {
    e.preventDefault();
    const total = document.querySelectorAll('.tile[data-name]').length;
    if (selected.size >= total && total > 0) clearAll();
    else selectAll();
  });
  on('cancelSel','click', (e) => { e.preventDefault(); exitSelectMode(); });
  on('enterDelete','click', (e) => { e.preventDefault(); if (!selectMode) enterSelectMode(); else exitSelectMode(); });

  on('deleteSel','click', async (e) => {
    e.preventDefault();
    if (!selected.size) return;
    if (!confirm('确认删除已选 ' + selected.size + ' 张图片？')) return;
    const names = Array.from(selected);
    const tok = getUploadToken();
    const headers = { 'Content-Type':'application/json' };
    if (tok) headers['x-upload-token'] = tok;
    const src = (window.__activeSource || 'local');
    const url = (src === 'dav') ? ('/api/dav/delete?dir=' + encodeURIComponent(currentDir)) : ('/api/delete?dir=' + encodeURIComponent(currentDir));
    const r = await apiFetch(url, {
      method:'POST',
      headers,
      body: JSON.stringify({ dir: currentDir, names })
    }, { webdav: (src === 'dav') });
    const j = await r.json();
    // reload
    exitSelectMode();
    await load(currentDir);
    if (j.failed && j.failed.length) alert('部分删除失败：' + j.failed.length);
  });

  // upload
  on('uploadBtn','click', () => { if ($('file')) $('file').click(); });
  on('uploadInSettings','click', () => { if ($('file')) $('file').click(); });
  on('file','change', async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const tok = getUploadToken();
    const src = (window.__activeSource || 'local');
    const url = (src === 'dav') ? ('/api/dav/upload?dir=' + encodeURIComponent(currentDir)) : ('/api/upload?dir=' + encodeURIComponent(currentDir));
    const headers = {};
    if (tok) headers['x-upload-token'] = tok;
    await apiFetch(url, {
      method:'POST',
      headers,
      body: fd
    }, { webdav: (src === 'dav') });
    if ($('file')) $('file').value = '';
    await load(currentDir);
  });

  // detail button
  on('detailBtn','click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!$('lb') || !$('lb').classList.contains('open')) return;
    toggleDetailMode();
  });

  // autoplay button
  on('playPref','click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!$('lb') || !$('lb').classList.contains('open')) {
      if (!currentFiles.length) return;
      // start from a random image instead of always the first
      const idx = Math.floor(Math.random() * currentFiles.length);
      openLb(idx);
    }
    if (autoplayRunning) stopAutoplay();
    else startAutoplay();
  });

  async function loadImmichAlbums(){
    if (!isAdminUnlocked()) return;
    const sel = $('immichAlbum');
    if (!sel) return;
    try {
      sel.innerHTML = '<option value="">加载中…</option>';
      const r = await apiFetch('/api/immich/albums');
      if (!r.ok) throw new Error('bad status');
      const j = await r.json();
      const albums = Array.isArray(j.albums) ? j.albums : [];
      const cur = getImmichAlbumId();
      const opts = ['<option value="">（全部相册）</option>'];
      for (const a of albums) {
        const name = String(a.name || 'Untitled');
        const count = (a.count ?? 0);
        opts.push(`<option value="${esc(a.id)}">${esc(name)}（${count}）</option>`);
      }
      sel.innerHTML = opts.join('');
      if (cur) sel.value = cur;
    } catch {
      sel.innerHTML = '<option value="">（无法加载相册）</option>';
    }
  }

  async function apiFetch(url, opts = {}, extra = {}){
    const headers = Object.assign({}, (opts.headers || {}));
    const admin = getAdminPass();
    if (admin) headers['x-admin-pass'] = admin;
    // webdav credentials are not sent from browser
    return fetch(url, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
  }

  // initial load
  async function load(dir){
    // Tear down previous bubble simulation / observers to avoid leaks when switching dirs/modes.
    if (typeof bubbleCleanup === 'function') {
      try { bubbleCleanup(); } catch {}
      bubbleCleanup = null;
    }
    if (io) { try { io.disconnect(); } catch {} io = null; }

    currentDir = (dir || '').trim();
    $('dir').value = currentDir;
    setCrumbs(currentDir);

    let data;
    try {
      const seed = (viewMode === 'masonry') ? String(Date.now()) : '';
      const order = (viewMode === 'masonry') ? '&order=random&seed=' + encodeURIComponent(seed) : '';

      const mode = getSourceMode();

      // decide active source
      let active = 'local';
      if (mode === 'dav') active = 'dav';
      else if (mode === 'immich') active = 'immich';
      else if (mode === 'local') active = 'local';
      else active = 'auto';

      // helper to fetch from a source
      const fetchSrc = async (src) => {
        if (src === 'immich') {
          const albumId = getImmichAlbumId();
          const base = '/api/immich/images';
          const r = await apiFetch(base + '?albumId=' + encodeURIComponent(albumId) + '&offset=0&limit=' + PAGE_SIZE + order);
          const j = await r.json();
          j.__src = src;
          return j;
        }
        const base = (src === 'dav') ? '/api/dav/images' : '/api/images';
        const r = await apiFetch(base + '?dir=' + encodeURIComponent(currentDir) + '&offset=0&limit=' + PAGE_SIZE + order, {}, { webdav: (src === 'dav') });
        const j = await r.json();
        j.__src = src;
        return j;
      };

      if (active === 'auto') {
        // try local first
        const j1 = await fetchSrc('local');
        if ((j1.total || 0) > 0) {
          data = j1;
        } else {
          if (!getAdminPass()) {
            data = j1;
          } else {
            // try webdav then immich
            let j2 = null;
            try {
              j2 = await fetchSrc('dav');
              if (j2 && j2.error) j2 = null;
            } catch { j2 = null; }
            if (j2 && (j2.total || 0) > 0) data = j2;
            else data = await fetchSrc('immich');
          }
        }
      } else {
        if ((active === 'dav' || active === 'immich') && !getAdminPass()) {
          data = { error: '远程数据需要先在设置里解锁管理密码' };
        } else {
          data = await fetchSrc(active);
        }
      }

      window.__activeSource = data.__src || (active === 'auto' ? 'local' : active);
    } catch (e) {
      console.error('load failed', e);
      $('content').innerHTML = '<div class="empty">加载失败（网络/脚本错误）。打开控制台看报错。</div>';
      return;
    }
    if (data.error){
      $('content').innerHTML = '<div class="empty">错误：' + esc(data.error) + '</div>';
      return;
    }

    currentFiles = data.files || [];
    currentIndex = -1;

    // load likes for current page (dir-scoped)
    likes.clear();
    await fetchLikesFor(currentFiles.map(f => f.name));
    nextOffset = data.nextOffset || currentFiles.length;
    hasMore = !!data.hasMore;

    // dirs list
    $('dirs').innerHTML = '';
    if (data.dirs && data.dirs.length){
      for (const d of data.dirs){
        const el = document.createElement('div');
        el.className = 'dir';
        el.textContent = '📁 ' + d;
        el.onclick = () => load(currentDir ? (currentDir + '/' + d) : d);
        $('dirs').appendChild(el);
      }
    }

    // reflect mode on body for layout CSS
    try {
      document.body.classList.toggle('modeCollage', viewMode === 'collage');
      document.body.classList.toggle('modeBubble', viewMode === 'bubble');
      document.body.classList.toggle('modeMasonry', viewMode === 'masonry');
    } catch {}

    // bubble mode
    if (viewMode === 'bubble' && window.Matter) {
      const MAX = clampInt(bubbleCount, 5, 80) || (isMobileLike() ? 20 : 25);
      const files = currentFiles.slice(0, MAX);

      const stage = document.createElement('div');
      stage.className = 'bubbleStage';
      $('content').innerHTML = '';
      $('content').appendChild(stage);

      const { Engine, Bodies, Body, Composite, Runner } = Matter;
      const engine = Engine.create();
      engine.enableSleeping = false;
      engine.gravity.y = 0.9;

      const rect = stage.getBoundingClientRect();
      const W = Math.max(320, Math.floor(rect.width));
      const H = Math.max(420, Math.floor(rect.height));

      const wallOpts = { isStatic:true, restitution:0.85, friction:0.02 };
      // Walls: keep sides/bottom. Put top wall far above so "rain" can enter without getting stuck.
      Composite.add(engine.world, [
        Bodies.rectangle(W/2, -1200, W+260, 200, wallOpts),
        Bodies.rectangle(W/2, H+24, W+200, 48, wallOpts),
        Bodies.rectangle(-24, H/2, 48, H+200, wallOpts),
        Bodies.rectangle(W+24, H/2, 48, H+200, wallOpts),
      ]);

      const baseW = isMobileLike() ? Math.min(120, Math.max(86, Math.floor(W/5))) : Math.min(200, Math.max(140, Math.floor(W/6)));
      const bodies = [];
      const currentNames = new Set();

      function makeBubble(f, i, opts = {}){
        const h = hashString(f.name);
        const rr = (h % 1000) / 1000;

        const el = document.createElement('div');
        el.className = 'bubbleTile';
        el.setAttribute('data-name', f.name);

        // mild shape variety
        const inMiddle = (i >= 2) && (i <= files.length - 3);
        // shape ratio: 25% circle + 25% ellipse (only for middle band)
        if (inMiddle && rr < 0.25) el.classList.add('circle');
        else if (inMiddle && rr < 0.50) el.classList.add('ellipse');

        let w = baseW;
        let hpx = Math.round(baseW * 1.25);
        if (el.classList.contains('circle')) hpx = w;
        else if (el.classList.contains('ellipse')) hpx = Math.round(w * 0.72);

        el.style.width = w + 'px';
        el.style.height = hpx + 'px';

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = f.thumbUrl || f.url;
        img.alt = f.name;
        el.appendChild(img);

        // like overlay
        const likeWrap = document.createElement('div');
        likeWrap.className = 'likeBtn';
        likeWrap.innerHTML = '<span class="heart">❤</span><span class="count">0</span>';
        likeWrap.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isLiked(f.name)) return;
          try {
            const r = await fetch('/api/like', {
              method:'POST',
              headers:{ 'Content-Type':'application/json' },
              body: JSON.stringify({ dir: currentDir || '', name: f.name })
            });
            const j = await r.json();
            if (j && j.ok && typeof j.count === 'number') {
              likes.set(String(f.name), j.count);
              markLiked(f.name);
              setLikeUI(el, f.name);
            }
          } catch {}
        });
        el.appendChild(likeWrap);
        setLikeUI(el, f.name);

        el.addEventListener('click', () => {
          const idx = currentFiles.findIndex(x => x.name === f.name);
          openLb(Math.max(0, idx));
        });

        // optional fade-in (used for "rain" new tiles)
        const fadeInPending = !!opts.fadeIn;
        if (fadeInPending) {
          el.style.opacity = '0';
        }

        stage.appendChild(el);

        const x = (typeof opts.x === 'number') ? opts.x : (40 + (rr * (W - w - 80)) + w/2);
        const y = (typeof opts.y === 'number') ? opts.y : (20 + (i * 6));
        const body = Bodies.rectangle(x, y, w, hpx, { restitution:0.88, friction:0.05, frictionAir: (opts.air != null ? opts.air : 0.025) });
        Composite.add(engine.world, body);

        if (opts.vx != null || opts.vy != null) {
          try { Body.setVelocity(body, { x: opts.vx || 0, y: opts.vy || 0 }); } catch {}
        }

        currentNames.add(f.name);
        bodies.push({ body, el, w, h: hpx, name: f.name, fadeInPending });
      }

      for (let i=0;i<files.length;i++) makeBubble(files[i], i);

      const runner = Runner.create();
      Runner.run(runner, engine);

      // subtle drift (avoid fighting the "rain" feeling)
      const kickInt = setInterval(() => {
        for (const it of bodies){
          Body.applyForce(it.body, it.body.position, { x:(Math.random()-0.5)*0.0010, y:0 });
        }
      }, 800);

      // rotate bubbles to show more
      let swapInt = 0;
      if ((data.total || currentFiles.length) > MAX) {
        const pool = currentFiles.slice();
        let rrIdx = 0;
        swapInt = setInterval(() => {
          if (!bodies.length || !pool.length) return;
          const swapCount = isMobileLike() ? 3 : 5;
          for (let s=0; s<swapCount; s++) {
            // Prefer removing the lowest (bottom-most) tiles first,
            // so the top stays "new" and everything gradually rains down.
            let idx = -1;
            let bestY = -Infinity;
            for (let i=0; i<bodies.length; i++) {
              const it = bodies[i];
              if (!it || !it.body) continue;
              const y = (it.body.position && typeof it.body.position.y === 'number') ? it.body.position.y : 0;
              if (y > bestY) { bestY = y; idx = i; }
            }
            if (idx < 0) return;
            const victim = bodies[idx];
            if (!victim) continue;

            // choose next not on screen
            let nf = null;
            for (let tries=0; tries<pool.length; tries++) {
              const cand = pool[rrIdx % pool.length];
              rrIdx++;
              if (cand && !currentNames.has(cand.name)) { nf = cand; break; }
            }
            if (!nf) continue;

            // remove old
            try { Composite.remove(engine.world, victim.body); } catch {}
            try { victim.el.remove(); } catch {}
            currentNames.delete(victim.name);
            bodies.splice(idx, 1);

            // add new as "rain": spawn above viewport and fall down
            const rx = 40 + (Math.random() * (W - 80));
            const spawnY = -260 - Math.floor(Math.random() * 220);
            makeBubble(nf, 2 + Math.floor(Math.random() * Math.max(1, MAX-4)), {
              x: rx,
              y: spawnY,
              // gentle drift
              vx: (Math.random() - 0.5) * 0.8,
              // fall speed: slow but clearly visible
              vy: 3.0 + Math.random() * 1.2,
              // air resistance for a softer fall (but not stuck)
              air: 0.04,
              fadeIn: true
            });
          }
        }, 5000);
      }

      // render loop
      let rafId = 0;
      (function raf(){
        for (const it of bodies){
          const b = it.body;
          it.el.style.transform = 'translate(' + (b.position.x - it.w/2) + 'px,' + (b.position.y - it.h/2) + 'px) rotate(' + b.angle + 'rad)';
          // fade in only after the tile has actually entered the viewport area
          if (it.fadeInPending && b.position.y > 40) {
            it.fadeInPending = false;
            it.el.style.opacity = '1';
          }
        }
        rafId = requestAnimationFrame(raf);
      })();

      // ensure we can tear down when switching dirs/modes
      bubbleCleanup = () => {
        try { if (kickInt) clearInterval(kickInt); } catch {}
        try { if (swapInt) clearInterval(swapInt); } catch {}
        try { if (rafId) cancelAnimationFrame(rafId); } catch {}
        try { Runner.stop(runner); } catch {}
        try { Matter.Engine.clear(engine); } catch {}
        try { stage.remove(); } catch {}
      };

      return;
    }

    // collage mode
    if (viewMode === 'collage') {
      const cont = document.createElement('div');
      cont.className = 'collage';
      const classes = ['c1','c2','c3','c4','c5','c6','c7','c8','c9','c10'];
      const activeNames = new Set();
      let timer = null;

      function pickNext(excludeName){
        if (!currentFiles.length) return null;
        // try to avoid duplicates
        for (let tries=0; tries<40; tries++) {
          const cand = currentFiles[Math.floor(Math.random() * currentFiles.length)];
          if (!cand) continue;
          if (cand.name === excludeName) continue;
          if (activeNames.has(cand.name)) continue;
          return cand;
        }
        // fallback
        return currentFiles[Math.floor(Math.random() * currentFiles.length)];
      }

      function setTileImg(tile, file){
        if (!tile || !file) return;
        const a = tile.querySelector('.cImg.a');
        const b = tile.querySelector('.cImg.b');
        if (!a || !b) return;

        const curOnA = a.classList.contains('on');
        const activeImg = curOnA ? a : b;
        const nextImg = curOnA ? b : a;

        const oldName = tile.getAttribute('data-name') || '';
        if (oldName) activeNames.delete(oldName);
        tile.setAttribute('data-name', file.name);
        activeNames.add(file.name);

        const primary = file.thumbUrl || file.url;
        const fallback = file.url;

        // prepare next image (start hidden)
        nextImg.classList.remove('on');

        let swapped = false;
        const doSwap = () => {
          if (swapped) return;
          swapped = true;
          // fade in next, fade out active
          nextImg.classList.add('on');
          activeImg.classList.remove('on');
        };

        // Only swap after the next image is actually ready.
        // (Avoid swapping to a blank tile when network/cache is slow.)
        nextImg.onload = async () => {
          try {
            // decode helps avoid a white flash on some browsers
            if (nextImg.decode) await nextImg.decode();
          } catch {}
          requestAnimationFrame(doSwap);
        };
        nextImg.onerror = () => {
          // if thumb failed, try original image once
          if (String(nextImg.src || '').includes('/api/thumb') && fallback) {
            nextImg.src = fallback;
          }
          // if fallback also fails, keep current image (do not swap)
        };

        nextImg.src = primary;
      }

      const tiles = [];
      for (let i=0; i<classes.length; i++) {
        const t = document.createElement('div');
        t.className = 'cTile ' + classes[i];
        // add a little shape variety (subtle)
        // circles look best on smaller tiles
        const isSmall = ['c2','c7','c8','c9','c10'].includes(classes[i]);
        if (isSmall) {
          const r = Math.random();
          if (r < 0.22) t.classList.add('circle');
        }
        // double-buffered images for smooth crossfade
        t.innerHTML = '<img class="cImg a on" alt="" /><img class="cImg b" alt="" />' +
          '<div class="likeBtn" role="button" aria-label="点赞"><span class="heart">❤</span><span class="count">0</span></div>';
        const f = pickNext('');
        setTileImg(t, f);

        const lb = t.querySelector('.likeBtn');
        if (lb) {
          lb.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = t.getAttribute('data-name') || '';
            if (!name || isLiked(name)) return;
            try {
              const r = await fetch('/api/like', {
                method:'POST',
                headers:{ 'Content-Type':'application/json' },
                body: JSON.stringify({ dir: currentDir || '', name })
              });
              const j = await r.json();
              if (j && j.ok && typeof j.count === 'number') {
                likes.set(String(name), j.count);
                markLiked(name);
                setLikeUI(t, name);
              }
            } catch {}
          });
        }
        // initial
        const n0 = t.getAttribute('data-name') || '';
        if (n0) setLikeUI(t, n0);

        t.addEventListener('click', () => {
          const name = t.getAttribute('data-name') || '';
          const idx = currentFiles.findIndex(x => x.name === name);
          openLb(Math.max(0, idx));
        });
        cont.appendChild(t);
        tiles.push(t);
      }

      // auto update: every 5s randomly swap ONE small tile (avoid full refresh)
      const smallClassSet = new Set(['c2','c7','c8','c9','c10','c6']);
      const smallTiles = tiles.filter(t => {
        const cls = String(t.className || '');
        for (const k of smallClassSet) if (cls.includes(k)) return true;
        return false;
      });
      const pool = (smallTiles.length ? smallTiles : tiles);

      timer = setInterval(() => {
        if (!pool.length) return;
        const t = pool[Math.floor(Math.random() * pool.length)];
        const cur = t.getAttribute('data-name') || '';
        const nf = pickNext(cur);
        setTileImg(t, nf);
      }, 5000);

      // cleanup hook
      bubbleCleanup = () => {
        try { if (timer) clearInterval(timer); } catch {}
        timer = null;
      };

      $('content').innerHTML = '';
      $('content').appendChild(cont);
      return;
    }

    // masonry
    $('content').innerHTML = '';
    gridEl = document.createElement('div');
    gridEl.className = 'grid';

    const totalCount = data.total || currentFiles.length;
    for (let i=0;i<currentFiles.length;i++){
      gridEl.appendChild(makeTile(i, currentFiles[i], totalCount));
    }

    $('content').appendChild(gridEl);
    mountSentinel();
  }

  // initial load (wait a tick to ensure DOM is ready)
  try {
    if ($('content')) $('content').innerHTML = '<div class="empty">加载中…</div>';
    await new Promise(r => requestAnimationFrame(r));
    await load('');
  } catch (e) {
    console.error('initial load crashed', e);
    showFatal(e);
    setTimeout(() => load('').catch(err => { console.error('retry load failed', err); showFatal(err); }), 800);
  }
})();
