// Csay 编辑器：侧栏/面板分隔条。尺寸保存在浏览器本地。
var LAYOUT_KEY = 'csay.editor.layout';
var layout = { sidebar: 250, panel: 170 };
try {
  var savedLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
  if (savedLayout.sidebar >= 160) layout.sidebar = savedLayout.sidebar;
  if (savedLayout.panel >= 80) layout.panel = savedLayout.panel;
} catch (e) {}

function applyLayout() {
  document.getElementById('sidebar').style.width = layout.sidebar + 'px';
  document.getElementById('panel').style.height = layout.panel + 'px';
}
function persistLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) {}
}
function beginDrag(onMove, onEnd) {
  function move(e) { onMove(e); }
  function up() {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    if (onEnd) onEnd();
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
applyLayout();

document.getElementById('vsplit').addEventListener('mousedown', function (e) {
  e.preventDefault();
  var startX = e.clientX;
  var startWidth = layout.sidebar;
  document.body.style.cursor = 'col-resize';
  beginDrag(function (ev) {
    layout.sidebar = Math.max(160, Math.min(640, startWidth + ev.clientX - startX));
    applyLayout();
  }, persistLayout);
});

document.getElementById('hsplit').addEventListener('mousedown', function (e) {
  e.preventDefault();
  var startY = e.clientY;
  var startHeight = layout.panel;
  document.body.style.cursor = 'row-resize';
  beginDrag(function (ev) {
    layout.panel = Math.max(80, Math.min(window.innerHeight - 180, startHeight + startY - ev.clientY));
    applyLayout();
  }, persistLayout);
});
