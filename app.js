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
    list: $('#list'),
    fab: $('#fab'),
    menuBtn: $('#btn-menu'),
    editor: $('#editor'),
    fTitle: $('#f-title'),
    fBody: $('#f-body'),
    fUrl: $('#f-url'),
    fCat: $('#f-cat'),
    fTags: $('#f-tags'),
    fPin: $('#f-pin'),
    fDel: $('#f-del'),
    fHint: $('#f-hint'),
    catList: $('#cat-list'),
    menu: $('#menu'),
    menuStat: $('#menu-stat'),
    importFile: $('#import-file'),
    bookmarksFile: $('#bookmarks-file'),
    toast: $('#toast'),
  };

  const state = {
    items: {},
    deleted: {},
    folders: [],
    query: '',
    editingId: null,
    sheetOpen: null,
    offline: false,
  };

  let snapshot = '';
  let toastTimer = 0;
  let pushTimer = 0;
  let pushing = false;
  const expanded = new Set(); // 分类视图里展开了哪些文件夹

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
      url: String(it.url || ''),
      cat: String(it.cat || '').trim(),
      tags: Array.isArray(it.tags) ? it.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      pinned: Boolean(it.pinned),
      createdAt: Number(it.createdAt) || Date.now(),
      updatedAt: Number(it.updatedAt) || Number(it.createdAt) || Date.now(),
    };
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  /** 把用户随手填的网址补全成合法链接，填得不像网址就返回空 */
  function cleanUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
    try {
      const u = new URL(full);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch {
      return '';
    }
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
    state.folders = loadFolders();
    // 还没有存过顺序时，按条目当初导入的先后顺序来定文件夹顺序
    if (!state.folders.length) {
      const seen = [];
      for (const it of Object.values(state.items)) {
        if (it.cat && !seen.includes(it.cat)) seen.push(it.cat);
      }
      if (seen.length) {
        state.folders = seen;
        saveFolders();
      }
    }
  }

  function loadFolders() {
    try {
      const arr = JSON.parse(localStorage.getItem('wode-dongxi.folders') || '[]');
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string' && x.trim());
    } catch {
      /* 忽略 */
    }
    return [];
  }

  function saveFolders() {
    try {
      localStorage.setItem('wode-dongxi.folders', JSON.stringify(state.folders));
    } catch {
      /* 忽略 */
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ items: state.items, deleted: state.deleted, folders: state.folders })
      );
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

  function matchesQuery(it, q) {
    return (it.title + '\n' + it.body + '\n' + (it.url || '') + '\n' + it.cat + '\n' + it.tags.join(' '))
      .toLowerCase()
      .includes(q);
  }

  function sortedItems(arr) {
    return arr
      .slice()
      .sort((a, b) => (a.pinned === b.pinned ? b.updatedAt - a.updatedAt : a.pinned ? -1 : 1));
  }

  function emptyHtml() {
    if (state.query.trim()) {
      return `<div class="empty"><div class="big">没找到</div><p>换个词试试，或者清空搜索。</p></div>`;
    }
    return `<div class="empty">
      <div class="big">还没有东西</div>
      <p>点右下角的 + ，记下第一条。</p>
      <p>${localOnly ? '记录只存在这台设备上，偶尔导出备份更稳妥。' : '写完自动存在电脑上，手机上随时能看。'}</p>
    </div>`;
  }

  function renderSearch() {
    const q = state.query.trim().toLowerCase();
    const list = sortedItems(allItems().filter((it) => matchesQuery(it, q)));
    el.list.innerHTML = list.length
      ? `<div class="folders"><div class="search-head">找到 ${list.length} 条</div>${bookmarkList(list)}</div>`
      : emptyHtml();
  }

  function renderAll() {
    if (state.query.trim()) renderSearch();
    else renderFolders();
    renderCatList();
  }

  const FOLDER_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>';

  function folderRow(cat, name, count, open) {
    return `<button class="folder" type="button" data-toggle="${esc(cat)}">
      <span class="f-chev${open ? ' open' : ''}">›</span>
      <span class="f-ico">${FOLDER_ICON}</span>
      <span class="f-name">${esc(name)}</span>
      <span class="f-count">${count}</span>
    </button>`;
  }

  function bookmarkList(items) {
    const rows = items.map((it) => {
      const label = it.title || hostOf(it.url) || '(没有标题)';
      const letter = (hostOf(it.url) || label).slice(0, 1).toUpperCase();
      const badge = `<span class="b-badge">${esc(letter)}</span>`;
      const edit = `<button class="b-edit" type="button" data-edit="${esc(it.id)}" aria-label="编辑">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>
        </button>`;
      const main = it.url
        ? `<a class="b-main" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" title="${esc(it.url)}">${badge}<span class="b-title">${esc(label)}</span></a>`
        : `<button class="b-main" type="button" data-id="${esc(it.id)}">${badge}<span class="b-title">${esc(label)}</span></button>`;
      return `<div class="bookmark">${main}${edit}</div>`;
    });
    return `<div class="folder-items">${rows.join('')}</div>`;
  }

  function orderedFolders() {
    const derived = categories().map(([name]) => name);
    const out = [];
    for (const name of state.folders) if (!out.includes(name)) out.push(name);
    for (const name of derived) if (!out.includes(name)) out.push(name);
    return out;
  }

  function renderFolders() {
    const total = allItems().length;
    const counts = new Map(categories());
    const folders = orderedFolders();
    if (!total && !folders.length) {
      el.list.innerHTML = `<div class="folders">${folderRow('', '全部', 0, false)}</div>` + emptyHtml();
      return;
    }

    let html = folderRow('', '全部', total, expanded.has(''));
    if (expanded.has('')) html += bookmarkList(sortedItems(allItems()));

    html += `<button class="folder new-folder" type="button" data-new-folder="1">
      <span class="f-chev"></span>
      <span class="f-ico f-plus">＋</span>
      <span class="f-name">新建文件夹</span>
    </button>`;

    for (const name of folders) {
      const n = counts.get(name) || 0;
      const open = expanded.has(name);
      const items = sortedItems(allItems().filter((it) => it.cat === name));
      html += `<div class="folder-group" data-name="${esc(name)}">
        <div class="folder-row">
          <button class="f-main" type="button" data-toggle="${esc(name)}">
            <span class="f-chev${open ? ' open' : ''}">›</span>
            <span class="f-ico">${FOLDER_ICON}</span>
            <span class="f-name">${esc(name)}</span>
            <span class="f-count">${n}</span>
          </button>
          ${
            n === 0
              ? `<button class="f-del" type="button" data-del-folder="${esc(name)}" aria-label="删除空文件夹">×</button>`
              : ''
          }
          <span class="f-grip" aria-hidden="true">⠿</span>
        </div>
        ${open ? (items.length ? bookmarkList(items) : `<div class="folder-items"><div class="empty-row">这个文件夹还空着</div></div>`) : ''}
      </div>`;
    }

    const uncat = sortedItems(allItems().filter((it) => !it.cat));
    if (uncat.length) {
      const open = expanded.has('__none');
      html += folderRow('__none', '未分类', uncat.length, open);
      if (open) html += bookmarkList(uncat);
    }
    el.list.innerHTML = `<div class="folders">${html}</div>`;
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
    el.fUrl.value = it ? it.url || '' : '';
    el.fCat.value = it ? it.cat : '';
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
    return [el.fTitle.value, el.fBody.value, el.fUrl.value, el.fCat.value, el.fTags.value, el.fPin.checked ? '1' : '0'].join('\u0001');
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
      url: cleanUrl(el.fUrl.value),
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
        (cur.url || '') === d.url &&
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

  // 没有配云同步（或连不上）时，就只在本地保存
  let localOnly = false;

  function loadCloud() {
    try {
      const c = JSON.parse(localStorage.getItem('wode-dongxi.cloud') || 'null');
      if (c && typeof c.url === 'string' && c.url.trim()) {
        return { url: c.url.trim(), token: String(c.token || '') };
      }
    } catch {
      /* 忽略 */
    }
    return null;
  }

  function saveCloud(c) {
    try {
      if (c && c.url) localStorage.setItem('wode-dongxi.cloud', JSON.stringify(c));
      else localStorage.removeItem('wode-dongxi.cloud');
    } catch {
      /* 忽略 */
    }
  }

  let cloud = loadCloud();

  function cloudHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (cloud && cloud.token) h['x-sync-token'] = cloud.token;
    return h;
  }

  function setSync(s) {
    el.sync.dataset.state = s;
    el.sync.title =
      s === 'syncing' ? '正在同步…' : s === 'offline' ? '连不上云端，改动先存在本机' : '已同步';
  }

  function enterLocalMode(silent) {
    if (localOnly) return;
    localOnly = true;
    el.sync.hidden = true;
    const sbtn = el.menu.querySelector('[data-act="sync"]');
    if (sbtn) sbtn.hidden = true;
    renderAll(); // 空状态、文件夹视图的文案都要跟着换
    if (!silent) toast('记录只存在这台设备上');
  }

  function exitLocalMode() {
    localOnly = false;
    el.sync.hidden = false;
    const sbtn = el.menu.querySelector('[data-act="sync"]');
    if (sbtn) sbtn.hidden = false;
    setSync('idle');
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
    const r = await fetch(cloud.url, { cache: 'no-store', headers: cloudHeaders() });
    if (r.status === 401 || r.status === 403) {
      const e = new Error('口令不对');
      e.auth = true;
      throw e;
    }
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.permanent = r.status === 404 || r.status === 405;
      throw e;
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      const e = new Error('地址不是同步接口');
      e.permanent = true;
      throw e;
    }
    return r.json();
  }

  async function apiPost() {
    const r = await fetch(cloud.url, {
      method: 'POST',
      headers: cloudHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items: Object.values(state.items), deleted: state.deleted }),
    });
    if (r.status === 401 || r.status === 403) {
      const e = new Error('口令不对');
      e.auth = true;
      throw e;
    }
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.permanent = r.status === 404 || r.status === 405;
      throw e;
    }
    return r.json();
  }

  let pushedSig = '';

  async function push() {
    if (localOnly || !cloud || pushing) return;
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
      if (err && err.auth) {
        state.offline = true;
        setSync('offline');
        toast('口令不对，去「云同步设置」看看');
        return;
      }
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
    if (localOnly || !cloud || pushing) return;
    setSync('syncing');
    try {
      const data = await apiGet();
      applyRemote(data);
      state.offline = false;
      setSync('idle');
    } catch (err) {
      if (err && err.auth) {
        state.offline = true;
        setSync('offline');
        toast('口令不对，去「云同步设置」看看');
        return;
      }
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
      folders: state.folders,
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
        if (Array.isArray(parsed.folders)) {
          if (!state.folders.length) state.folders = parsed.folders.filter((x) => typeof x === 'string');
          else for (const n of parsed.folders) if (typeof n === 'string' && !state.folders.includes(n)) state.folders.push(n);
          saveFolders();
        }
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

  /* ------------------------------------------------------------ 浏览器书签 */

  /** 解析 Chrome / Edge 导出的 bookmarks.html：文件夹名当分类，<A> 当条目
   *  不用 DOM 树（浏览器的解析器会把 Netscape 书签格式的层级拆平），直接按标签顺序扫。
   */
  function parseBookmarks(text) {
    const found = [];
    const stack = [];
    let pending = null;

    const decode = (s) => {
      const ta = document.createElement('textarea');
      ta.innerHTML = s;
      return ta.value;
    };
    const clean = (s) => decode(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

    const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<dl\b[^>]*>|<\/dl>|<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      if (/^<h3/i.test(raw)) {
        pending = clean(m[1]);
      } else if (/^<dl/i.test(raw)) {
        stack.push(pending !== null ? pending : stack.length ? stack[stack.length - 1] : '');
        pending = null;
      } else if (/^<\/dl/i.test(raw)) {
        stack.pop();
        pending = null;
      } else {
        const url = decode(m[2] || '');
        if (!/^https?:/i.test(url)) continue;
        found.push({
          title: clean(m[3] || ''),
          url,
          cat: stack.length ? stack[stack.length - 1] : '',
        });
      }
    }
    return found;
  }

  function importBookmarks(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let list = [];
      try {
        list = parseBookmarks(String(reader.result));
      } catch {
        list = [];
      }
      if (!list.length) return toast('这个文件里没找到书签');

      const seen = new Set(
        Object.values(state.items)
          .map((i) => (i.url || '').replace(/\/$/, ''))
          .filter(Boolean)
      );
      const now = Date.now();
      let added = 0;
      let skipped = 0;
      for (const b of list) {
        const key = b.url.replace(/\/$/, '');
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        seen.add(key);
        const id = newId();
        state.items[id] = {
          id,
          title: b.title || hostOf(b.url),
          body: '',
          url: b.url,
          cat: b.cat || '',
          tags: [],
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        added += 1;
      }
      // 按文件里的先后顺序记住文件夹；第一次导入就照这个顺序排
      const seenOrder = [];
      for (const b of list) if (b.cat && !seenOrder.includes(b.cat)) seenOrder.push(b.cat);
      if (!state.folders.length) state.folders = seenOrder;
      else for (const n of seenOrder) if (!state.folders.includes(n)) state.folders.push(n);
      saveFolders();

      saveStore();
      renderAll();
      push();
      closeSheet(el.menu);
      toast(
        added
          ? `搬进来 ${added} 个书签${skipped ? `，跳过 ${skipped} 个重复的` : ''}`
          : '这些书签都已经在里面了'
      );
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------ 事件 */

  el.fab.addEventListener('click', () => openEditor(null));
  el.menuBtn.addEventListener('click', () => {
    el.menuStat.textContent = `共 ${allItems().length} 条 · 记录只存在这台设备上`;
    const hint = el.menu.querySelector('.hint');
    if (hint) {
      hint.textContent = '记录只存在这台设备上。建议偶尔「导出备份」，存到网盘或发给自己。';
    }
    openSheet(el.menu);
  });

  el.list.addEventListener('click', (e) => {
    if (e.target.closest('[data-new-folder]')) {
      createFolder();
      return;
    }
    const delFolder = e.target.closest('[data-del-folder]');
    if (delFolder) {
      const name = delFolder.dataset.delFolder;
      state.folders = state.folders.filter((n) => n !== name);
      saveFolders();
      renderFolders();
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      openEditor(editBtn.dataset.edit);
      return;
    }
    const bookmark = e.target.closest('.bookmark [data-id]');
    if (bookmark) {
      openEditor(bookmark.dataset.id);
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      renderFolders();
    }
  });

  function createFolder() {
    const name = (window.prompt('新文件夹的名字') || '').trim();
    if (!name) return;
    if (!state.folders.includes(name)) {
      state.folders.push(name);
      saveFolders();
    }
    renderFolders();
  }

  function saveOrderFromDom() {
    const names = [...el.list.querySelectorAll('.folder-group')]
      .map((g) => g.dataset.name)
      .filter(Boolean);
    if (!names.length) return;
    state.folders = names;
    saveFolders();
    toast('顺序已保存');
  }

  /* 拖动排序：按住行尾的 ⠿ 上下拖，手机和电脑都能用 */
  let dragEl = null;

  function onDragMove(e) {
    if (!dragEl || !dragEl.parentElement) return;
    const list = dragEl.parentElement;
    for (const group of list.querySelectorAll('.folder-group')) {
      if (group === dragEl) continue;
      const box = group.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) {
        if (group.previousElementSibling !== dragEl) list.insertBefore(dragEl, group);
        return;
      }
    }
    if (list.lastElementChild !== dragEl) list.appendChild(dragEl);
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
    saveOrderFromDom();
  }

  el.list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.f-grip');
    if (!grip) return;
    dragEl = grip.closest('.folder-group');
    if (!dragEl) return;
    e.preventDefault();
    dragEl.classList.add('dragging');
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    window.addEventListener('pointercancel', onDragEnd, { once: true });
  });

  let qTimer = 0;
  el.q.addEventListener('input', () => {
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => {
      state.query = el.q.value;
      el.qClear.hidden = !el.q.value;
      renderAll();
    }, 120);
  });

  el.qClear.addEventListener('click', () => {
    el.q.value = '';
    state.query = '';
    el.qClear.hidden = true;
    renderAll();
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
    if (name === 'import-bookmarks' && el.bookmarksFile) el.bookmarksFile.click();
    if (name === 'sync') {
      syncNow();
      toast('正在同步…');
    }
    if (name === 'wipe') {      if (!window.confirm('清空全部记录？这个操作没法撤销。')) return;
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

  if (el.bookmarksFile) {
    el.bookmarksFile.addEventListener('change', () => {
      const f = el.bookmarksFile.files && el.bookmarksFile.files[0];
      if (f) importBookmarks(f);
      el.bookmarksFile.value = '';
    });
  }

  /* ---- 云同步设置（已下线，需要时再打开） ---- */

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
  enterLocalMode(true); // 只在本地存：安静地关掉同步状态

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
