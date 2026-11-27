// Csay 编辑器：menus.js
function menuItem(label, action, danger, key) { return { label: label, action: action, danger: danger, key: key || '' }; }
function menuSep() { return { sep: true }; }
function hideMenu() { ctxmenu.classList.add('hidden'); }
function showMenu(x, y, items) {
  ctxmenu.innerHTML = '';
  for (var i = 0; i < items.length; i++) {
    (function (item) {
      if (item.sep) {
        var sep = document.createElement('div');
        sep.className = 'sep';
        ctxmenu.appendChild(sep);
      } else {
        var b = document.createElement('button');
        var label = document.createElement('span');
        label.textContent = item.label;
        b.appendChild(label);
        if (item.key) {
          var key = document.createElement('span');
          key.className = 'key';
          key.textContent = item.key;
          b.appendChild(key);
        }
        if (item.danger) b.classList.add('danger');
        b.addEventListener('click', function () { hideMenu(); item.action(); });
        ctxmenu.appendChild(b);
      }
    })(items[i]);
  }
  ctxmenu.classList.remove('hidden');
  var r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  ctxmenu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  ctxmenu.tabIndex = -1;
  ctxmenu.focus({ preventScroll: true });
}
ctxmenu.addEventListener('keydown', function (e) {
  var buttons = Array.prototype.slice.call(ctxmenu.querySelectorAll('button'));
  if (!buttons.length) return;
  var at = buttons.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(at + 1 + buttons.length) % buttons.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length].focus(); }
  else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); buttons[at].click(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideMenu(); cm.focus(); }
});
function nodeMenu(node) {
  var items = [];
  var projectFile = /\\.csayproj$/i.test(node.name);
  if (node.dir) {
    items.push(menuItem('新建文件', function () { newFile(node.path); }));
    items.push(menuItem('新建文件夹', function () { newFolder(node.path); }));
    items.push(menuItem('打开此文件夹', function () { loadTree(node.path); }));
    items.push(menuSep());
    items.push(menuItem('重命名', function () { renameNode(node); }));
    items.push(menuItem('删除', function () { deleteNode(node); }, true));
    items.push(menuSep());
    items.push(menuItem('复制路径', function () { copyPath(node); }));
    items.push(menuItem('在资源管理器中显示', function () { revealNode(node); }));
  } else if (projectFile) {
    items.push(menuItem('编辑项目设置', editProject));
    items.push(menuItem('打包项目', packageProject));
    items.push(menuSep());
    items.push(menuItem('复制路径', function () { copyPath(node); }));
    items.push(menuItem('在资源管理器中显示', function () { revealNode(node); }));
  } else {
    items.push(menuItem('打开', function () { openPath(node.path); }));
    items.push(menuItem('运行', function () { openPath(node.path).then(doRun); }, false, 'Ctrl+Enter'));
    items.push(menuItem('设为项目入口', function () { setProjectEntry(node.path); }));
    items.push(menuSep());
    items.push(menuItem('新建同级文件', function () { newFile(parentPath(node.path)); }));
    items.push(menuItem('重命名', function () { renameNode(node); }));
    items.push(menuItem('删除', function () { deleteNode(node); }, true));
    items.push(menuSep());
    items.push(menuItem('复制路径', function () { copyPath(node); }));
    items.push(menuItem('在资源管理器中显示', function () { revealNode(node); }));
  }
  return items;
}
function blankMenu() {
  return [
    menuItem('新建文件', function () { newFile(TREE_ROOT); }),
    menuItem('新建文件夹', function () { newFolder(TREE_ROOT); }),
    menuItem('打开文件', openFileDialog),
    menuItem('打开文件夹', openFolder),
    menuSep(),
    menuItem('项目设置', editProject),
    menuItem('打包项目', packageProject),
    menuSep(),
    menuItem('刷新', function () { if (TREE_ROOT) loadTree(TREE_ROOT); })
  ];
}
function tabMenu(t) {
  return [
    menuItem('关闭', function () { closeTab(TABS.indexOf(t)); }),
    menuItem('关闭其他', function () { TABS = [t]; ACTIVE = -1; activate(0); }),
    menuSep(),
    menuItem('复制路径', function () { copyPath({ path: t.path }); })
  ];
}

function askText(title, label, value) {
  return new Promise(function (resolve) {
    modalResolve = resolve;
    modalInputMode = true;
    modalTitle.textContent = title;
    modalMsg.textContent = label || '';
    modalInput.value = value || '';
    modalInput.style.display = 'block';
    modal.classList.remove('hidden');
    setTimeout(function () { modalInput.focus(); modalInput.select(); }, 0);
  });
}
function askConfirm(title, message) {
  return new Promise(function (resolve) {
    modalResolve = resolve;
    modalInputMode = false;
    modalTitle.textContent = title;
    modalMsg.textContent = message || '';
    modalInput.style.display = 'none';
    modal.classList.remove('hidden');
    setTimeout(function () { document.getElementById('modalOk').focus(); }, 0);
  });
}
function finishModal(ok) {
  var resolve = modalResolve;
  modalResolve = null;
  modal.classList.add('hidden');
  if (!resolve) return;
  if (!ok) { resolve(modalInputMode ? null : false); return; }
  resolve(modalInputMode ? modalInput.value : true);
}
document.getElementById('modalCancel').addEventListener('click', function () { finishModal(false); });
document.getElementById('modalOk').addEventListener('click', function () { finishModal(true); });
modalInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); finishModal(true); }
  if (e.key === 'Escape') { e.preventDefault(); finishModal(false); }
});
modal.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { e.preventDefault(); finishModal(false); }
});
