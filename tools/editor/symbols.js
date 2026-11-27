// Csay 编辑器：symbols.js
function showBuiltin(name) {
  var detail = HINT_DETAIL[name] !== undefined ? HINT_DETAIL[name] : '';
  var desc = HINT_DESC[name] || '内建函数由运行时提供';
  askConfirm('内建函数 ' + name, name + '(' + detail + ')\n' + desc + '\n\n内建函数由 src/stdlib.ts 注册、src/codegen.ts 生成，不能像普通函数一样跳转到定义。');
  setStatus('内建函数：' + name, 'ok');
}

function symbolRequest(kind, pos) {
  var t = current();
  if (!t) return;
  if (kind === 'definition') {
    var w = cursorWord();
    if (w && HINT_DETAIL[w] !== undefined) { showBuiltin(w); return; }
  }
  var url = kind === 'references' ? '/api/references' : '/api/definition';
  var body = {
    file: t.path,
    text: cm.getValue(),
    line: pos.line + 1,
    col: pos.ch + 1,
    workspace: WORKSPACE || TREE_ROOT || ''
  };
  setStatus(kind === 'references' ? '查找引用…' : '查找定义…');
  fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { setStatus(d.error, 'err'); return; }
      if (kind === 'references') {
        showReferences(d);
        return;
      }
      if (!d.found || !d.definition) {
        setStatus('没有找到「' + (d.name || '当前名字') + '」的定义', 'err');
        return;
      }
      openLocation(d.definition.file, d.definition.line, d.definition.col);
    })
    .catch(function (e) { setStatus('符号查找失败：' + e, 'err'); });
}
function cursorWord() {
  var c = cm.getCursor();
  var line = cm.getLine(c.line) || '';
  function isWord(ch) { return /[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch || ''); }
  var start = c.ch;
  if (start > 0 && !isWord(line.charAt(start))) start--;
  if (!isWord(line.charAt(start))) return '';
  while (start > 0 && isWord(line.charAt(start - 1))) start--;
  var end = start;
  while (end < line.length && isWord(line.charAt(end))) end++;
  return line.slice(start, end);
}
function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function renameSymbol() {
  var word = cursorWord();
  if (!word) { setStatus('把光标放在要重命名的名字上', 'err'); return; }
  if (HINT_WORDS.indexOf(word) >= 0 || HINT_TYPE_NAMES.indexOf(word) >= 0) {
    setStatus('不能重命名关键字或内建类型', 'err');
    return;
  }
  var pos = cm.getCursor();
  askText('重命名符号', '把「' + word + '」改为：', word).then(function (next) {
    if (!next || next === word) return;
    if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(next)) {
      setStatus('名字只能由字母、数字、下划线或汉字组成，且不能以数字开头', 'err');
      return;
    }
    if (HINT_WORDS.indexOf(next) >= 0 || HINT_TYPE_NAMES.indexOf(next) >= 0) {
      setStatus('不能使用关键字或内建类型作为名字', 'err');
      return;
    }
    saveAll().then(function (ok) {
      if (!ok) return;
      var t = current();
      if (!t) return;
      setStatus('重命名中…');
      return fetch('/api/rename-symbol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: t.path, text: cm.getValue(), line: pos.line + 1, col: pos.ch + 1, next: next, workspace: WORKSPACE || TREE_ROOT || '' })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { setStatus(d.error || '重命名失败', 'err'); return; }
        t.content = d.entryContent;
        t.dirty = false;
        loading = true;
        cm.setValue(d.entryContent);
        loading = false;
        renderTabs();
        refreshWorkspaceSources();
        for (var i = 0; i < d.changed.length; i++) {
          if (d.changed[i].file !== t.path) reloadTabFile(d.changed[i].file);
        }
        setStatus('已重命名 ' + d.count + ' 处「' + word + '」为「' + next + '」', 'ok');
      });
    }).catch(function (e) { setStatus('重命名失败：' + e, 'err'); });
  });
}
cm.addKeyMap({ F2: renameSymbol });
function formatSelection() {
  var sel = cm.listSelections()[0];
  if (!sel) return;
  var from = Math.min(sel.anchor.line, sel.head.line);
  var to = Math.max(sel.anchor.line, sel.head.line);
  var text = cm.getRange({ line: from, ch: 0 }, { line: to, ch: cm.getLine(to).length });
  var base = (cm.getLine(from).match(/^ */) || [''])[0];
  setStatus('格式化选中区域…');
  fetch('/api/format', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text, indent: ' '.repeat(Number(SETTINGS.tabSize) || 4), braceStyle: SETTINGS.formatBrace })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) { setStatus('选中区域不是完整语句，未格式化：' + d.error, 'err'); return; }
    var lines = d.content.replace(/\n$/, '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) lines[i] = base + lines[i];
    }
    cm.replaceRange(lines.join('\n'), { line: from, ch: 0 }, { line: to, ch: cm.getLine(to).length });
    setStatus('已格式化第 ' + (from + 1) + '–' + (from + lines.length) + ' 行');
  }).catch(function (e) { setStatus('格式化失败：' + e, 'err'); });
}

function formatDocument() {
  var t = current();
  if (!t) return;
  var cursor = cm.getCursor();
  setStatus('格式化整个文件…');
  fetch('/api/format', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cm.getValue(), indent: ' '.repeat(Number(SETTINGS.tabSize) || 4), braceStyle: SETTINGS.formatBrace })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) { setStatus('格式化失败：' + d.error, 'err'); return; }
    loading = true;
    cm.setValue(d.content);
    loading = false;
    cm.setCursor({ line: Math.min(cursor.line, cm.lineCount() - 1), ch: cursor.ch });
    t.content = d.content;
    t.dirty = true;
    renderTabs();
    setStatus('已格式化整个文件', 'ok');
  }).catch(function (e) { setStatus('格式化失败：' + e, 'err'); });
}
cm.addKeyMap({ 'Shift-Alt-F': formatDocument, 'Ctrl-Alt-F': formatSelection });
function editorMenu(pos) {
  var word = cursorWord();
  var items = [];
  if (word) {
    items.push(menuItem('转到定义', function () { symbolRequest('definition', pos); }, false, 'F12'));
    items.push(menuItem('查找引用', function () { symbolRequest('references', pos); }, false, 'Shift+F12'));
    items.push(menuItem('重命名符号', renameSymbol, false, 'F2'));
    items.push(menuSep());
  }
  items.push(menuItem('格式化整个文件', formatDocument, false, 'Shift+Alt+F'));
  items.push(menuItem('格式化选中行', formatSelection, false, 'Ctrl+Alt+F'));
  items.push(menuSep());
  items.push(menuItem('撤销', function () { cm.undo(); }, false, 'Ctrl+Z'));
  items.push(menuItem('重做', function () { cm.redo(); }, false, 'Ctrl+Y'));
  items.push(menuSep());
  items.push(menuItem('剪切', function () { cm.execCommand('cut'); }, false, 'Ctrl+X'));
  items.push(menuItem('复制', function () { cm.execCommand('copy'); }, false, 'Ctrl+C'));
  items.push(menuItem('粘贴', function () { cm.execCommand('paste'); }, false, 'Ctrl+V'));
  items.push(menuItem('全选', function () { cm.execCommand('selectAll'); }, false, 'Ctrl+A'));
  items.push(menuSep());
  items.push(menuItem('保存', function () { doSave(false); }, false, 'Ctrl+S'));
  items.push(menuItem('运行', doRun, false, 'Ctrl+Enter'));
  return items;
}
