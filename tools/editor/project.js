// Csay 编辑器：project.js
function renderProject() {
  var box = document.getElementById('projectInfo');
  if (!PROJECT || !PROJECT_EXISTS || !PROJECT.entry) {
    box.textContent = '未配置项目 · 点击设置';
    box.title = '点击选择项目入口和打包设置';
    return;
  }
  var count = (PROJECT.targets || []).length;
  box.textContent = '项目：' + PROJECT.name + (count > 1 ? '  ·  ' + count + ' 个目标' : '  ·  ' + PROJECT.entry);
  box.title = '当前项目文件：' + (PROJECT_PATH || '') + '\n点击编辑项目设置（入口、输出名、多目标、版本）';
}
function loadProject() {
  if (!TREE_ROOT) return Promise.resolve(null);
  PROJECT = null;
  PROJECT_EXISTS = false;
  renderProject();
  return fetch('/api/project?dir=' + encodeURIComponent(TREE_ROOT))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { setStatus(d.error, 'err'); return null; }
      PROJECT = d.project;
      PROJECT_PATH = d.path;
      PROJECT_EXISTS = !!d.exists;
      renderProject();
      return d;
    })
    .catch(function (e) { setStatus('读取项目失败：' + e, 'err'); return null; });
}
function saveProject(project) {
  return fetch('/api/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: TREE_ROOT, path: PROJECT_PATH, project: project })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) {
        LAST_PROJECT_ERROR = d.error || '项目保存失败';
        setStatus(LAST_PROJECT_ERROR, 'err');
        return false;
      }
      PROJECT = d.project;
      PROJECT_PATH = d.path;
      PROJECT_EXISTS = true;
      renderProject();
      loadTree(TREE_ROOT);
      setStatus('项目已保存：' + baseName(d.path), 'ok');
      return true;
    })
    .catch(function (e) { LAST_PROJECT_ERROR = '项目保存失败：' + e; setStatus(LAST_PROJECT_ERROR, 'err'); return false; });
}
function chooseProjectEntry() {
  nativePick('file', TREE_ROOT).then(function (p) {
    if (!p) return;
    document.getElementById('projEntry').value = relPath(p);
    document.getElementById('projError').textContent = '';
  });
}
function targetsText(targets) {
  return (targets || []).map(function (t) {
    var prefix = t.name && t.name !== t.output ? t.name + '|' : '';
    return prefix + t.entry + '=' + t.output;
  }).join('\n');
}
function parseTargets(text) {
  var out = [];
  text.split(/[\n\r]+/).forEach(function (raw) {
    var line = raw.trim();
    if (!line) return;
    var at = line.indexOf('=');
    if (at <= 0 || at === line.length - 1) throw new Error('多目标每行应为 入口=输出：' + line);
    var left = line.slice(0, at).trim();
    var output = line.slice(at + 1).trim();
    var name = '';
    var pipe = left.lastIndexOf('|');
    if (pipe >= 0) { name = left.slice(0, pipe).trim(); left = left.slice(pipe + 1).trim(); }
    if (!left || !output) throw new Error('多目标每行应为 入口=输出：' + line);
    out.push({ name: name, entry: left, output: output });
  });
  return out;
}
function editProject() {
  if (!TREE_ROOT) { setStatus('先打开一个文件夹', 'err'); return; }
  var base = PROJECT_EXISTS && PROJECT
    ? PROJECT
    : { name: baseName(TREE_ROOT) || 'Csay 项目', entry: '', output: baseName(TREE_ROOT) || '程序', version: '0.2.0', exclude: [], resources: [], dependencies: [], beforeBuild: '', afterBuild: '', targets: [] };
  document.getElementById('projName').value = base.name;
  document.getElementById('projEntry').value = base.entry;
  document.getElementById('projOutput').value = base.output;
  document.getElementById('projVersion').value = base.version;
  document.getElementById('projExclude').value = (base.exclude || []).join(', ');
  document.getElementById('projResources').value = (base.resources || []).join(', ');
  document.getElementById('projDependencies').value = (base.dependencies || []).join(', ');
  document.getElementById('projBeforeBuild').value = base.beforeBuild || '';
  document.getElementById('projAfterBuild').value = base.afterBuild || '';
  document.getElementById('projTargets').value = targetsText(base.targets);
  document.getElementById('projError').textContent = '';
  projectModal.classList.remove('hidden');
  document.getElementById('projName').focus();
}
function closeProjectDialog() {
  projectModal.classList.add('hidden');
  cm.focus();
}
function saveProjectForm() {
  var name = document.getElementById('projName').value.trim();
  var entry = document.getElementById('projEntry').value.trim();
  var output = document.getElementById('projOutput').value.trim();
  var version = document.getElementById('projVersion').value.trim();
  var exclude = document.getElementById('projExclude').value.split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  var resources = document.getElementById('projResources').value.split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  var dependencies = document.getElementById('projDependencies').value.split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  var beforeBuild = document.getElementById('projBeforeBuild').value.trim();
  var afterBuild = document.getElementById('projAfterBuild').value.trim();
  var error = document.getElementById('projError');
  if (!name || !entry || !output) { error.textContent = '名称、入口和输出文件名不能为空。'; return; }
  error.textContent = '';
  var targets;
  try {
    targets = parseTargets(document.getElementById('projTargets').value);
  } catch (e) {
    error.textContent = String(e.message || e);
    return;
  }
  saveProject({ name: name, entry: entry, output: output, version: version || '0.2.0', exclude: exclude, resources: resources, dependencies: dependencies, beforeBuild: beforeBuild, afterBuild: afterBuild, targets: targets }).then(function (ok) {
    if (ok) closeProjectDialog();
    else if (LAST_PROJECT_ERROR) error.textContent = LAST_PROJECT_ERROR;
  });
}
function setProjectEntry(path) {
  if (!PROJECT) { editProject(); return; }
  var targets = (PROJECT.targets || []).map(function (t) { return { name: t.name, entry: t.entry, output: t.output }; });
  if (targets.length) targets[0].entry = relPath(path);
  var p = { name: PROJECT.name, entry: relPath(path), output: PROJECT.output, version: PROJECT.version, exclude: PROJECT.exclude || [], resources: PROJECT.resources || [], dependencies: PROJECT.dependencies || [], beforeBuild: PROJECT.beforeBuild || '', afterBuild: PROJECT.afterBuild || '', targets: targets };
  saveProject(p);
}
function packageProject() {
  if (!PROJECT || !PROJECT_EXISTS || !PROJECT.entry) {
    setStatus('先配置项目入口，再打包', 'err');
    editProject();
    return;
  }
  setStatus('正在保存并打包…');
  tab('o');
  showOutput('正在编译并打包…', true);
  saveAll().then(function (ok) {
    if (!ok) { setStatus('保存失败，已停止打包', 'err'); return; }
    return fetch('/api/package', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: TREE_ROOT, project: PROJECT })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) {
        showOutput('<span class="errline">' + esc(d.error || '打包失败') + '</span>', false);
        setStatus('打包失败', 'err');
        return;
      }
      showOutput(esc(d.output) + '\n\n目标文件：' + esc(d.zip), true);
      setStatus('打包完成：' + baseName(d.zip), 'ok');
    });
  }).catch(function (e) {
    showOutput('<span class="errline">打包失败：' + esc(e) + '</span>', false);
    setStatus('打包失败', 'err');
  });
}

function nativePick(kind, dir) {
  return fetch('/api/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: kind, dir: dir || TREE_ROOT || WORKSPACE })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) return d.path;
      if (d.error && d.error !== '已取消') setStatus(d.error, 'err');
      return null;
    })
    .catch(function (e) { setStatus('选择失败：' + e, 'err'); return null; });
}
function openFolder() {
  nativePick('folder').then(function (p) { if (p) loadTree(p); });
}
function openFileDialog() {
  nativePick('file').then(function (p) { if (p) openPath(p); });
}
function newFile(dir) {
  dir = dir || targetDir();
  askText('新建文件', '在 ' + dir + ' 中新建 .csay 文件：', '新程序.csay').then(function (name) {
    if (!name) return;
    fetch('/api/new', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ dir: dir, name: name, kind: 'file' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus(d.error, 'err'); return; }
        loadTree(TREE_ROOT);
        openPath(d.path);
      });
  });
}
function newFolder(dir) {
  dir = dir || targetDir();
  askText('新建文件夹', '在 ' + dir + ' 中新建文件夹：', '新文件夹').then(function (name) {
    if (!name) return;
    fetch('/api/new', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ dir: dir, name: name, kind: 'dir' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus(d.error, 'err'); return; }
        loadTree(TREE_ROOT);
      });
  });
}
function deleteNode(node) {
  var target = node || SELECTED;
  if (!target && current()) target = { path: current().path, dir: false, name: current().name };
  if (!target) { setStatus('先选择文件或文件夹', 'err'); return; }
  askConfirm('删除', '确定删除「' + target.name + '」？\n' + target.path + (target.dir ? '\n文件夹会连同内容一起删除。' : '')).then(function (ok) {
    if (!ok) return;
    fetch('/api/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: target.path, root: TREE_ROOT }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus(d.error, 'err'); return; }
        removeTabsUnder(target.path);
        SELECTED = null;
        loadTree(TREE_ROOT);
        setStatus('已删除', 'ok');
      });
  });
}
function removeTabsUnder(path) {
  var activePath = current() ? current().path : '';
  var kept = [];
  for (var i = 0; i < TABS.length; i++) if (!under(TABS[i].path, path)) kept.push(TABS[i]);
  TABS = kept;
  if (TABS.length === 0) { clearEditor(); return; }
  var idx = 0;
  for (var j = 0; j < TABS.length; j++) if (TABS[j].path === activePath) idx = j;
  activate(idx);
}
function renameNode(node) {
  if (!node) return;
  askText('重命名', '新名称：', node.name).then(function (name) {
    if (!name || name === node.name) return;
    fetch('/api/rename', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: node.path, name: name }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus(d.error, 'err'); return; }
        for (var i = 0; i < TABS.length; i++) {
          if (under(TABS[i].path, node.path)) {
            TABS[i].path = d.path + TABS[i].path.slice(node.path.length);
            TABS[i].name = baseName(TABS[i].path);
          }
        }
        if (current()) FILE = current().path;
        renderTabs(); updateTitle();
        SELECTED = null;
        loadTree(TREE_ROOT);
        setStatus('已重命名', 'ok');
      });
  });
}
function copyPath(node) {
  var text = node ? node.path : (current() ? current().path : '');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  setStatus('已复制路径', 'ok');
}
function revealNode(node) {
  var target = node || (current() ? { path: current().path } : null);
  if (!target) return;
  fetch('/api/reveal', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: target.path }) });
}
