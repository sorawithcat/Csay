// Csay 编辑器：把标签拖出主编辑区，成为可移动的独立面板。
function removeFloat(t) {
  if (t.floatEditor) {
    try { t.floatEditor.toTextArea(); } catch (e) {}
    t.floatEditor = null;
  }
  if (t.floatPanel && t.floatPanel.parentNode) t.floatPanel.parentNode.removeChild(t.floatPanel);
  t.floatPanel = null;
  t.floating = false;
}

function dockFloat(t) {
  if (!t.floating) return;
  if (t.floatEditor) t.content = t.floatEditor.getValue();
  removeFloat(t);
  renderTabs();
  var idx = TABS.indexOf(t);
  if (idx >= 0) activate(idx);
}

function createFloatPanel(t, x, y) {
  var panel = document.createElement('div');
  panel.className = 'float-panel';
  panel.style.left = Math.max(8, Math.min(window.innerWidth - 540, x)) + 'px';
  panel.style.top = Math.max(8, Math.min(window.innerHeight - 380, y)) + 'px';

  var head = document.createElement('div');
  head.className = 'float-head';
  var title = document.createElement('span');
  title.className = 'float-title';
  title.textContent = t.path;
  head.appendChild(title);
  var dock = document.createElement('button');
  dock.textContent = '停靠';
  dock.title = '放回标签栏';
  head.appendChild(dock);
  var close = document.createElement('button');
  close.textContent = '×';
  close.title = '关闭';
  head.appendChild(close);

  var body = document.createElement('div');
  body.className = 'float-body';
  panel.appendChild(head);
  panel.appendChild(body);
  document.body.appendChild(panel);

  var editor = CodeMirror(body, {
    value: t.content,
    mode: 'csay',
    lineNumbers: true,
    indentUnit: SETTINGS.tabSize,
    tabSize: SETTINGS.tabSize,
    indentWithTabs: false,
    theme: 'csay'
  });
  editor.setSize('100%', '100%');
  t.floatPanel = panel;
  t.floatEditor = editor;

  editor.on('change', function () {
    t.content = editor.getValue();
    t.dirty = true;
    renderTabs();
  });
  editor.setOption('extraKeys', {
    'Ctrl-S': function () { saveTab(t); },
    'Ctrl-Enter': function () { setStatus('浮动面板中请停靠后再运行', 'err'); }
  });

  head.addEventListener('mousedown', function (ev) {
    if (ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    var left = panel.offsetLeft, top = panel.offsetTop;
    var sx = ev.clientX, sy = ev.clientY;
    beginDrag(function (e) {
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, left + e.clientX - sx)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, top + e.clientY - sy)) + 'px';
    });
  });

  dock.addEventListener('click', function () { dockFloat(t); });
  close.addEventListener('click', function () {
    var idx = TABS.indexOf(t);
    if (idx >= 0) closeTab(idx);
  });
  editor.focus();
}

function floatTab(idx, x, y) {
  var t = TABS[idx];
  if (!t || t.floating) return;
  if (idx === ACTIVE) capture();
  t.floating = true;
  if (idx === ACTIVE) {
    var next = -1;
    for (var i = 0; i < TABS.length; i++) {
      if (i !== idx && !TABS[i].floating) { next = i; break; }
    }
    if (next >= 0) activate(next);
    else { ACTIVE = -1; FILE = ''; clearEditor(); }
  }
  renderTabs();
  createFloatPanel(t, x, y);
}
