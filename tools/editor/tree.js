// Csay 编辑器：tree.js
function parentPath(p) { return String(p || "").replace(/[\\/][^\\/]*$/, ""); }
function renderTree() {
  treeEl.innerHTML = '';
  if (!TREE) return;
  function visible(node) {
    if (!FILTER) return true;
    var q = FILTER.toLowerCase();
    if (node.name.toLowerCase().indexOf(q) >= 0) return true;
    if (node.dir && node.children) {
      for (var i = 0; i < node.children.length; i++) if (visible(node.children[i])) return true;
    }
    return false;
  }
  function add(node, box, depth) {
    if (!visible(node)) return;
    if (node.dir) {
      var details = document.createElement('details');
      details.className = 'tree-dir';
      details.open = depth < 2 || FILTER !== '';
      details.dataset.path = node.path;
      var summary = document.createElement('summary');
      summary.textContent = node.name;
      summary.addEventListener('click', function () { selectNode({ path: node.path, dir: true, name: node.name }); });
      details.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var info = { path: node.path, dir: true, name: node.name };
        selectNode(info);
        showMenu(ev.clientX, ev.clientY, nodeMenu(info));
      });
      details.appendChild(summary);
      var kids = document.createElement('div');
      for (var i = 0; i < node.children.length; i++) add(node.children[i], kids, depth + 1);
      details.appendChild(kids);
      box.appendChild(details);
    } else {
      var row = document.createElement('div');
      row.className = 'tree-file';
      row.dataset.path = node.path;
      row.textContent = node.name === '项目.csayproj' && duplicateProjects
        ? node.name + '  ·  ' + (relPath(parentPath(node.path)) || '根目录')
        : node.name;
      row.title = relPath(node.path);
      row.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var info = { path: node.path, dir: false, name: node.name };
        selectNode(info);
        openPath(node.path);
      });
      row.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var info = { path: node.path, dir: false, name: node.name };
        selectNode(info);
        showMenu(ev.clientX, ev.clientY, nodeMenu(info));
      });
      box.appendChild(row);
    }
  }
  var projectFiles = [];
  (function collect(nodes) {
    for (var pi = 0; pi < nodes.length; pi++) {
      if (nodes[pi].name === '项目.csayproj') projectFiles.push(nodes[pi].path);
      if (nodes[pi].dir && nodes[pi].children) collect(nodes[pi].children);
    }
  })(TREE.entries);
  var duplicateProjects = projectFiles.length > 1;
  for (var i = 0; i < TREE.entries.length; i++) add(TREE.entries[i], treeEl, 0);
  if (!treeEl.children.length) {
    var empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = FILTER ? '没有匹配的 .csay 文件' : '这个文件夹里还没有 .csay 文件';
    treeEl.appendChild(empty);
  }
  selectNode(SELECTED);
}
function selectNode(node) {
  SELECTED = node;
  var all = treeEl.querySelectorAll('.selected');
  for (var i = 0; i < all.length; i++) all[i].classList.remove('selected');
  if (!node) return;
  var rows = treeEl.querySelectorAll('[data-path]');
  for (var j = 0; j < rows.length; j++) {
    if (rows[j].dataset.path === node.path) rows[j].classList.add('selected');
  }
}
function loadTree(dir) {
  return fetch('/api/tree?dir=' + encodeURIComponent(dir))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { setStatus(d.error, 'err'); return; }
      TREE = d;
      TREE_ROOT = d.dir;
      WORKSPACE = d.dir;
      folderTitle.textContent = d.name + '  ·  ' + d.dir;
      SELECTED = null;
      renderTree();
      loadProject();
      saveSession();
      setStatus('已打开 ' + d.name);
    })
    .catch(function (e) { setStatus('打开文件夹失败：' + e, 'err'); });
}

function relPath(p) {
  var root = String(TREE_ROOT || WORKSPACE || '').replace(/\\/g, '/').replace(/\/$/, '');
  var full = String(p || '').replace(/\\/g, '/');
  if (full === root) return '';
  return full.indexOf(root + '/') === 0 ? full.slice(root.length + 1) : full;
}
