// Csay 编辑器：补全菜单
function baseTypeName(t) {
  if (!t) return '';
  if (t.indexOf('<') >= 0) return t.slice(0, t.indexOf('<'));
  if (t.slice(-2) === '[]') return '数组';
  return t;
}

function concreteType(t, generic) {
  if (!t || !generic) return t;
  return String(t).replace(/元素/g, generic);
}

function addHint(out, seen, word, kind, params, ret, desc, type) {
  if (!word || seen[word]) return;
  seen[word] = true;
  var detail = kind === 'method' ? HINT_METHOD_DETAIL[word] : HINT_DETAIL[word];
  if (params === undefined) params = detail;
  var isCall = kind === 'method' || kind === 'function' || (kind === 'word' && detail !== undefined);
  var signature = '';
  if (isCall) signature = '(' + (params || '') + ')';
  if (ret) signature += ' : ' + ret;
  var label = word + signature;
  var text = isCall ? word + '()' : word;
  var description = desc || HINT_DESC[word] || '';
  out.push({
    text: text,
    name: word,
    label: label,
    signature: signature,
    detail: description || (type ? '类型 ' + type : ''),
    desc: description,
    typeName: type || '',
    kind: kind || 'word',
    className: 'hint-' + (kind || 'word'),
    call: isCall,
    render: renderHint,
    hint: completeCall
  });
}

function addTypeHints(out, seen, typeName, generic) {
  var base = baseTypeName(typeName);
  var meta = TYPE_MEMBERS[base];
  if (!meta) return false;
  var i;
  for (i = 0; i < meta.fields.length; i++) {
    var f = meta.fields[i];
    var ft = f.type === '元素' && generic ? generic : f.type;
    addHint(out, seen, f.name, 'field', '', ft, f.desc, ft);
  }
  for (i = 0; i < meta.methods.length; i++) {
    var m = meta.methods[i];
    var ret = m.ret;
    if (ret === '元素') ret = generic || '元素';
    addHint(out, seen, m.name, 'method', m.params, ret, m.desc, typeName);
  }
  return true;
}

function completeCall(editor, data, item) {
  hideHintTip();
  editor.replaceRange(item.text, item.from || data.from, item.to || data.to, 'complete');
  if (item.call) {
    var pos = editor.getCursor();
    editor.setCursor({ line: pos.line, ch: Math.max(0, pos.ch - 1) });
  }
}

function renderHint(li, data, item) {
  li.textContent = '';
  var name = document.createElement('span');
  name.className = 'hint-name';
  name.textContent = item.text.replace(/\(\)$/, '');
  li.appendChild(name);
  if (item.signature) {
    var sig = document.createElement('span');
    sig.className = 'hint-sig';
    sig.textContent = item.signature;
    li.appendChild(sig);
  }
  if (item.detail) {
    var detail = document.createElement('span');
    detail.className = 'hint-desc';
    detail.textContent = item.detail;
    li.appendChild(detail);
  }
  li.addEventListener('mouseenter', function () { showHintTip(li, item); });
  li.addEventListener('mouseleave', hideHintTip);
}

var hintTipEl = null;
function ensureHintTip() {
  if (hintTipEl === null) {
    hintTipEl = document.createElement('div');
    hintTipEl.className = 'hint-tip';
    document.body.appendChild(hintTipEl);
  }
  return hintTipEl;
}

function hideHintTip() {
  if (hintTipEl !== null) hintTipEl.style.display = 'none';
}

function hintTipLine(text, className) {
  var el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  hintTipEl.appendChild(el);
}

function showHintTip(li, item) {
  var tip = ensureHintTip();
  tip.textContent = '';
  hintTipLine(item.name + (item.signature || ''), 'hint-tip-title');
  if (item.desc) {
    var descLines = String(item.desc).split('\n');
    for (var di = 0; di < descLines.length; di++) hintTipLine(descLines[di], 'hint-tip-desc');
  }
  if (item.kind === 'field' && item.typeName) hintTipLine('类型：' + item.typeName, 'hint-tip-meta');
  if (!item.desc && item.kind === 'method') hintTipLine('方法', 'hint-tip-meta');
  if (!item.desc && item.kind === 'word') {
    if (HINT_TYPE_NAMES.indexOf(item.name) >= 0) hintTipLine('类型', 'hint-tip-meta');
    else if (HINT_DETAIL[item.name] !== undefined) hintTipLine('内建函数', 'hint-tip-meta');
    else hintTipLine('关键字', 'hint-tip-meta');
  }
  tip.style.display = 'block';
  var rect = li.getBoundingClientRect();
  var left = rect.left;
  if (left + tip.offsetWidth > window.innerWidth - 8) left = window.innerWidth - tip.offsetWidth - 8;
  if (left < 8) left = 8;
  var top = rect.top - tip.offsetHeight - 6;
  if (top < 8) top = rect.bottom + 6;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

document.addEventListener('mousedown', hideHintTip, true);
document.addEventListener('keydown', hideHintTip, true);
window.addEventListener('scroll', hideHintTip, true);
window.addEventListener('resize', hideHintTip);

// 轻量类型感知：扫源文件里的 类/结构/接口 声明和局部变量声明。
// 只求给编辑器一个有用的候选集，不替代编译器的语义检查。

function maskSource(text) {
  var chars = text.split('');
  var i = 0;
  while (i < text.length) {
    var c = text.charAt(i);
    if (c === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') { chars[i++] = ' '; }
    } else if (c === '/' && text.charAt(i + 1) === '*') {
      chars[i++] = ' '; chars[i++] = ' ';
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) {
        if (text.charAt(i) !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < text.length) { chars[i++] = ' '; chars[i++] = ' '; }
    } else if (c === '"') {
      chars[i++] = ' ';
      while (i < text.length) {
        if (text.charAt(i) === '\\') { chars[i++] = ' '; if (i < text.length) chars[i++] = ' '; continue; }
        if (text.charAt(i) === '"') { chars[i++] = ' '; break; }
        if (text.charAt(i) !== '\n') chars[i] = ' ';
        i++;
      }
    } else {
      i++;
    }
  }
  return chars.join('');
}

function addFunctionParams(out, text, cursor) {
  var decls = scanFunctionDecls(text);
  for (var i = 0; i < decls.length; i++) {
    var d = decls[i];
    if (!(cursor > d.bodyOpen && cursor <= d.bodyClose)) continue;
    var pieces = splitParamsText(d.paramsText);
    for (var j = 0; j < pieces.length; j++) {
      var pm = /^(?:(引用|输出)\s+)?(.+?)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)(?:\s*=[\s\S]*)?$/.exec(pieces[j].trim());
      if (!pm || HINT_WORDS.indexOf(pm[3]) >= 0) continue;
      out[pm[3]] = pm[2].trim();
    }
  }
}

function scanVariables(text, cursor) {
  var out = {};
  var masked = maskSource(text);
  var decls = scanFunctionDecls(masked);
  var stack = [];
  var ranges = [];
  var scopeAt = new Array(masked.length);
  for (var i = 0; i < masked.length; i++) {
    scopeAt[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (masked.charAt(i) === '{') {
      ranges.push({ start: i, end: masked.length });
      stack.push(i);
    } else if (masked.charAt(i) === '}' && stack.length > 0) {
      var open = stack.pop();
      for (var r = ranges.length - 1; r >= 0; r--) {
        if (ranges[r].start === open) { ranges[r].end = i; break; }
      }
    }
  }
  var visible = {};
  visible[-1] = true;
  for (var v = 0; v < ranges.length; v++) {
    if (cursor > ranges[v].start && cursor <= ranges[v].end) visible[ranges[v].start] = true;
  }
  var re = /([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*(?:<[^;=(){}]+>)?)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*(?=[=;,)\n])/g;
  var m;
  while ((m = re.exec(masked))) {
    var type = m[1], name = m[2];
    if (m.index >= cursor) continue;
    if (!visible[scopeAt[m.index]]) continue;
    if (/^(若|否则|选择|情况|循环|遍历|只要|返回|打印|新|使用|捕获|区域|命名空间)$/.test(type)) continue;
    if (HINT_WORDS.indexOf(name) >= 0) continue;
    var inParams = false;
    for (var pi = 0; pi < decls.length; pi++) {
      if (m.index > decls[pi].openParen && m.index < decls[pi].closeParen) {
        inParams = true;
        break;
      }
    }
    if (inParams) continue;
    out[name] = type;
  }
  addFunctionParams(out, masked, cursor);
  return out;
}

function csayHint(editor) {
  var cur = editor.getCursor();
  var token = editor.getTokenAt(cur);
  if (token && /comment|string/.test(token.type || '')) return null;
  var line = editor.getLine(cur.line);
  var end = cur.ch;
  var start = end;
  while (start > 0 && /[\w\u4e00-\u9fa5]/.test(line.charAt(start - 1))) start--;
  var word = line.slice(start, end);
  var dot = start > 0 && line.charAt(start - 1) === '.';
  var optional = dot && start > 1 && line.charAt(start - 2) === '?';
  var text = allSourceText();
  var types = scanTypes(text);
  var ownerName = enclosingClassName(text, editor.indexFromPos(cur));
  var ownerMembers = ownerName && types[ownerName] ? classMembers(text, types, ownerName) : null;
  var typeNames = Object.keys(types);
  var enumNames = Object.keys(scanEnums(text));
  var before = line.slice(0, start);
  var afterNew = /(?:^|[^\w\u4e00-\u9fa5])新\s*$/.test(before);
  var afterImport = /(?:^|[^\w\u4e00-\u9fa5])引\s*$/.test(before);
  if (afterImport) return null;
  var pool = [];
  var seen = {};

  if (dot) {
    var recvEnd = optional ? start - 2 : start - 1;
    var recvStart = recvEnd;
    while (recvStart > 0 && /[\w\u4e00-\u9fa5"“”]/.test(line.charAt(recvStart - 1))) recvStart--;
    var receiver = line.slice(recvStart, recvEnd);
    var enums = scanEnums(text);
    if (enums[receiver]) {
      for (var ei = 0; ei < enums[receiver].length; ei++) addHint(pool, seen, enums[receiver][ei], 'field', '', receiver);
    }
    var info = receiverInfo(text, receiver, editor.indexFromPos(cur));
    if (info) {
      var generic = info.typeName.replace(/^[^<]*<|>$/g, '');
      addTypeHints(pool, seen, info.typeName, generic);
      if (info.members) {
        for (var t = 0; t < info.members.length; t++) {
          var member = info.members[t];
          var memberStatic = !!(info.members._static && info.members._static[member]);
          if (info.staticOnly && !memberStatic) continue;
          if (!info.staticOnly && memberStatic) continue;
          var method = info.members._methods && info.members._methods[member];
          if (method) {
            addHint(pool, seen, member, 'method', concreteType(method.params, generic), concreteType(method.ret, generic));
          } else {
            var fieldType = info.members._fields && info.members._fields[member];
            addHint(pool, seen, member, 'field', '', concreteType(fieldType, generic), '', concreteType(fieldType, generic));
          }
        }
      }
    }
  } else if (afterNew) {
    // 新 后面只可能是类型。
    for (var bt = 0; bt < HINT_TYPE_NAMES.length; bt++) addHint(pool, seen, HINT_TYPE_NAMES[bt], 'type');
    for (var tn = 0; tn < typeNames.length; tn++) {
      addHint(pool, seen, typeNames[tn], 'type', '', '', types[typeNames[tn]]._doc);
    }
  } else {
    if (ownerMembers) {
      for (var om = 0; om < ownerMembers.length; om++) {
        var methodName = ownerMembers[om];
        var method = ownerMembers._methods && ownerMembers._methods[methodName];
        if (method) addHint(pool, seen, methodName, 'method', method.params, method.ret, method.doc);
      }
    }
    var funcs = scanFunctions(text);
    for (var fn in funcs) {
      if (funcs.hasOwnProperty(fn)) addHint(pool, seen, fn, 'function', funcs[fn].params, funcs[fn].ret, funcs[fn].doc);
    }
    for (var un = 0; un < typeNames.length; un++) {
      addHint(pool, seen, typeNames[un], 'type', '', '', types[typeNames[un]]._doc);
    }
    for (var en = 0; en < enumNames.length; en++) {
      addHint(pool, seen, enumNames[en], 'type');
    }
    for (var k = 0; k < HINT_WORDS.length; k++) {
      if (HINT_TYPE_NAMES.indexOf(HINT_WORDS[k]) >= 0) addHint(pool, seen, HINT_WORDS[k], 'type');
      else if (HINT_DETAIL[HINT_WORDS[k]] !== undefined) addHint(pool, seen, HINT_WORDS[k], 'function');
      else addHint(pool, seen, HINT_WORDS[k], 'word');
    }
    var vars = scanVariables(text, editor.indexFromPos(cur));
    for (var v in vars) {
      if (vars.hasOwnProperty(v)) {
        var fieldType = ownerMembers && ownerMembers._fields ? ownerMembers._fields[v] : '';
        addHint(pool, seen, v, fieldType ? 'field' : 'variable', '', fieldType || vars[v], '', fieldType || '');
      }
    }
    // 类内补全：把当前类及基类里尚未出现在局部变量中的字段和方法也列出来。
    if (ownerMembers) {
      for (var of = 0; of < ownerMembers.length; of++) {
        var fieldName = ownerMembers[of];
        var fieldType = ownerMembers._fields[fieldName];
        if (fieldType && !seen[fieldName]) {
          addHint(pool, seen, fieldName, 'field', '', fieldType, ownerMembers._docs[fieldName] || '', fieldType);
        }
      }
    }
  }

  var list = [];
  for (var i = 0; i < pool.length; i++) {
    if (pool[i].name === word) continue;
    if (word && pool[i].name.indexOf(word) !== 0) continue;
    list.push(pool[i]);
    if (list.length >= 200) break;
  }
  var rank = { type: 0, function: 1, method: 2, field: 3, variable: 4, word: 5 };
  list.sort(function (a, b) {
    var ra = rank[a.kind] === undefined ? 9 : rank[a.kind];
    var rb = rank[b.kind] === undefined ? 9 : rank[b.kind];
    return ra - rb || a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh');
  });
  if (!list.length) return null;
  return {
    list: list,
    from: CodeMirror.Pos(cur.line, start),
    to: CodeMirror.Pos(cur.line, end)
  };
}

CodeMirror.registerHelper('hint', 'csay', csayHint);

function showCsayHint(editor) {
  if (!modal.classList.contains('hidden')) return;
  var cur = editor.getCursor();
  var token = editor.getTokenAt(cur);
  if (token && /comment|string/.test(token.type || '')) return;
  function widget(cm) {
    var active = cm.state.completionActive;
    return active && active.widget ? active.widget : null;
  }
  try {
    editor.showHint({
      hint: function (cm) {
        var result = CodeMirror.hint.csay(cm);
        if (result) result.csayMoved = false;
        return result;
      },
      completeSingle: false,
      closeOnUnfocus: true,
      closeCharacters: /[\s()\[\]{};:>,，。；：、！？]/,
      extraKeys: {
        // Tab 直接接受第一项；方向键显式导航后，回车或 Tab 接受当前项。
        // 未导航时回车只关闭菜单，把回车交还给编辑器插入换行。
        Tab: function (cm, data) {
          var w = widget(cm);
          if (!w) return CodeMirror.Pass;
          data.csayMoved = true;
          w.pick();
        },
        Enter: function (cm, data) {
          if (!data.csayMoved) {
            if (cm.state.completionActive) cm.state.completionActive.close();
            return CodeMirror.Pass;
          }
          var w = widget(cm);
          if (w) w.pick();
        },
        Up: function (cm, data) {
          var w = widget(cm);
          if (!w) return;
          data.csayMoved = true;
          w.changeActive(w.selectedHint - 1);
        },
        Down: function (cm, data) {
          var w = widget(cm);
          if (!w) return;
          data.csayMoved = true;
          w.changeActive(w.selectedHint + 1);
        }
      }
    });
  } catch (e) {}
}

var hintTimer = 0;

cm.on('inputRead', function (editor, change) {
  if (change.origin !== '+input') return;
  var typed = change.text && change.text[0] ? change.text[0] : '';
  if (!typed) return;
  if (typed === ' ') {
    var before = editor.getLine(editor.getCursor().line).slice(0, editor.getCursor().ch);
    if (/(?:^|[^\w\u4e00-\u9fa5])新\s*$/.test(before)) {
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(function () { hintTimer = 0; showCsayHint(editor); }, 60);
    }
    return;
  }
  if (/[，。；：、！？,;:]/.test(typed)) {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = 0;
    }
    return;
  }
  if (!/[\w\u4e00-\u9fa5.]/.test(typed.charAt(typed.length - 1))) return;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(function () {
    hintTimer = 0;
    var cur = editor.getCursor();
    var before = editor.getLine(cur.line).slice(0, cur.ch);
    if (/[，。；：、！？,;:]\s*$/.test(before)) return;
    showCsayHint(editor);
  }, 60);
});
