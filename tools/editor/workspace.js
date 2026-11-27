// Csay 编辑器：workspace.js
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function current() { return ACTIVE >= 0 && ACTIVE < TABS.length ? TABS[ACTIVE] : null; }
function parentPath(p) { return p.replace(/[\\/][^\\/]*$/, ''); }
function baseName(p) { return p.replace(/^.*[\\/]/, ''); }
function under(p, root) {
  var a = p.replace(/\//g, '\\').toLowerCase();
  var b = root.replace(/\//g, '\\').toLowerCase();
  return a === b || a.indexOf(b + '\\') === 0;
}
function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }
function targetDir() {
  if (SELECTED && SELECTED.dir) return SELECTED.path;
  var t = current();
  if (t) return parentPath(t.path);
  return TREE_ROOT || WORKSPACE;
}

function updateWelcome() { welcome.classList.toggle('hidden', !!current()); }
function updateTitle() {
  var t = current();
  fileTitle.textContent = t ? t.name : '未打开文件';
  document.title = t ? (t.name + ' - Csay 编辑器') : 'Csay 编辑器';
  updateWelcome();
}
function currentText() { return cm.getValue(); }

function saveSession() {
  var cur = current();
  if (cur) cur.cursor = cm.getCursor();
  var files = [];
  for (var i = 0; i < TABS.length; i++) {
    var t = TABS[i];
    if (t.floating || !t.path) continue;
    files.push({ path: t.path, cursor: t.cursor || { line: 0, ch: 0 } });
  }
  var session = {
    root: TREE_ROOT || WORKSPACE || '',
    active: cur ? cur.path : '',
    cursor: cur ? (cur.cursor || { line: 0, ch: 0 }) : null,
    files: files
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}

function readSession() {
  try {
    var session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session || typeof session.root !== 'string' || !Array.isArray(session.files)) return null;
    return session;
  } catch (e) { return null; }
}

function restoreSession() {
  var session = readSession();
  if (!session || (!session.root && session.files.length === 0)) return false;
  var chain = Promise.resolve();
  if (session.root) chain = chain.then(function () { return loadTree(session.root); });
  session.files.forEach(function (f) {
    if (!f || typeof f.path !== 'string') return;
    chain = chain.then(function () { return openPath(f.path); });
  });
  chain.then(function () {
    if (session.active) {
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].path === session.active) { activate(i); break; }
      }
    }
    if (current() && session.cursor) cm.setCursor(session.cursor);
    saveSession();
  }).catch(function (e) { setStatus('恢复上次打开失败：' + e, 'err'); });
  return true;
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (var i = 0; i < TABS.length; i++) {
    (function (idx) {
      var t = TABS[idx];
      if (t.floating) return;
      var tab = document.createElement('div');
      tab.className = 'tab' + (idx === ACTIVE ? ' active' : '');
      var name = document.createElement('span');
      name.textContent = t.name;
      if (t.dirty) {
        var dot = document.createElement('span');
        dot.className = 'dirty';
        dot.textContent = '●';
        name.appendChild(dot);
      }
      tab.appendChild(name);
      var close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.title = '关闭';
      close.addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(idx); });
      tab.appendChild(close);
      tab.addEventListener('click', function () {
        if (tab.dataset.dragged === '1') { delete tab.dataset.dragged; return; }
        activate(idx);
      });
      tab.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        var sx = ev.clientX, sy = ev.clientY;
        function move(e) {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 10) return;
          cleanup();
          tab.dataset.dragged = '1';
          floatTab(idx, e.clientX, e.clientY);
        }
        function cleanup() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', cleanup);
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', cleanup);
      });
      tab.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        showMenu(ev.clientX, ev.clientY, tabMenu(t));
      });
      tabsEl.appendChild(tab);
    })(i);
  }
}
function capture() {
  var t = current();
  if (t) { t.content = cm.getValue(); t.cursor = cm.getCursor(); }
}
function activate(idx) {
  if (idx < 0 || idx >= TABS.length) return;
  if (TABS[idx].floating) { if (TABS[idx].floatEditor) TABS[idx].floatEditor.focus(); return; }
  capture();
  ACTIVE = idx;
  var t = TABS[idx];
  FILE = t.path;
  loading = true;
  cm.setValue(t.content);
  loading = false;
  cm.clearHistory();
  cm.setCursor(t.cursor || { line: 0, ch: 0 });
  updateTitle();
  renderTabs();
  selectTreePath(t.path);
  cm.focus();
  scheduleCheck();
  updateCursor();
  refreshWorkspaceSources();
  saveSession();
}
function addTab(data) {
  var existing = -1;
  for (var i = 0; i < TABS.length; i++) if (TABS[i].path === data.file) existing = i;
  if (existing >= 0) { activate(existing); return; }
  TABS.push({ path: data.file, name: data.name, content: data.content, dirty: false, cursor: { line: 0, ch: 0 } });
  activate(TABS.length - 1);
}
function clearEditor() {
  ACTIVE = -1;
  FILE = '';
  loading = true;
  cm.setValue('');
  loading = false;
  updateTitle();
  renderTabs();
  showProblems([]);
  saveSession();
}
function removeTab(idx) {
  capture();
  var removed = TABS[idx];
  if (removed && removed.floating) removeFloat(removed);
  TABS.splice(idx, 1);
  if (TABS.length === 0) { clearEditor(); setStatus('就绪'); return; }
  if (idx <= ACTIVE) ACTIVE = Math.max(0, ACTIVE - 1);
  activate(Math.min(ACTIVE, TABS.length - 1));
}
function closeTab(idx) {
  var t = TABS[idx];
  if (!t) return;
  if (t.dirty) {
    askConfirm('关闭文件', '「' + t.name + '」有未保存修改，确定关闭并放弃？').then(function (ok) { if (ok) removeTab(idx); });
  } else removeTab(idx);
}
function selectTreePath(path) {
  if (!path) return;
  var target = String(path).split('\\').join('/');
  var rows = treeEl.querySelectorAll('[data-path]');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].dataset.path).split('\\').join('/') !== target) continue;
    var box = rows[i].closest('details');
    while (box) { box.open = true; box = box.parentElement ? box.parentElement.closest('details') : null; }
    SELECTED = { path: rows[i].dataset.path, dir: false, name: baseName(rows[i].dataset.path) };
    selectNode(SELECTED);
    rows[i].scrollIntoView({ block: 'nearest' });
    return;
  }
}
function openPath(path, line, col) {
  if (!path) return Promise.resolve(false);
  if (/\.csayproj$/i.test(path)) { selectTreePath(path); editProject(); return Promise.resolve(true); }
  for (var i = 0; i < TABS.length; i++) {
    if (TABS[i].path === path) {
      activate(i);
      selectTreePath(path);
      if (line) gotoLine(line, col || 1);
      return Promise.resolve(true);
    }
  }
  return fetch('/api/load?file=' + encodeURIComponent(path))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { setStatus(d.error, 'err'); return false; }
      addTab(d);
      if (!TREE_ROOT) loadTree(d.dir);
      selectTreePath(d.path);
      if (line) gotoLine(line, col || 1);
      return true;
    })
    .catch(function (e) { setStatus('打开失败：' + e, 'err'); return false; });
}

function reloadTabFile(path) {
  for (var i = 0; i < TABS.length; i++) {
    if (TABS[i].path !== path) continue;
    (function (idx) {
      fetch('/api/load?file=' + encodeURIComponent(path))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.content) return;
          var t = TABS[idx];
          t.content = d.content;
          t.dirty = false;
          if (idx === ACTIVE) {
            loading = true;
            cm.setValue(d.content);
            loading = false;
          }
          renderTabs();
        })
        .catch(function () {});
    })(i);
  }
}

function formatTab(t) {
  if (!SETTINGS.autoFormat || !/\.csay$/i.test(t.path)) return Promise.resolve(true);
  var text = t.path === FILE && !t.floating ? cm.getValue() : t.content;
  return fetch('/api/format', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: text }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) { setStatus('自动排版跳过：' + d.error, 'err'); return true; }
      if (d.content === text) return true;
      t.content = d.content;
      if (t.path === FILE && !t.floating) {
        var cur = cm.getCursor();
        loading = true;
        cm.setValue(d.content);
        loading = false;
        cm.setCursor(cur);
      }
      return true;
    })
    .catch(function () { return true; });
}

function saveTab(t) {
  if (!t) return Promise.resolve(false);
  if (t.path === FILE && !t.floating) t.content = cm.getValue();
  return formatTab(t).then(function () {
    return fetch('/api/save', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ file: t.path, content: t.content }) })
    .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { setStatus(d.error || '保存失败', 'err'); return false; }
        t.dirty = false;
        renderTabs();
        refreshWorkspaceSources();
        return true;
      })
      .catch(function (e) { setStatus('保存失败：' + e, 'err'); return false; });
  });
}
function doSave(silent) {
  var t = current();
  if (!t) { if (!silent) setStatus('没有打开的文件', 'err'); return Promise.resolve(false); }
  return saveTab(t).then(function (ok) {
    if (ok && !silent) setStatus('已保存', 'ok');
    return ok;
  });
}
function saveAll() {
  var chain = Promise.resolve(true);
  for (var i = 0; i < TABS.length; i++) {
    (function (t) { chain = chain.then(function (ok) { return ok ? saveTab(t) : false; }); })(TABS[i]);
  }
  return chain;
}
function doRun() {
  var t = current();
  if (!t) { setStatus('没有打开的文件', 'err'); return; }
  capture();
  setStatus('编译运行中…');
  tab('o');
  doSave(true).then(function (ok) {
    if (!ok) return;
    return fetch('/api/run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ file: t.path, content: t.content }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        showProblems(d.diags || []);
        var html = '';
        if (d.output) html += esc(d.output);
        if (d.error) html += '<span class="errline">' + esc(d.error) + '</span>';
        showOutput(html, d.ok);
        setStatus(d.ok ? '运行完成' : '运行失败', d.ok ? 'ok' : 'err');
      });
  }).catch(function (e) { setStatus('运行失败：' + e, 'err'); });
}
function showOutput(html, ok) {
  var box = document.getElementById('output');
  box.innerHTML = html || '(无输出)';
  box.className = 'show' + (ok ? ' ok' : '');
  tab('o');
}
function scheduleCheck() {
  clearTimeout(checkTimer);
  var delay = cm.getValue().length > 100000 ? 1200 : 350;
  checkTimer = setTimeout(doCheck, delay);
}
function doCheck() {
  var t = current();
  fetch('/api/check', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: cm.getValue(), file: t ? t.path : '' }) })
    .then(function (r) { return r.json(); })
    .then(function (d) { showProblems(d.diags); })
    .catch(function () {});
}
function showProblems(diags) {
  var box = document.getElementById('problems');
  if (!diags || !diags.length) {
    box.innerHTML = '<div style="color:#4ec9b0">没有问题</div>';
    setStatus('检查通过', 'ok');
    return;
  }
  var errors = 0;
  var html = '';
  for (var i = 0; i < diags.length; i++) {
    var d = diags[i];
    if (d.severity === 'error') errors++;
    var file = d.filePath || d.file || (current() ? current().path : '');
    html += '<div class="prob" data-line="' + d.line + '" data-col="' + d.col + '" data-file="' + esc(file) + '">'
      + '<span class="sev' + (d.severity === 'error' ? '' : ' warn') + '">' + (d.severity === 'error' ? '错误' : '提示') + '</span>'
      + (d.file ? '<span class="hint">' + esc(d.file) + '</span> ' : '')
      + '第 ' + d.line + ' 行，第 ' + d.col + ' 列 — ' + esc(d.message)
      + (d.hint ? '<span class="hint">建议：' + esc(d.hint) + '</span>' : '')
      + '</div>';
  }
  box.innerHTML = html;
  var items = box.querySelectorAll('.prob');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function () {
      var file = this.dataset.file;
      if (file) openLocation(file, Number(this.dataset.line), Number(this.dataset.col));
      else gotoLine(Number(this.dataset.line), Number(this.dataset.col));
    });
  }
  setStatus(errors > 0 ? errors + ' 个错误' : '只有提示', errors > 0 ? 'err' : 'ok');
}
function openLocation(file, line, col) {
  return openPath(file, line, col).then(function (ok) {
    if (ok) setStatus('已跳转', 'ok');
  });
}
function showReferences(d) {
  var box = document.getElementById('refs');
  tab('r');
  if (!d || !d.refs || !d.refs.length) {
    box.innerHTML = '<div style="color:#d7ba7d">没有找到「' + esc(d && d.name ? d.name : '') + '」的引用</div>';
    setStatus('没有找到引用');
    return;
  }
  var html = '<div class="prob" style="cursor:default"><strong>' + esc(d.name) + '</strong> 共 ' + d.refs.length + ' 处引用'
    + (d.truncated ? '（只显示前 200 处）' : '') + '</div>';
  for (var i = 0; i < d.refs.length; i++) {
    var r = d.refs[i];
    html += '<div class="prob" data-file="' + esc(r.file) + '" data-line="' + r.line + '" data-col="' + r.col + '">'
      + '<span class="sev' + (r.definition ? ' warn' : '') + '">' + (r.definition ? '定义' : '引用') + '</span>'
      + esc(baseName(r.file)) + ' · 第 ' + r.line + ' 行：' + esc(r.text)
      + '</div>';
  }
  box.innerHTML = html;
  var items = box.querySelectorAll('.prob[data-file]');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function () {
      openLocation(this.dataset.file, Number(this.dataset.line), Number(this.dataset.col));
    });
  }
  setStatus(d.refs.length + ' 处引用', 'ok');
}
function gotoLine(line, col) {
  cm.setCursor({ line: Math.max(0, line - 1), ch: Math.max(0, col - 1) });
  cm.focus();
  updateCursor();
}
function tab(which) {
  var ids = { p: 'problems', o: 'output', r: 'refs' };
  for (var k in ids) {
    document.getElementById(ids[k]).className = (k === which) ? 'show' : '';
    document.getElementById('tab-' + k).className = (k === which) ? 'on' : '';
  }
}
function updateCursor() {
  var c = cm.getCursor();
  document.getElementById('pos').textContent = '行 ' + (c.line + 1) + '，列 ' + (c.ch + 1);
}
