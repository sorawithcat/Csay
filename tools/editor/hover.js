// Csay 编辑器：代码悬浮
function normalizeDoc(lines) {
  var text = lines.join('\n');
  text = text.replace(/<\/?(?:summary|remarks|example|returns|param|para)(?:\s[^>]*)?>/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function docBefore(text, index) {
  var lines = [];
  var pos = index;
  while (pos > 0) {
    var end = pos - 1;
    var start = text.lastIndexOf('\n', end - 1) + 1;
    var line = text.slice(start, end);
    var m = /^\s*\/\/\/(?:\s?)(.*)$/.exec(line);
    if (!m) break;
    lines.unshift(m[1]);
    pos = start;
  }
  return normalizeDoc(lines);
}

function scanEnums(text) {
  var out = {};
  var re = /(?:^|\n)[ \t]*(?:(?:公开|私有|保护|内部)\s+)*枚举\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*\{([^}]*)\}/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var items = [];
    var parts = m[2].split(/[,，\n]/);
    for (var i = 0; i < parts.length; i++) {
      var item = parts[i].replace(/\/\/.*$/, '').trim();
      if (/^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*$/.test(item)) items.push(item);
    }
    out[m[1]] = items;
  }
  return out;
}

function scanTypes(text) {
  var types = {};
  var re = /(?:类|结构|接口)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g;
  var m;
  while ((m = re.exec(text))) {
    var name = m[1];
    var open = text.indexOf('{', re.lastIndex);
    if (open < 0) break;
    var depth = 0, close = -1;
    for (var i = open; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) break;
    var body = text.slice(open + 1, close);
    var bodyStart = open + 1;
    var bodyOffset = 0;
    var members = [];
    members._methods = {};
    members._fields = {};
    members._static = {};
    members._docs = {};
    var memberDepth = 0;
    var lines = body.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var lineText = lines[li];
      var lineStartAbs = bodyStart + bodyOffset;
      bodyOffset += lineText.length + 1;
      if (memberDepth === 0) {
        var memberRe = /^\s*((?:(?:公开|私有|保护|内部|静态|虚拟|覆盖|抽象|只读|常)\s+)*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5<>,\[\]:]*)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*([（(]|;|=|\{)/;
        var mm = memberRe.exec(lineText);
        if (mm) {
          var isStatic = /静态/.test(mm[1]);
          if (members.indexOf(mm[3]) < 0) members.push(mm[3]);
          members._static[mm[3]] = isStatic;
          members._docs[mm[3]] = docBefore(text, lineStartAbs);
          if (mm[4] === '(' || mm[4] === '（') {
            var openParen = lineText.indexOf('(', mm.index + mm[0].length - 1);
            var openFull = lineText.indexOf('（', mm.index + mm[0].length - 1);
            if (openParen < 0 || (openFull >= 0 && openFull < openParen)) openParen = openFull;
            var closeParen = lineText.indexOf(')', openParen + 1);
            var closeFull = lineText.indexOf('）', openParen + 1);
            if (closeParen < 0 || (closeFull >= 0 && closeFull < closeParen)) closeParen = closeFull;
            members._methods[mm[3]] = {
              params: closeParen > openParen ? lineText.slice(openParen + 1, closeParen).trim() : '',
              ret: mm[2],
              doc: members._docs[mm[3]]
            };
          } else {
            members._fields[mm[3]] = mm[2];
          }
        }
      }
      for (var ci = 0; ci < lineText.length; ci++) {
        var ch = lineText.charAt(ci);
        if (ch === '/' && lineText.charAt(ci + 1) === '/') break;
        if (ch === '"' || ch === "'") {
          var quote = ch;
          ci++;
          while (ci < lineText.length && lineText.charAt(ci) !== quote) {
            if (lineText.charAt(ci) === '\\') ci++;
            ci++;
          }
          continue;
        }
        if (ch === '{') memberDepth++;
        else if (ch === '}') memberDepth--;
      }
    }
    members._doc = docBefore(text, text.lastIndexOf('\n', m.index) + 1);
    types[name] = members;
    re.lastIndex = close + 1;
  }
  return types;
}

function enclosingClassName(text, pos) {
  var re = /(?:^|\n)[ \t]*(?:(?:公开|私有|保护|内部|静态|只读|抽象|虚拟|覆盖|密封)\s+)*类\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)[^{]*\{/g;
  var found = null;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) break;
    var open = text.indexOf('{', m.index);
    var depth = 0;
    var close = -1;
    for (var i = open; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (open < pos && pos < close) found = m[1];
  }
  return found;
}

function baseClassName(text, cls) {
  var re = new RegExp('(?:^|\\n)[ \\t]*(?:(?:公开|私有|保护|内部|静态|只读|抽象|虚拟|覆盖|密封)\\s+)*类\\s+' + cls + '\\s*:\\s*([A-Za-z_\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5]*)');
  var m = re.exec(text);
  return m ? m[1] : null;
}

function detectReceiverType(text, receiver, pos) {
  if (!receiver) return null;
  if ((receiver === '自' || receiver === '基') && pos !== undefined) {
    var cls = enclosingClassName(text, pos);
    if (cls) return receiver === '基' ? baseClassName(text, cls) : cls;
  }
  var types = scanTypes(text);
  if (types[receiver]) return receiver;
  var vars = {};
  var varRe = /([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5<>,\[\]:]*)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*(?:=|;|,|\)|\）)/g;
  var m;
  while ((m = varRe.exec(text))) {
    if (types[m[1]] || TYPE_MEMBERS[baseTypeName(m[1])] || HINT_TYPE_NAMES.indexOf(m[1]) >= 0) vars[m[2]] = m[1];
  }
  // 函数参数：文本 前缀) / 整数 x,
  var paramRe = /([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5<>,\[\]:]*)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*(?:,|\)|\）)/g;
  while ((m = paramRe.exec(text))) {
    if (types[m[1]] || TYPE_MEMBERS[baseTypeName(m[1])] || HINT_TYPE_NAMES.indexOf(m[1]) >= 0) vars[m[2]] = m[1];
  }
  if (vars[receiver]) return vars[receiver];
  if (/^["“]/.test(receiver)) return '文本';
  if (/^-?\d+$/.test(receiver)) return '整数';
  if (/^-?\d+\.\d+$/.test(receiver)) return '长小数';
  if (receiver === '真' || receiver === '假') return '真假';
  return null;
}

function classMembers(text, types, name) {
  var members = [];
  var visited = {};
  members._methods = {};
  members._fields = {};
  members._static = {};
  members._docs = {};
  function add(n) {
    if (!n || visited[n] || !types[n]) return;
    visited[n] = true;
    var own = types[n];
    for (var i = 0; i < own.length; i++) {
      var member = own[i];
      if (members.indexOf(member) < 0) members.push(member);
      if (own._methods && own._methods[member] && !members._methods[member]) members._methods[member] = own._methods[member];
      if (own._fields && own._fields[member] && !members._fields[member]) members._fields[member] = own._fields[member];
      if (own._docs && own._docs[member] && !members._docs[member]) members._docs[member] = own._docs[member];
      if (own._static && own._static[member]) members._static[member] = true;
    }
    add(baseClassName(text, n));
  }
  add(name);
  members._doc = types[name] ? types[name]._doc : '';
  return members;
}

function receiverInfo(text, receiver, pos) {
  var typeName = detectReceiverType(text, receiver, pos);
  if (!typeName) return null;
  var base = baseTypeName(typeName);
  if (TYPE_MEMBERS[base]) return { typeName: typeName, base: base, members: null };
  var types = scanTypes(text);
  if (!types[base]) return null;
  var typeLike = receiver === typeName;
  return { typeName: typeName, base: base, members: classMembers(text, types, base), staticOnly: typeLike };
}

// 顶层函数和方法的签名，供代码区悬浮提示使用。
function scanFunctions(text) {
  var out = {};
  var re = /(?:^|\n)[ \t]*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5<>,\[\]:]*)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*[（(]([^）)]*)[）)]\s*\{/g;
  var m;
  while ((m = re.exec(text))) {
    var start = m.index + (m[0].charAt(0) === '\n' ? 1 : 0);
    out[m[2]] = { ret: m[1], params: m[3].trim(), doc: docBefore(text, start) };
  }
  return out;
}

// 函数/方法声明的参数表，带正文范围，用于悬浮参数时显示它属于哪个签名。
function scanFunctionDecls(text) {
  var out = [];
  var re = /(?:^|\n)[ \t]*(?:(?:公开|私有|保护|内部|静态|虚拟|覆盖|抽象|只读|常|密封|异步)\s+)*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5<>,\[\]:]*)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*[（(]([^）)]*)[）)]\s*(\{|=>)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var start = m.index + (m[0].charAt(0) === '\n' ? 1 : 0);
    var nameAt = text.indexOf(m[2], m.index);
    var openParen = text.indexOf('(', nameAt + m[2].length);
    var openFull = text.indexOf('（', nameAt + m[2].length);
    if (openParen < 0 || (openFull >= 0 && openFull < openParen)) openParen = openFull;
    if (openParen < 0) continue;
    var closeParen = text.indexOf(')', openParen + 1);
    var closeFull = text.indexOf('）', openParen + 1);
    if (closeParen < 0 || (closeFull >= 0 && closeFull < closeParen)) closeParen = closeFull;
    if (closeParen < 0) continue;
    var d = {
      name: m[2], ret: m[1], paramsText: text.slice(openParen + 1, closeParen),
      start: start, openParen: openParen, closeParen: closeParen, bodyOpen: -1, bodyClose: -1
    };
    if (m[4] === '{') {
      var open = text.indexOf('{', closeParen + 1);
      if (open >= 0) {
        var depth = 0, close = -1;
        for (var i = open; i < text.length; i++) {
          var ch = text.charAt(i);
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { close = i; break; }
          }
        }
        d.bodyOpen = open;
        d.bodyClose = close;
      }
    } else {
      d.bodyOpen = closeParen + 1;
      d.bodyClose = text.indexOf('\n', closeParen + 1);
      if (d.bodyClose < 0) d.bodyClose = text.length;
    }
    out.push(d);
    re.lastIndex = closeParen + 1;
  }
  return out;
}

function splitParamsText(text) {
  var out = [], depth = 0, start = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// 找到光标所在的调用实参，返回被调函数、实参序号和参数表。
function callArgAt(text, offset) {
  var opens = [];
  var quote = null;
  for (var i = 0; i < offset; i++) {
    var ch = text.charAt(i);
    if (quote !== null) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && text.charAt(i + 1) === '/') {
      var nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '*') {
      var endComment = text.indexOf('*/', i + 2);
      i = endComment < 0 ? text.length : endComment + 1;
      continue;
    }
    if (ch === '(') opens.push(i);
    else if (ch === ')' && opens.length > 0) opens.pop();
  }
  var decls = scanFunctionDecls(text);
  for (var oi = opens.length - 1; oi >= 0; oi--) {
    var open = opens[oi];
    var j = open - 1;
    while (j >= 0 && /\s/.test(text.charAt(j))) j--;
    var end = j + 1;
    while (j >= 0 && /[A-Za-z_\u4e00-\u9fa5]/.test(text.charAt(j))) j--;
    var name = text.slice(j + 1, end);
    if (!name || !/^[A-Za-z_\u4e00-\u9fa5]/.test(name)) continue;
    var isDecl = false;
    for (var di = 0; di < decls.length; di++) {
      if (offset >= decls[di].openParen && offset <= decls[di].closeParen) { isDecl = true; break; }
    }
    if (isDecl) return null;
    var receiver = '';
    var dot = j;
    while (dot >= 0 && /\s/.test(text.charAt(dot))) dot--;
    if (text.charAt(dot) === '.') {
      var rEnd = dot;
      var rStart = rEnd - 1;
      while (rStart >= 0 && /[A-Za-z_\u4e00-\u9fa5]/.test(text.charAt(rStart))) rStart--;
      receiver = text.slice(rStart + 1, rEnd);
    }
    var index = 0;
    var depth = 0;
    quote = null;
    for (var k = open + 1; k < offset; k++) {
      var c = text.charAt(k);
      if (quote !== null) {
        if (c === '\\' && quote === '"') { k++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) index++;
    }
    return { name: name, receiver: receiver, index: index, open: open };
  }
  return null;
}

function parseParamAt(paramsText, index) {
  var pieces = splitParamsText(paramsText);
  if (index < 0 || index >= pieces.length) return null;
  var pm = /^(?:(引用|输出)\s+)?(.+?)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)(?:\s*=[\s\S]*)?$/.exec(pieces[index].trim());
  if (!pm) return { type: pieces[index].trim(), name: '', mode: '' };
  return { type: pm[2].trim(), name: pm[3], mode: pm[1] || '' };
}

function argumentInfoAt(text, offset) {
  var call = callArgAt(text, offset);
  if (call === null) return null;
  var sig = null;
  var label = '函数';
  var owner = '';
  var funcs = scanFunctions(text);
  if (funcs[call.name]) {
    sig = funcs[call.name];
  } else if (call.receiver) {
    var info = receiverInfo(text, call.receiver, offset);
    if (info && info.members && info.members._methods && info.members._methods[call.name]) {
      sig = info.members._methods[call.name];
      label = '方法';
      owner = info.typeName;
    } else if (info && TYPE_MEMBERS[info.base]) {
      var tm = TYPE_MEMBERS[info.base];
      for (var i = 0; i < tm.methods.length; i++) {
        if (tm.methods[i].name === call.name) {
          sig = tm.methods[i];
          label = '方法';
          owner = info.base;
          break;
        }
      }
    }
  }
  if (sig === null) return null;
  var p = parseParamAt(sig.params, call.index);
  if (p === null) return null;
  var title = p.name ? '参数「' + p.name + '」' : '第 ' + (call.index + 1) + ' 个参数';
  var detail = label + ' ' + call.name + '(' + sig.params + ')';
  if (sig.doc) detail += '\n' + sig.doc;
  return {
    name: title,
    signature: ' : ' + p.type,
    kind: 'parameter',
    desc: detail,
    meta: '第 ' + (call.index + 1) + ' 个参数' + (owner ? ' · ' + owner : '') + ' · ' + label
  };
}

function parameterAt(text, word, pos) {
  var decls = scanFunctionDecls(text);
  var best = null;
  for (var i = 0; i < decls.length; i++) {
    var d = decls[i];
    if (pos < d.start) continue;
    var inSig = pos >= d.openParen && pos <= d.closeParen;
    var inBody = d.bodyOpen >= 0 && pos > d.bodyOpen && (d.bodyClose < 0 || pos < d.bodyClose);
    if (!inSig && !inBody) continue;
    var pieces = splitParamsText(d.paramsText);
    for (var j = 0; j < pieces.length; j++) {
      var pm = /^(?:(引用|输出)\s+)?(.+?)\s+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)(?:\s*=[\s\S]*)?$/.exec(pieces[j].trim());
      if (!pm || pm[3] !== word) continue;
      if (best === null || d.start > best.start) {
        best = {
          name: pm[3], type: pm[2].trim(), mode: pm[1] || '',
          func: d.name, start: d.start,
          kind: enclosingClassName(text, pos) ? '方法' : '函数'
        };
      }
    }
  }
  return best;
}

function codeWordAt(editor, pos) {
  var line = editor.getLine(pos.line);
  var ch = Math.min(pos.ch, line.length);
  var numRe = /-?\d+(?:\.\d+)?/g;
  var nm;
  while ((nm = numRe.exec(line)) !== null) {
    if (nm.index > 0 && /[\w\u4e00-\u9fa5]/.test(line.charAt(nm.index - 1))) continue;
    if (nm.index + nm[0].length < line.length && /[\w\u4e00-\u9fa5]/.test(line.charAt(nm.index + nm[0].length))) continue;
    if (ch >= nm.index && ch <= nm.index + nm[0].length) {
      return { word: nm[0], start: nm.index, end: nm.index + nm[0].length, line: line };
    }
  }
  if (ch > 0 && !/[\w\u4e00-\u9fa5]/.test(line.charAt(ch - 1)) && !/[\w\u4e00-\u9fa5]/.test(line.charAt(ch))) return null;
  var start = ch;
  while (start > 0 && /[\w\u4e00-\u9fa5]/.test(line.charAt(start - 1))) start--;
  var end = ch;
  while (end < line.length && /[\w\u4e00-\u9fa5]/.test(line.charAt(end))) end++;
  if (start === end) return null;
  return { word: line.slice(start, end), start: start, end: end, line: line };
}

function allSourceText() {
  var text = cm.getValue();
  var cur = current();
  var curPath = cur ? cur.path : '';
  for (var i = 0; i < WORKSPACE_SOURCES.length; i++) {
    if (WORKSPACE_SOURCES[i].path === curPath) continue;
    text += '\n' + WORKSPACE_SOURCES[i].text;
  }
  return text;
}

function refreshWorkspaceSources() {
  var t = current();
  if (!t) { WORKSPACE_SOURCES = []; return; }
  fetch('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: t.path, text: cm.getValue() })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.files) WORKSPACE_SOURCES = d.files;
  }).catch(function () {});
}

function codeHoverItem(editor, pos) {
  var found = codeWordAt(editor, pos);
  if (!found) return null;
  var word = found.word;
  var text = allSourceText();
  var types = scanTypes(text);
  var before = found.line.slice(0, found.start);
  var dot = /\.\s*$/.test(before);

  if (dot) {
    var recv = before.replace(/\s+$/, '').slice(0, -1);
    var recvMatch = /([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)$/.exec(recv);
    if (!recvMatch) return null;
    recv = recvMatch[1];
    var enums = scanEnums(text);
    if (enums[recv] && enums[recv].indexOf(word) >= 0) {
      return { name: word, kind: 'field', typeName: recv, meta: '枚举成员' };
    }
    var info = receiverInfo(text, recv, editor.indexFromPos(pos));
    if (!info) return null;
    if (info.members) {
      if (info.members._methods && info.members._methods[word]) {
        var mm = info.members._methods[word];
        return { name: word, signature: '(' + mm.params + ') : ' + mm.ret, kind: 'method', desc: mm.doc || '', meta: '方法' };
      }
      if (info.members._fields && info.members._fields[word]) {
        return { name: word, kind: 'field', typeName: info.members._fields[word], desc: (info.members._docs && info.members._docs[word]) || '', meta: '字段' };
      }
      return null;
    }
    var tm = TYPE_MEMBERS[info.base];
    if (!tm) return null;
    var i;
    for (i = 0; i < tm.fields.length; i++) {
      if (tm.fields[i].name === word) return { name: word, kind: 'field', typeName: tm.fields[i].type, desc: tm.fields[i].desc || '字段' };
    }
    for (i = 0; i < tm.methods.length; i++) {
      if (tm.methods[i].name === word) {
        return { name: word, signature: '(' + tm.methods[i].params + ') : ' + tm.methods[i].ret, kind: 'method', desc: tm.methods[i].desc || '方法' };
      }
    }
    return null;
  }

  var arg = argumentInfoAt(text, editor.indexFromPos(pos));
  if (arg) return arg;
  if (/^-?\d+(?:\.\d+)?$/.test(word)) {
    return { name: word, kind: 'literal', typeName: word.indexOf('.') >= 0 ? '长小数' : '整数', desc: '字面量' };
  }
  if (/^\s*引\s*$/.test(found.line.slice(0, found.start))) {
    return { name: word, kind: 'import', desc: '引入的同目录文件' };
  }
  var param = parameterAt(text, word, editor.indexFromPos(pos));
  if (param) {
    return {
      name: word,
      signature: ' : ' + param.type,
      kind: 'parameter',
      desc: param.kind + ' ' + param.func + ' 的参数' + (param.mode ? '（' + param.mode + '）' : ''),
      meta: '参数'
    };
  }
  if (types[word]) return { name: word, kind: 'type', desc: types[word]._doc || '自定义类型', meta: '成员 ' + types[word].length + ' 个' };
  var owner;
  for (owner in types) {
    var own = types[owner];
    if (own._methods && own._methods[word]) {
      var om = own._methods[word];
      return { name: word, signature: '(' + om.params + ') : ' + om.ret, kind: 'method', desc: om.doc || '', meta: '方法 · ' + owner };
    }
    if (own._fields && own._fields[word]) {
      return { name: word, kind: 'field', typeName: own._fields[word], desc: (own._docs && own._docs[word]) || '', meta: '字段 · ' + owner };
    }
  }
  if (HINT_TYPE_NAMES.indexOf(word) >= 0) return { name: word, kind: 'type', desc: '内建类型' };
  if (HINT_DETAIL[word] !== undefined) {
    return { name: word, signature: '(' + HINT_DETAIL[word] + ')', kind: 'builtin', desc: HINT_DESC[word] || '内建函数', meta: '内建函数' };
  }
  var funcs = scanFunctions(text);
  if (funcs[word]) return { name: word, signature: '(' + funcs[word].params + ') : ' + funcs[word].ret, kind: 'function', desc: funcs[word].doc || '', meta: '函数' };
  var vt = detectReceiverType(text, word);
  if (vt) return { name: word, kind: 'variable', typeName: vt, desc: '', meta: '变量' };
  if (HINT_WORDS.indexOf(word) >= 0) return { name: word, kind: 'word', desc: '', meta: '关键字' };
  return null;
}

var lastHoverKey = null;
function showCodeHover(editor, event) {
  if (typeof SETTINGS !== 'undefined' && !SETTINGS.hover) { hideHintTip(); lastHoverKey = null; return; }
  if (document.querySelector('.CodeMirror-hints')) { hideHintTip(); return; }
  var pos = editor.coordsChar({ left: event.clientX, top: event.clientY });
  var item = codeHoverItem(editor, pos);
  if (!item) { hideHintTip(); lastHoverKey = null; return; }
  var key = item.name + ':' + pos.line + ':' + pos.ch;
  if (key === lastHoverKey) return;
  lastHoverKey = key;
  var tip = ensureHintTip();
  tip.textContent = '';
  hintTipLine(item.name + (item.signature || ''), 'hint-tip-title');
  if (item.desc) {
    var descLines = String(item.desc).split('\n');
    for (var di = 0; di < descLines.length; di++) hintTipLine(descLines[di], 'hint-tip-desc');
  }
  if (item.typeName) hintTipLine('类型：' + item.typeName, 'hint-tip-meta');
  if (item.meta) hintTipLine(item.meta, 'hint-tip-meta');
  tip.style.display = 'block';
  var left = event.clientX + 14;
  var top = event.clientY + 16;
  if (left + tip.offsetWidth > window.innerWidth - 8) left = window.innerWidth - tip.offsetWidth - 8;
  if (left < 8) left = 8;
  if (top + tip.offsetHeight > window.innerHeight - 8) top = event.clientY - tip.offsetHeight - 10;
  if (top < 8) top = 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
