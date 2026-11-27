(function () {
  'use strict';

  var KW_T = ['整数', '浮点数', '长小数', '文本', '真假', '无', '列表', '表', '条目', '异常'];
  var KW_D = ['类', '结构', '接口', '枚举', '委托', '命名空间'];
  var KW_M = ['公开', '私有', '保护', '内部', '静态', '只读', '抽象', '虚拟', '覆盖', '常', '密封'];
  var KW_C = ['若', '否则若', '否则', '选择', '情况', '默认', '循环', '遍历', '只要', '做', '在', '返回', '跳出', '跳过', '区域', '使用', '试', '捕获', '最终', '抛出', '引'];
  var KW_X = ['新', '空', '真', '假', '自', '基', '取', '写', '值', '字节', '任意'];

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function kwClass(w) {
    if (KW_T.indexOf(w) >= 0) return 'kw-t';
    if (KW_D.indexOf(w) >= 0) return 'kw-d';
    if (KW_M.indexOf(w) >= 0) return 'kw-m';
    if (KW_C.indexOf(w) >= 0) return 'kw-c';
    if (KW_X.indexOf(w) >= 0) return 'kw-x';
    return null;
  }

  // 轻量分词，只给编辑框背后那层上色，不当作真正的词法器。
  function highlight(code) {
    var out = '';
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\$?"(?:\\.|[^"\\\n])*"|“(?:[^”\\\n])*”)|(\d+(?:\.\d+)?)|([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)|([\s\S])/g;
    var m;
    var lastEnd = 0;
    var pieces = [];
    while ((m = re.exec(code)) !== null) {
      if (m.index > lastEnd) pieces.push({ t: code.slice(lastEnd, m.index), c: null });
      var text = m[0];
      var cls = null;
      if (m[1]) cls = 'com';
      else if (m[2]) cls = 'str';
      else if (m[3]) cls = 'num';
      else if (m[4]) {
        var k = kwClass(text);
        if (k) cls = k;
        else {
          var rest = code.slice(m.index + text.length);
          cls = /^\s*\(/.test(rest) ? 'fn' : 'id';
        }
      }
      pieces.push({ t: text, c: cls });
      lastEnd = m.index + text.length;
    }
    if (lastEnd < code.length) pieces.push({ t: code.slice(lastEnd), c: null });
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      out += p.c ? '<span class="' + p.c + '">' + escHtml(p.t) + '</span>' : escHtml(p.t);
    }
    return out;
  }

  function lineNumbers(n) {
    var s = '';
    for (var i = 1; i <= n; i++) s += (i > 1 ? '\n' : '') + i;
    return s;
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    var h = ta.scrollHeight;
    ta.style.height = (h + 14) + 'px';
  }

  function setupDemo(demo) {
    if (demo.dataset.ready) return;
    demo.dataset.ready = '1';
    var ta = demo.querySelector('.code');
    var gutter = demo.querySelector('.gutter');
    var hl = demo.querySelector('.hl');
    var run = demo.querySelector('.run');
    var reset = demo.querySelector('.reset');
    var copy = demo.querySelector('.copy');
    var state = demo.querySelector('.runstate');
    var output = demo.querySelector('.output');
    var outputBody = demo.querySelector('.output-body');
    var original = ta.value;

    function sync() {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    }

    function paint() {
      hl.innerHTML = highlight(ta.value);
      gutter.textContent = lineNumbers(ta.value.split('\n').length);
      autoGrow(ta);
      sync();
    }

    function setState(text) { state.textContent = text || ''; }

    function showOutput(text, bad) {
      output.hidden = false;
      output.className = 'output' + (bad ? ' bad' : '');
      outputBody.textContent = text;
    }

    function runDemo() {
      run.disabled = true;
      setState('编译运行中…');
      showOutput('正在编译并运行这段代码…', false);
      fetch('/api/run-snippet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ta.value })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var lines = [];
          if (d.diags && d.diags.length) {
            for (var k = 0; k < d.diags.length; k++) {
              var g = d.diags[k];
              lines.push((g.severity === 'error' ? '错误' : '提示') + '：第 ' + g.line + ' 行，第 ' + g.col + ' 列 — ' + g.message);
            }
          }
          if (d.output) lines.push(String(d.output).replace(/\s+$/, ''));
          if (d.error) lines.push(String(d.error));
          showOutput(lines.length ? lines.join('\n') : '（程序没有输出）', !d.ok);
          setState(d.ok ? '完成' : '失败');
          run.disabled = false;
        })
        .catch(function (e) {
          showOutput('请求失败：' + e, true);
          setState('失败');
          run.disabled = false;
        });
    }

    function copyDemo() {
      var done = function () {
        var old = copy.textContent;
        copy.textContent = '✓';
        setTimeout(function () { copy.textContent = old; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(done, function () {
          ta.select();
          document.execCommand('copy');
          done();
        });
      } else {
        ta.select();
        document.execCommand('copy');
        done();
      }
    }

    ta.addEventListener('input', paint);
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = ta.selectionStart;
        var end = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = s + 4;
        paint();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runDemo();
      }
    });

    run.addEventListener('click', runDemo);
    copy.addEventListener('click', copyDemo);
    reset.addEventListener('click', function () {
      ta.value = original;
      paint();
      output.hidden = true;
      outputBody.textContent = '';
      setState('');
    });

    paint();
  }

  function setupDemos(root) {
    var demos = root.querySelectorAll('.demo');
    for (var i = 0; i < demos.length; i++) setupDemo(demos[i]);
  }
  setupDemos(document);

  // 窄屏目录
  var menuBtn = document.getElementById('menu-btn');
  var mask = document.getElementById('side-mask');
  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      document.body.classList.toggle('side-open');
    });
  }
  if (mask) {
    mask.addEventListener('click', function () {
      document.body.classList.remove('side-open');
    });
  }
  var side = document.getElementById('sidebar');
  if (side) {
    side.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== side && t.tagName !== 'A') t = t.parentNode;
      if (t && t.tagName === 'A') document.body.classList.remove('side-open');
    });
  }

  // 滚动时高亮当前小节
  var sections = [];
  var links = [];
  var ticking = false;

  function updateSectionSpy() {
    ticking = false;
    if (!sections.length) return;
    var active = null;
    var top = 100;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= top) active = sections[i].id;
    }
    for (var k = 0; k < links.length; k++) {
      links[k].classList.toggle('on', links[k].getAttribute('data-sec') === active);
    }
  }

  function refreshSectionSpy() {
    sections = Array.prototype.slice.call(document.querySelectorAll('.doc-body h2[id]'));
    links = Array.prototype.slice.call(document.querySelectorAll('.side-sec'));
    updateSectionSpy();
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(updateSectionSpy);
    }
  }, { passive: true });
  refreshSectionSpy();

  // 目录滚动：加载和切换章节时把当前项放在目录高度的 38.2% 附近
  var sidebar = document.getElementById('sidebar');
  var SIDEBAR_ANCHOR = 0.382;

  function scrollSidebarToItem(active, behavior) {
    if (!sidebar || !active) return;
    var box = sidebar.getBoundingClientRect();
    var rect = active.getBoundingClientRect();
    var target = sidebar.scrollTop + (rect.top - box.top) - box.height * SIDEBAR_ANCHOR + rect.height / 2;
    var max = sidebar.scrollHeight - sidebar.clientHeight;
    target = Math.max(0, Math.min(max, target));
    if (behavior === false) sidebar.scrollTop = target;
    else sidebar.scrollTo({ top: target, behavior: 'smooth' });
  }

  function scrollSidebarToCurrent(behavior) {
    if (!sidebar) return;
    scrollSidebarToItem(sidebar.querySelector('.side-sec.on') || sidebar.querySelector('.side-link.on'), behavior);
  }

  function sidebarSectionLink(id) {
    if (!sidebar) return null;
    var links = sidebar.querySelectorAll('.side-sec');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-sec') === id) return links[i];
    }
    return null;
  }

  if (sidebar) {
    requestAnimationFrame(function () {
      var hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
      scrollSidebarToItem(sidebarSectionLink(hashId) || sidebar.querySelector('.side-sec.on') || sidebar.querySelector('.side-link.on'), false);
    });
  }

  // 章节链接不整页刷新：只替换正文和目录
  function isDocsUrl(url) {
    return url.origin === location.origin && (url.pathname === '/docs' || url.pathname.indexOf('/docs/') === 0);
  }

  function navigateDocs(url, push) {
    var target = new URL(url, location.href);
    if (!isDocsUrl(target)) { location.href = target.href; return; }
    if (target.pathname === location.pathname && target.hash) {
      var id = decodeURIComponent(target.hash.slice(1));
      var same = document.getElementById(id);
      if (same) {
        same.scrollIntoView();
        if (push) history.pushState({}, '', target.pathname + target.search + target.hash);
        requestAnimationFrame(function () {
          updateSectionSpy();
          scrollSidebarToItem(sidebarSectionLink(id) || sidebar.querySelector('.side-sec.on') || sidebar.querySelector('.side-link.on'));
        });
      }
      return;
    }
    if (target.pathname === location.pathname && !target.hash) {
      window.scrollTo(0, 0);
      requestAnimationFrame(function () {
        updateSectionSpy();
        scrollSidebarToCurrent();
      });
      return;
    }

    fetch(target.pathname + target.search, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var parsed = new DOMParser().parseFromString(html, 'text/html');
        var nextMain = parsed.querySelector('.doc-main');
        var currentMain = document.querySelector('.doc-main');
        if (!nextMain || !currentMain) throw new Error('页面结构不完整');
        currentMain.innerHTML = nextMain.innerHTML;

        var nextSidebar = parsed.querySelector('#sidebar');
        var currentSidebar = document.getElementById('sidebar');
        if (nextSidebar && currentSidebar) {
          currentSidebar.innerHTML = nextSidebar.innerHTML;
        }

        document.title = parsed.title || document.title;
        var nextTitle = parsed.querySelector('.top-title');
        var currentTitle = document.querySelector('.top-title');
        if (nextTitle && currentTitle) currentTitle.textContent = nextTitle.textContent;
        if (push) history.pushState({}, '', target.pathname + target.search + target.hash);
        if (target.hash) {
          var anchor = document.getElementById(decodeURIComponent(target.hash.slice(1)));
          if (anchor) anchor.scrollIntoView();
          else window.scrollTo(0, 0);
        } else {
          window.scrollTo(0, 0);
        }
        setupDemos(currentMain);
        refreshSectionSpy();
        filterSidebar();
        requestAnimationFrame(function () {
          var link = target.hash ? sidebarSectionLink(decodeURIComponent(target.hash.slice(1))) : null;
          if (link) scrollSidebarToItem(link);
          else scrollSidebarToCurrent();
        });
        document.body.classList.remove('side-open');
      })
      .catch(function () { location.href = target.href; });
  }

  function filterSidebar() {
    var input = document.getElementById('doc-search');
    if (!input) return;
    var q = input.value.trim().toLowerCase();
    var links = document.querySelectorAll('.side-link');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var chapterText = ((link.textContent || '') + ' ' + (link.getAttribute('data-search') || '')).toLowerCase();
      var chapterMatch = !q || chapterText.indexOf(q) >= 0;
      var sections = link.nextElementSibling;
      var hasSection = sections && sections.className === 'side-sections';
      var anySection = false;
      if (hasSection) {
        var secs = sections.querySelectorAll('.side-sec');
        for (var j = 0; j < secs.length; j++) {
          var sec = secs[j];
          var showSec = !q || chapterMatch || (sec.textContent || '').toLowerCase().indexOf(q) >= 0;
          sec.style.display = showSec ? '' : 'none';
          if (showSec) anySection = true;
        }
        sections.style.display = anySection ? '' : 'none';
      }
      link.style.display = chapterMatch || anySection ? '' : 'none';
    }
  }

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'doc-search') filterSidebar();
  });

  document.addEventListener('click', function (e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentNode;
    if (!a || !a.getAttribute) return;
    var href = a.getAttribute('href');
    if (!href || a.target === '_blank') return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var url = new URL(a.href, location.href);
    if (!isDocsUrl(url)) return;
    e.preventDefault();
    navigateDocs(url.href, true);
  });

  window.addEventListener('popstate', function () {
    navigateDocs(location.href, false);
  });
})();
