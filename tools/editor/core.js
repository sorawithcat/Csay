// Csay 编辑器：状态与编辑器实例
var cmhost = document.getElementById('cmhost');
var tabsEl = document.getElementById('tabs');
var treeEl = document.getElementById('tree');
var fileTitle = document.getElementById('fileTitle');
var folderTitle = document.getElementById('folderTitle');
var statusEl = document.getElementById('status');
var welcome = document.getElementById('welcome');
var modal = document.getElementById('modal');
var modalTitle = document.getElementById('modalTitle');
var modalMsg = document.getElementById('modalMsg');
var modalInput = document.getElementById('modalInput');
var projectModal = document.getElementById('projectModal');
var ctxmenu = document.getElementById('ctxmenu');

var TABS = [];
var ACTIVE = -1;
var FILE = '';
var WORKSPACE = '';
var TREE_ROOT = '';
var TREE = null;
var SELECTED = null;
var FILTER = '';
var PROJECT = null;
var PROJECT_PATH = '';
var PROJECT_EXISTS = false;
var LAST_PROJECT_ERROR = '';
var WORKSPACE_SOURCES = [];
var SESSION_KEY = 'csay.editor.session.v1';
var modalResolve = null;
var modalInputMode = false;
var loading = false;
var checkTimer = null;

CodeMirror.defineMode('csay', function () {
  var types = {
    '字节': 1, '有符号字节': 1, '短整数': 1, '无符号短整数': 1,
    '整数': 1, '无符号整数': 1, '长整数': 1, '无符号长整数': 1,
    '浮点数': 1, '长小数': 1, '文本': 1, '字符': 1, '真假': 1, '无': 1, '列表': 1, '表': 1
  };
  var decls = { '类': 1, '结构': 1, '接口': 1, '枚举': 1 };
  var mods = { '公开': 1, '私有': 1, '保护': 1, '内部': 1, '静态': 1, '虚拟': 1, '覆盖': 1 };
  var ctl = { '若': 1, '否则若': 1, '否则': 1, '选择': 1, '情况': 1, '默认': 1, '循环': 1, '遍历': 1, '只要': 1, '做': 1, '在': 1, '返回': 1, '跳出': 1, '跳过': 1, '区域': 1, '使用': 1, '命名空间': 1, '试': 1, '捕获': 1, '最终': 1, '抛出': 1 };
  var atoms = { '新': 1, '空': 1, '真': 1, '假': 1, '自': 1, '基': 1, '取': 1, '写': 1 };
  return {
    token: function (stream) {
      if (stream.eatSpace()) return null;
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/'(?:\\.|[^'\\])*'/)) return 'string';
      if (stream.match(/\$?"(?:\\.|[^"\\])*"/)) return 'string';
      if (stream.match(/\d+(?:\.\d+)?/)) return 'number';
      var word = stream.match(/[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*/);
      if (word) {
        if (types[word]) return 'type';
        if (decls[word]) return 'def';
        if (mods[word]) return 'modifier';
        if (ctl[word]) return 'keyword';
        if (atoms[word]) return 'atom';
        return 'variable';
      }
      stream.next();
      return null;
    }
  };
});

var cm = CodeMirror(cmhost, {
  value: '',
  mode: 'csay',
  lineNumbers: true,
  lineWrapping: false,
  indentUnit: 4,
  tabSize: 4,
  indentWithTabs: false,
  smartIndent: true,
  viewportMargin: 10,
  theme: 'csay'
});
