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

  let metaEnabled = false;
  try { metaEnabled = (localStorage.getItem('gallery_meta') === '1'); } catch {}

  // selection
  let selectMode = false;
  const selected = new Set();

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

  function setMetaEnabled(on){
    metaEnabled = !!on;
    try { localStorage.setItem('gallery_meta', metaEnabled ? '1' : '0'); } catch {}
    if ($('metaToggle')) $('metaToggle').textContent = '信息：' + (metaEnabled ? '开' : '关');
    const meta = $('lbMeta');
    if (meta && !metaEnabled) { meta.classList.remove('show'); meta.style.display = 'none'; }
  }

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
      '<img loading="lazy" src="' + esc(thumb) + '" alt="" />';

    tile.addEventListener('click', (e) => {
      if (selectMode) { e.preventDefault(); toggleSelect(f.name, tile); return; }
      openLb(globalIndex);
    });

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
      const r2 = await fetch('/api/images?dir=' + encodeURIComponent(currentDir) + '&offset=' + nextOffset + '&limit=' + PAGE_SIZE);
      const d2 = await r2.json();
      if (d2.error) throw new Error(d2.error);

      const startIndex = currentFiles.length;
      currentFiles = currentFiles.concat(d2.files || []);
      nextOffset = d2.nextOffset || currentFiles.length;
      hasMore = !!d2.hasMore;

      const s = document.getElementById('sentinel');
      if (s) s.remove();

      const totalCount = d2.total || currentFiles.length;
      for (let i=0;i<(d2.files||[]).length;i++){
        gridEl.appendChild(makeTile(startIndex + i, d2.files[i], totalCount));
      }
      mountSentinel();
    } finally {
      isLoadingMore = false;
    }
  }

  // --- lightbox ---
  let zoom = 1, panX = 0, panY = 0;
  let rafPending = false;
  function applyZoom(){
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const img = getActiveImg();
      if (!img) return;
      img.style.transform = 'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + zoom + ')';
    });
  }
  function resetZoom(){ zoom = 1; panX = 0; panY = 0; const img = getActiveImg(); if (img) img.style.transformOrigin = '50% 50%'; applyZoom(); }

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

  async function updateMetaOverlay(){
    const meta = $('lbMeta');
    if (!meta) return;
    if (!metaEnabled || !$('lb').classList.contains('open')) {
      meta.classList.remove('show');
      meta.style.display = 'none';
      return;
    }
    const f = currentFiles[currentIndex];
    if (!f) return;

    meta.style.display = 'block';
    meta.textContent = '读取中…';
    meta.classList.add('show');

    try {
      const r = await fetch('/api/meta?dir=' + encodeURIComponent(currentDir || '') + '&name=' + encodeURIComponent(f.name));
      const j = await r.json();
      const parts = [];
      if (j.takenAt) {
        const d = new Date(j.takenAt);
        parts.push(!isNaN(d.getTime()) ? d.toLocaleString() : String(j.takenAt));
      }
      if (j.place) {
        const segs = String(j.place).split(',').map(s => s.trim()).filter(Boolean);
        // 只保留景区/POI（第一段），避免显示一长串地址
        if (segs.length) parts.push(segs[0]);
      }
      meta.textContent = parts.filter(Boolean).join(' · ') || '暂无信息';
    } catch {
      meta.textContent = '暂无信息';
    }
  }

  function showLbInternal(index){
    if (!currentFiles.length) return;
    if (index < 0) index = currentFiles.length - 1;
    if (index >= currentFiles.length) index = 0;
    currentIndex = index;
    const f = currentFiles[currentIndex];

    const lb = $('lb');
    lb.classList.add('open');
    lb.classList.add('ctlHide');

    const nextImg = getInactiveImg();
    if (nextImg) {
      nextImg.style.transform = 'translate3d(0px,0px,0) scale(1)';
      nextImg.style.transformOrigin = '50% 50%';

      if (autoplayEnabled && autoplayRunning) { apFrom = 0; apSet(0); }

      nextImg.addEventListener('load', () => {
        swapActiveImg(nextImg);
        resetZoom();
        if (autoplayEnabled && autoplayRunning) apStartShown();
      }, { once:true });

      nextImg.src = f.url;
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
    updateMetaOverlay();
  }

  function openLb(index){
    autoplayEnabled = false;
    autoplayRunning = false;
    apStop();
    showLbInternal(index);
  }

  function closeLb(){
    $('lb').classList.remove('open');
    $('lb').classList.remove('immersive');
    document.body.classList.remove('immersive');
    autoplayEnabled = false;
    autoplayRunning = false;
    apStop();
    resetZoom();
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

  // settings modal toggle
  const settings = $('settings');
  function openSettings(){ settings.classList.add('open'); }
  function closeSettings(){ settings.classList.remove('open'); }
  on('settingsBtn','click', (e) => {
    e.preventDefault();
    if (settings.classList.contains('open')) closeSettings(); else openSettings();
  });
  on('settingsClose','click', (e) => { e.preventDefault(); closeSettings(); });
  on('cancelSettings','click', (e) => { e.preventDefault(); closeSettings(); });
  if (settings) settings.addEventListener('click', (e) => { if (e.target === settings) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (settings.classList.contains('open') && e.key === 'Escape') closeSettings(); });

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
      viewMode = (v === 'bubble' || v === 'masonry' || v === 'collage') ? v : 'bubble';
      try { localStorage.setItem('gallery_view_mode', viewMode); } catch {}
    }

    if ($('bubbleCount')) {
      const def = (isMobileLike() ? 20 : 25);
      const n = clampInt($('bubbleCount').value, 5, 80) || def;
      bubbleCount = n;
      try { localStorage.setItem('gallery_bubble_count', String(n)); } catch {}
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
  function syncModeUI(vm){
    const mode = (vm === 'bubble' || vm === 'masonry' || vm === 'collage') ? vm : 'bubble';
    if ($('bubbleCountWrap')) $('bubbleCountWrap').style.display = (mode === 'bubble') ? 'flex' : 'none';
    if ($('collageHint')) $('collageHint').style.display = (mode === 'collage') ? 'flex' : 'none';
    if ($('colsWrap')) $('colsWrap').style.display = (mode === 'masonry') ? 'flex' : 'none';
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
  if ($('metaToggle')) {
    setMetaEnabled(metaEnabled);
    on('metaToggle','click', (e) => { e.preventDefault(); setMetaEnabled(!metaEnabled); updateMetaOverlay(); });
  }

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
    const r = await fetch('/api/delete?dir=' + encodeURIComponent(currentDir), {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ dir: currentDir, names })
    });
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
    await fetch('/api/upload?dir=' + encodeURIComponent(currentDir), { method:'POST', body: fd });
    if ($('file')) $('file').value = '';
    await load(currentDir);
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
      const r = await fetch('/api/images?dir=' + encodeURIComponent(currentDir) + '&offset=0&limit=' + PAGE_SIZE);
      data = await r.json();
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
      Composite.add(engine.world, [
        Bodies.rectangle(W/2, -24, W+200, 48, wallOpts),
        Bodies.rectangle(W/2, H+24, W+200, 48, wallOpts),
        Bodies.rectangle(-24, H/2, 48, H+200, wallOpts),
        Bodies.rectangle(W+24, H/2, 48, H+200, wallOpts),
      ]);

      const baseW = isMobileLike() ? Math.min(120, Math.max(86, Math.floor(W/5))) : Math.min(200, Math.max(140, Math.floor(W/6)));
      const bodies = [];
      const currentNames = new Set();

      function makeBubble(f, i){
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

        el.addEventListener('click', () => {
          const idx = currentFiles.findIndex(x => x.name === f.name);
          openLb(Math.max(0, idx));
        });

        stage.appendChild(el);

        const x = 40 + (rr * (W - w - 80)) + w/2;
        const y = 20 + (i * 6);
        const body = Bodies.rectangle(x, y, w, hpx, { restitution:0.9, friction:0.04, frictionAir:0.03 });
        Composite.add(engine.world, body);

        currentNames.add(f.name);
        bodies.push({ body, el, w, h: hpx, name: f.name });
      }

      for (let i=0;i<files.length;i++) makeBubble(files[i], i);

      const runner = Runner.create();
      Runner.run(runner, engine);

      // keep moving
      const kickInt = setInterval(() => {
        for (const it of bodies){
          Body.applyForce(it.body, it.body.position, { x:(Math.random()-0.5)*0.0012, y:(Math.random()-0.5)*0.0010 });
        }
      }, 650);

      // rotate bubbles to show more
      let swapInt = 0;
      if ((data.total || currentFiles.length) > MAX) {
        const pool = currentFiles.slice();
        let rrIdx = 0;
        swapInt = setInterval(() => {
          if (!bodies.length || !pool.length) return;
          const swapCount = isMobileLike() ? 3 : 5;
          for (let s=0; s<swapCount; s++) {
            const idx = Math.floor(Math.random() * bodies.length);
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

            // add new near top
            makeBubble(nf, 2 + Math.floor(Math.random() * Math.max(1, MAX-4)));
          }
        }, 5000);
      }

      // render loop
      let rafId = 0;
      (function raf(){
        for (const it of bodies){
          const b = it.body;
          it.el.style.transform = 'translate(' + (b.position.x - it.w/2) + 'px,' + (b.position.y - it.h/2) + 'px) rotate(' + b.angle + 'rad)';
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
        const img = tile.querySelector('img');
        if (!img) return;
        const oldName = tile.getAttribute('data-name') || '';
        if (oldName) activeNames.delete(oldName);
        tile.setAttribute('data-name', file.name);
        activeNames.add(file.name);

        // Avoid "blank tile" if onload doesn't fire (cached/blocked) by:
        // 1) setting a timeout to force-show
        // 2) falling back from thumbUrl -> url on error
        img.classList.remove('on');
        let forced = false;
        const forceShow = () => {
          if (forced) return;
          forced = true;
          img.classList.add('on');
        };
        const forceTimer = setTimeout(forceShow, 300);

        const primary = file.thumbUrl || file.url;
        const fallback = file.url;

        img.onload = () => {
          clearTimeout(forceTimer);
          // next frame so transition is reliable
          requestAnimationFrame(forceShow);
        };
        img.onerror = () => {
          clearTimeout(forceTimer);
          // if thumb failed, try original image once
          if (img.src && img.src.includes('/api/thumb') && fallback) {
            img.src = fallback;
            setTimeout(forceShow, 200);
          } else {
            forceShow();
          }
        };

        img.src = primary;
      }

      const tiles = [];
      for (let i=0; i<classes.length; i++) {
        const t = document.createElement('div');
        t.className = 'cTile ' + classes[i];
        t.innerHTML = '<img alt="" />';
        const f = pickNext('');
        setTileImg(t, f);
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
