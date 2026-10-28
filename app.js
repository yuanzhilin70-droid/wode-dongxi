/* 我的东西 —— 前端逻辑
 * 数据先写进手机本地（localStorage），再和电脑上的 notes.json 同步；
 * 断网时照常能记，联网后自动补上。
 */
(() => {
  'use strict';

  const STORE_KEY = 'wode-dongxi.v1';
  const $ = (sel, root = document) => root.querySelector(sel);

  const el = {
    sync: $('#sync'),
    q: $('#q'),
    qClear: $('#q-clear'),
    chips: $('#chips'),
    list: $('#list'),
    fab: $('#fab'),
    menuBtn: $('#btn-menu'),
    editor: $('#editor'),
    fTitle: $('#f-title'),
    fBody: $('#f-body'),
    fCat: $('#f-cat'),
    fTags: $('#f-tags'),
    fPin: $('#f-pin'),
    fDel: $('#f-del'),
    fHint: $('#f-hint'),
    catList: $('#cat-list'),
    menu: $('#menu'),
    menuStat: $('#menu-stat'),
    importFile: $('#import-file'),
    toast: $('#toast'),
  };

  const state = {
    items: {},
    deleted: {},
    query: '',
    filter: 'all',
    editingId: null,
    sheetOpen: null,
    offline: false,
  };

  let snapshot = '';
  let toastTimer = 0;
  let pushTimer = 0;
  let pushing = false;

  /* ------------------------------------------------------------ 小工具 */

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function newId() {
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (ts >= today) return '今天 ' + hm;
    if (ts >= today - 86400000) return '昨天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function normItem(it) {
    return {
      id: String(it.id),
      title: String(it.title || ''),
      body: String(it.body || ''),
      cat: String(it.cat || '').trim(),
      tags: Array.isArray(it.tags) ? it.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      pinned: Boolean(it.pinned),
      createdAt: Number(it.createdAt) || Date.now(),
      updatedAt: Number(it.updatedAt) || Number(it.createdAt) || Date.now(),
    };
  }

  function merge(a, b) {
    const out = { items: { ...a.items }, deleted: { ...a.deleted } };
    const bi = (b && b.items) || {};
    for (const id of Object.keys(bi)) {
      const inc = normItem(bi[id]);
      const cur = out.items[id];
      if (!cur || inc.updatedAt >= cur.updatedAt) {
        out.items[id] = inc;
        if (out.deleted[id] !== undefined && out.deleted[id] <= inc.updatedAt) delete out.deleted[id];
      }
    }
    const bd = (b && b.deleted) || {};
    for (const id of Object.keys(bd)) {
      const ts = Number(bd[id]);
      if (!(ts > (out.deleted[id] || 0))) continue;
      out.deleted[id] = ts;
      if (out.items[id] && out.items[id].updatedAt <= ts) delete out.items[id];
    }
    return out;
  }

  /* ------------------------------------------------------------ 本地存储 */

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      state.items = {};
      state.deleted = {};
      const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
      for (const id of Object.keys(items)) state.items[id] = normItem(items[id]);
      if (raw.deleted && typeof raw.deleted === 'object') state.deleted = { ...raw.deleted };
    } catch {
      state.items = {};
      state.deleted = {};
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ items: state.items, deleted: state.deleted }));
    } catch {
      toast('本地空间满了，先导出备份吧');
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  function allItems() {
    return Object.values(state.items);
  }

  function categories() {
    const map = new Map();
    for (const it of allItems()) {
      if (!it.cat) continue;
      map.set(it.cat, (map.get(it.cat) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  }

  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    let list = allItems().filter((it) => {
      if (state.filter === 'pinned') return it.pinned;
      if (state.filter.startsWith('cat:')) return it.cat === state.filter.slice(4);
      return true;
    });
    if (q) {
      list = list.filter((it) =>
        (it.title + '\n' + it.body + '\n' + it.cat + '\n' + it.tags.join(' ')).toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  function renderChips() {
    const cats = categories();
    const pinnedCount = allItems().filter((i) => i.pinned).length;
    let html = `<button class="chip" type="button" data-filter="all" aria-pressed="${state.filter === 'all'}">全部<b>${allItems().length}</b></button>`;
    if (pinnedCount) {
      html += `<button class="chip" type="button" data-filter="pinned" aria-pressed="${state.filter === 'pinned'}">置顶<b>${pinnedCount}</b></button>`;
    }
    for (const [name, n] of cats) {
      const active = state.filter === 'cat:' + name;
      html += `<button class="chip" type="button" data-filter="cat:${esc(name)}" aria-pressed="${active}">${esc(name)}<b>${n}</b></button>`;
    }
    el.chips.innerHTML = html;

    // 当前分类被删空了就回到「全部」
    if (state.filter.startsWith('cat:') && !cats.some(([n]) => 'cat:' + n === state.filter)) {
      state.filter = 'all';
      renderChips();
    }
  }

  function cardHtml(it) {
    const tags = it.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
    const title = it.title ? `<h2>${esc(it.title)}</h2>` : '';
    const body = it.body ? `<p class="body">${esc(it.body)}</p>` : '';
    const cat = it.cat ? `<span class="cat-pill">${esc(it.cat)}</span>` : '';
    return `<div class="card" role="button" tabindex="0" data-id="${esc(it.id)}">
      ${it.pinned ? '<span class="pin-mark"></span>' : ''}
      ${title}${body}
      <span class="meta">${cat}${tags}<span class="time">${fmtTime(it.updatedAt)}</span></span>
    </div>`;
  }

  function emptyHtml() {
    if (state.query.trim()) {
      return `<div class="empty"><div class="big">没找到</div><p>换个词试试，或者清空搜索。</p></div>`;
    }
    if (state.filter !== 'all') {
      return `<div class="empty"><div class="big">这里还空着</div><p>换到「全部」看看，或者记一条新的。</p></div>`;
    }
    return `<div class="empty">
      <div class="big">还没有东西</div>
      <p>点右下角的 + ，记下第一条。</p>
      <p>写完自动存在电脑上，手机上随时能看。</p>
    </div>`;
  }

  function renderList() {
    const list = visibleItems();
    el.list.innerHTML = list.length ? list.map(cardHtml).join('') : emptyHtml();
  }

  function renderAll() {
    renderChips();
    renderList();
    renderCatList();
  }

  function renderCatList() {
    el.catList.innerHTML = categories()
      .map(([name]) => `<option value="${esc(name)}"></option>`)
      .join('');
  }

  /* ------------------------------------------------------------ 面板开关 */

  function anySheetOpen() {
    return !el.editor.hidden || !el.menu.hidden;
  }

  function openSheet(sheet) {
    sheet.hidden = false;
    // 先渲染一帧再加 class，才会有滑入动画
    requestAnimationFrame(() => sheet.classList.add('open'));
    document.body.style.overflow = 'hidden';
    state.sheetOpen = sheet;
  }

  function closeSheet(sheet, done) {
    sheet.classList.remove('open');
    document.body.style.overflow = '';
    window.setTimeout(() => {
      if (!sheet.classList.contains('open')) sheet.hidden = true;
      state.sheetOpen = null;
      if (done) done();
    }, 300);
  }

  /* ------------------------------------------------------------ 编辑 */

  function openEditor(id) {
    state.editingId = id || null;
    const it = id ? state.items[id] : null;

    el.fTitle.value = it ? it.title : '';
    el.fBody.value = it ? it.body : '';
    el.fCat.value = it ? it.cat : state.filter.startsWith('cat:') ? state.filter.slice(4) : '';
    el.fTags.value = it ? it.tags.join(', ') : '';
    el.fPin.checked = it ? it.pinned : false;
    el.fDel.hidden = !it;
    $('.sheet-title', el.editor).textContent = it ? '编辑' : '写点什么';
    el.fHint.textContent = it ? '上次修改：' + fmtTime(it.updatedAt) : '';
    snapshot = draftKey();
    autoGrow();

    openSheet(el.editor);
    if (!it) window.setTimeout(() => el.fTitle.focus(), 320);
  }

  function draftKey() {
    return [el.fTitle.value, el.fBody.value, el.fCat.value, el.fTags.value, el.fPin.checked ? '1' : '0'].join('\u0001');
  }

  function closeEditor() {
    closeSheet(el.editor);
    state.editingId = null;
  }

  function autoGrow() {
    el.fBody.style.height = 'auto';
    el.fBody.style.height = Math.max(el.fBody.scrollHeight, 160) + 'px';
  }

  function readDraft() {
    return {
      title: el.fTitle.value.trim(),
      body: el.fBody.value.replace(/\s+$/, ''),
      cat: el.fCat.value.trim(),
      tags: el.fTags.value
        .split(/[,，、;；\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8),
      pinned: el.fPin.checked,
    };
  }

  function saveEditor() {
    const d = readDraft();
    const id = state.editingId;
    const now = Date.now();

    if (!id && !d.title && !d.body) {
      closeEditor();
      return;
    }
    if (id) {
      const cur = state.items[id];
      if (!cur) return closeEditor();
      const same =
        cur.title === d.title &&
        cur.body === d.body &&
        cur.cat === d.cat &&
        cur.pinned === d.pinned &&
        cur.tags.join('\u0001') === d.tags.join('\u0001');
      if (same) return closeEditor();
      state.items[id] = { ...cur, ...d, updatedAt: now };
    } else {
      const nid = newId();
      state.items[nid] = { id: nid, ...d, createdAt: now, updatedAt: now };
    }
    saveStore();
    renderAll();
    closeEditor();
    schedulePush();
    toast(id ? '已保存' : '记下了');
  }

  function deleteCurrent() {
    const id = state.editingId;
    if (!id || !state.items[id]) return;
    if (!window.confirm('删掉这条记录？删了就找不回来了。')) return;
    delete state.items[id];
    state.deleted[id] = Date.now();
    saveStore();
    renderAll();
    closeEditor();
    schedulePush();
    toast('已删除');
  }

  /* ------------------------------------------------------------ 同步 */

  // 没有电脑在旁边（比如放在网上的版本）时，自动变成「只存这台设备」
  let localOnly = false;

  function setSync(s) {
    el.sync.dataset.state = s;
    el.sync.title =
      s === 'syncing' ? '正在同步…' : s === 'offline' ? '连不上电脑，改动先存在手机里' : '已同步';
  }

  function enterLocalMode() {
    if (localOnly) return;
    localOnly = true;
    el.sync.hidden = true;
    const sbtn = el.menu.querySelector('[data-act="sync"]');
    if (sbtn) sbtn.hidden = true;
    toast('记录只存在这台设备上');
  }

  function applyRemote(data) {
    const before = signature();
    const merged = merge(state, data);
    state.items = merged.items;
    state.deleted = merged.deleted;
    saveStore();
    if (signature() === before) return; // 没变化就不重绘，避免列表闪
    renderAll();
  }

  function signature() {
    const ids = Object.keys(state.items).sort();
    let s = '';
    for (const id of ids) s += id + ':' + state.items[id].updatedAt + ';';
    return s + '#' + JSON.stringify(state.deleted);
  }

  async function apiGet() {
    const r = await fetch('./api/notes', { cache: 'no-store' });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.permanent = r.status === 404 || r.status === 405;
      throw e;
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      const e = new Error('没有数据接口');
      e.permanent = true;
      throw e;
    }
    return r.json();
  }

  async function apiPost() {
    const r = await fetch('./api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: Object.values(state.items), deleted: state.deleted }),
    });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.permanent = r.status === 404 || r.status === 405;
      throw e;
    }
    return r.json();
  }

  let pushedSig = '';

  async function push() {
    if (localOnly || pushing) return;
    if (signature() === pushedSig) {
      setSync('idle');
      return;
    }
    pushing = true;
    setSync('syncing');
    try {
      const data = await apiPost();
      applyRemote(data);
      pushedSig = signature();
      state.offline = false;
      setSync('idle');
    } catch (err) {
      if (err && err.permanent) return enterLocalMode();
      state.offline = true;
      setSync('offline');
    } finally {
      pushing = false;
    }
  }

  function schedulePush() {
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(push, 400);
  }

  async function syncNow() {
    if (localOnly || pushing) return;
    setSync('syncing');
    try {
      const data = await apiGet();
      applyRemote(data);
      state.offline = false;
      setSync('idle');
    } catch (err) {
      if (err && err.permanent) return enterLocalMode();
      state.offline = true;
      setSync('offline');
      return;
    }
    await push();
  }

  /* ------------------------------------------------------------ 提示条 */

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), 1900);
  }

  /* ------------------------------------------------------------ 备份 */

  function exportBackup() {
    const data = {
      app: '我的东西',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: Object.values(state.items).sort((a, b) => b.updatedAt - a.updatedAt),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = url;
    a.download = `我的东西-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('备份已下载');
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : parsed.items ? Object.values(parsed.items) : [];
        if (!list.length) return toast('这个文件里没有记录');
        const incoming = { items: {}, deleted: {} };
        for (const raw of list) {
          if (!raw || !raw.id) continue;
          const it = normItem(raw);
          incoming.items[it.id] = it;
        }
        const merged = merge(state, incoming);
        state.items = merged.items;
        state.deleted = merged.deleted;
        saveStore();
        renderAll();
        push();
        toast(`导入 ${Object.keys(incoming.items).length} 条`);
      } catch {
        toast('文件读不出来，确认是导出过的 .json');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------ 事件 */

  el.fab.addEventListener('click', () => openEditor(null));
  el.menuBtn.addEventListener('click', () => {
    el.menuStat.textContent =
      `共 ${allItems().length} 条 · ` +
      (localOnly
        ? '只存在这台手机上'
        : state.offline
          ? '现在连不上电脑（改动已存在手机里）'
          : '已和电脑同步');
    openSheet(el.menu);
  });

  el.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderAll();
  });

  el.list.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openEditor(card.dataset.id);
  });

  el.list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    openEditor(card.dataset.id);
  });

  let qTimer = 0;
  el.q.addEventListener('input', () => {
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => {
      state.query = el.q.value;
      el.qClear.hidden = !el.q.value;
      renderList();
    }, 120);
  });

  el.qClear.addEventListener('click', () => {
    el.q.value = '';
    state.query = '';
    el.qClear.hidden = true;
    renderList();
    el.q.focus();
  });

  el.editor.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'close') {
      if (draftKey() !== snapshot && (el.fTitle.value.trim() || el.fBody.value.trim())) {
        if (!window.confirm('还没保存，要丢掉吗？')) return;
      }
      closeEditor();
    }
    if (act.dataset.act === 'save') saveEditor();
  });

  el.fDel.addEventListener('click', deleteCurrent);
  el.fBody.addEventListener('input', autoGrow);
  el.fTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.fBody.focus();
    }
  });
  el.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveEditor();
    }
  });

  el.menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const name = act.dataset.act;
    if (name === 'menu-close') closeSheet(el.menu);
    if (name === 'export') exportBackup();
    if (name === 'import') el.importFile.click();
    if (name === 'sync') {
      syncNow();
      toast('正在同步…');
    }
    if (name === 'wipe') {
      if (!window.confirm('清空全部记录？这个操作没法撤销。')) return;
      if (!window.confirm('真的全删掉？建议先导出备份。')) return;
      const now = Date.now();
      for (const id of Object.keys(state.items)) state.deleted[id] = now;
      state.items = {};
      saveStore();
      renderAll();
      closeSheet(el.menu);
      push();
      toast('已清空');
    }
  });

  el.importFile.addEventListener('change', () => {
    const f = el.importFile.files && el.importFile.files[0];
    if (f) importBackup(f);
    el.importFile.value = '';
  });

  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });

  // 页面开着的时候也定时对一下，电脑上刚记的内容这边十几秒就能看到
  let tick = 0;
  window.setInterval(() => {
    tick += 1;
    if (localOnly) return;
    if (document.visibilityState !== 'visible') return;
    if (state.offline) return syncNow();            // 掉线时每 5 秒重试
    if (tick % 3 !== 0) return;                     // 正常每 15 秒拉一次
    if (!el.editor.hidden || !el.menu.hidden) return; // 正在编辑/看菜单时不打扰
    syncNow();
  }, 5000);

  /* ------------------------------------------------------------ 启动 */

  loadStore();
  renderAll();
  setSync('idle');
  syncNow();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
