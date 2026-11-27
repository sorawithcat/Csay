// Csay 编辑器：函数/方法声明的参数表和正文范围。
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
