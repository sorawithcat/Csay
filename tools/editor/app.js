// Csay 编辑器：app.js
document.getElementById('btnSave').addEventListener('click', function () { doSave(false); });
document.getElementById('btnOpen').addEventListener('click', function (e) {
  e.stopPropagation();
  var r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    menuItem('打开文件', openFileDialog, false, 'Ctrl+Shift+O'),
    menuItem('打开文件夹', openFolder, false, 'Ctrl+O')
  ]);
});
document.getElementById('btnRun').addEventListener('click', doRun);
document.getElementById('btnProject').addEventListener('click', editProject);
document.getElementById('btnPackage').addEventListener('click', packageProject);
document.getElementById('projCancel').addEventListener('click', closeProjectDialog);
document.getElementById('projSave').addEventListener('click', saveProjectForm);
document.getElementById('projPick').addEventListener('click', chooseProjectEntry);
projectModal.addEventListener('click', function (e) { if (e.target === projectModal) closeProjectDialog(); });
projectModal.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); saveProjectForm(); }
  if (e.key === 'Escape') { e.preventDefault(); closeProjectDialog(); }
});
document.getElementById('btnDocs').addEventListener('click', function () { window.open('/docs'); });
document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('settingsSave').addEventListener('click', saveSettingsDialog);
document.getElementById('settingsClose').addEventListener('click', closeSettingsDialog);
document.getElementById('settingsModal').addEventListener('click', function (e) { if (e.target === document.getElementById('settingsModal')) closeSettingsDialog(); });
document.getElementById('projectInfo').addEventListener('click', editProject);
document.getElementById('filter').addEventListener('input', function (e) { FILTER = e.target.value.trim(); renderTree(); });
document.getElementById('tab-p').addEventListener('click', function () { tab('p'); });
document.getElementById('tab-o').addEventListener('click', function () { tab('o'); });
document.getElementById('tab-r').addEventListener('click', function () { tab('r'); });

treeEl.addEventListener('contextmenu', function (e) {
  e.preventDefault(); e.stopPropagation();
  SELECTED = null; selectNode(null);
  showMenu(e.clientX, e.clientY, blankMenu());
});
cmhost.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  e.stopPropagation();
  var pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
  var index = cm.indexFromPos(pos);
  var keep = false;
  var ranges = cm.listSelections();
  for (var i = 0; i < ranges.length; i++) {
    if (index >= cm.indexFromPos(ranges[i].anchor) && index <= cm.indexFromPos(ranges[i].head)) { keep = true; break; }
    if (index >= cm.indexFromPos(ranges[i].head) && index <= cm.indexFromPos(ranges[i].anchor)) { keep = true; break; }
  }
  if (!keep) cm.setCursor(pos);
  cm.focus();
  showMenu(e.clientX, e.clientY, editorMenu(pos));
}, true);
document.addEventListener('click', hideMenu);
document.addEventListener('scroll', hideMenu, true);
window.addEventListener('resize', hideMenu);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideMenu(); });

cm.on('change', function () {
  if (loading) return;
  var t = current();
  if (t) { t.content = cm.getValue(); t.dirty = true; renderTabs(); }
  scheduleCheck();
  updateCursor();
});
cm.on('cursorActivity', updateCursor);
cm.on('scroll', function () { hideHintTip(); lastHoverKey = null; });
cm.getWrapperElement().addEventListener('mousemove', function (e) { if (SETTINGS.hover) showCodeHover(cm, e); else hideHintTip(); });
cm.getWrapperElement().addEventListener('mouseleave', function () { hideHintTip(); lastHoverKey = null; });
cm.setOption('extraKeys', {
  'Ctrl-S': function () { doSave(false); },
  'Ctrl-,': function () { openSettings(); },
  'Ctrl-Enter': function () { doRun(); },
  'F5': function () { doRun(); },
  'Ctrl-N': function () { newFile(); },
  'Ctrl-O': function () { openFolder(); },
  'Ctrl-Shift-O': function () { openFileDialog(); },
  'Ctrl-W': function () { if (ACTIVE >= 0) closeTab(ACTIVE); },
  'Ctrl-/': function () { cm.execCommand('toggleComment'); },
  'Ctrl-Space': function () { showCsayHint(cm); },
  'F12': function () { symbolRequest('definition', cm.getCursor()); },
  'Shift-F12': function () { symbolRequest('references', cm.getCursor()); },
  'F1': function () { window.open('/docs'); },
  'Tab': function (editor) {
    if (editor.somethingSelected()) editor.execCommand('indentMore');
    else editor.replaceSelection('    ', 'end');
  },
  'Shift-Tab': function (editor) { editor.execCommand('indentLess'); }
});

window.addEventListener('beforeunload', function (e) {
  saveSession();
  for (var i = 0; i < TABS.length; i++) if (TABS[i].dirty) { e.preventDefault(); e.returnValue = ''; return; }
});

var initial = new URLSearchParams(location.search).get('file') || '';
if (!initial) {
  if (!restoreSession()) {
    updateTitle();
    loadTree('');
  }
} else {
  fetch('/api/load?file=' + encodeURIComponent(initial))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { setStatus(d.error, 'err'); loadTree(''); return; }
      WORKSPACE = d.dir;
      TREE_ROOT = d.dir;
      addTab(d);
      loadTree(d.dir);
    })
    .catch(function (e) { setStatus('编辑器初始化失败：' + e, 'err'); });
}
