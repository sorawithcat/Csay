// Csay 编辑器：输入便利。中文引号纠正、括号/引号成对补全、文档注释模板。
var editingPairGuard = false;
var editingComposing = false;

function editingInStringOrComment(editor, pos) {
  var token = editor.getTokenAt(pos);
  return !!(token && /comment|string/.test(token.type || ''));
}

function editingInsert(editor, text, cursorBack) {
  if (editor.somethingSelected()) return;
  editingPairGuard = true;
  editor.replaceRange(text, editor.getCursor());
  if (cursorBack) {
    var cur = editor.getCursor();
    editor.setCursor({ line: cur.line, ch: cur.ch - cursorBack });
  }
  editingPairGuard = false;
}


cm.on('beforeChange', function (editor, change) {
  if (editingPairGuard || editingComposing) return;
  if (change.origin !== '+input') return;
  var typed = change.text && change.text.join('');
  var closers = { '}': '}', ')': ')', ']': ']', '"': '"' };
  if (SETTINGS.autoClose && closers[typed]) {
    var line = editor.getLine(change.from.line);
    if (line.charAt(change.from.ch) === typed) {
      change.cancel();
      editor.setCursor({ line: change.from.line, ch: change.from.ch + 1 });
      return;
    }
  }
  if (typed !== '「' && typed !== '」') return;
  if (editingInStringOrComment(editor, change.from)) return;
  change.cancel();
  editingPairGuard = true;
  if (typed === '「') {
    editor.replaceRange(SETTINGS.autoClose ? '{}' : '{', change.from, change.from);
    editor.setCursor({ line: change.from.line, ch: change.from.ch + 1 });
  } else {
    editor.replaceRange('}', change.from, change.from);
    editor.setCursor({ line: change.from.line, ch: change.from.ch + 1 });
  }
  editingPairGuard = false;
});

function editingCorrectComposedBracket() {
  if (editingPairGuard || editingComposing) return;
  var cur = cm.getCursor();
  var line = cm.getLine(cur.line);
  var ch = cur.ch;
  var start = -1;
  if (line.charAt(ch - 1) === '「') start = ch - 1;
  else if (line.charAt(ch - 2) === '「' && line.charAt(ch - 1) === '}') start = ch - 2;
  else if (line.charAt(ch - 1) === '」') start = ch - 1;
  if (start < 0) return;
  if (editingInStringOrComment(cm, { line: cur.line, ch: start })) return;
  var typed = line.charAt(start);
  editingPairGuard = true;
  if (typed === '「') {
    var open = SETTINGS.autoClose ? '{}' : '{';
    var end = SETTINGS.autoClose && line.charAt(start + 1) === '}' ? start + 2 : start + 1;
    cm.replaceRange(open, { line: cur.line, ch: start }, { line: cur.line, ch: end });
    cm.setCursor({ line: cur.line, ch: start + 1 });
  } else {
    cm.replaceRange('}', { line: cur.line, ch: start }, { line: cur.line, ch: start + 1 });
    cm.setCursor({ line: cur.line, ch: start + 1 });
  }
  editingPairGuard = false;
}

var editingInput = cm.getInputField();
editingInput.addEventListener('compositionstart', function () {
  editingComposing = true;
});
// 输入法组合期间不能直接改文本，否则组合结束时会回滚；等 compositionend 再纠正。
editingInput.addEventListener('compositionend', function () {
  setTimeout(function () {
    editingComposing = false;
    editingCorrectComposedBracket();
  }, 0);
});
editingInput.addEventListener('blur', function () {
  editingComposing = false;
});

cm.on('inputRead', function (editor, change) {
  if (editingPairGuard) return;
  var typed = change.text && change.text.join('');
  if (!typed) return;

  // 输入法可能把「」直接写进文档而不经过 beforeChange；等这一轮输入结束再纠正。
  if (typed.indexOf('「') !== -1 || typed.indexOf('」') !== -1) {
    setTimeout(editingCorrectComposedBracket, 0);
    return;
  }
  if (!SETTINGS.autoClose || change.origin !== '+input') return;

  var cur = editor.getCursor();
  var before = editor.getLine(cur.line).slice(0, cur.ch);
  var after = editor.getLine(cur.line).slice(cur.ch);

  // /// 在行首生成文档注释模板，光标落在正文行。
  if ((typed === '/' || typed === '///') && /^\s*\/\/\/$/.test(before)) {
    var indent = before.match(/^\s*/)[0];
    var template = indent + '/// <summary>\n' + indent + '/// \n' + indent + '/// </summary>';
    editingPairGuard = true;
    editor.replaceRange(template, { line: cur.line, ch: 0 }, { line: cur.line, ch: cur.ch });
    editor.setCursor({ line: cur.line + 1, ch: indent.length + 4 });
    editingPairGuard = false;
    return;
  }

  if ((typed === '*' || typed === '/*') && /\/\*$/.test(before) && after.slice(0, 2) !== '*/') {
    editingInsert(editor, ' */', 0);
    return;
  }

  if (editingInStringOrComment(editor, change.from)) return;

  // 只补右半边；已经紧跟同一个右括号时不重复。
  var pairs = { '{': '}', '(': ')', '[': ']' };
  if (pairs[typed] && after.charAt(0) !== pairs[typed]) {
    editingInsert(editor, pairs[typed], 1);
    return;
  }

  if (typed === '"' && after.charAt(0) !== '"') {
    editingInsert(editor, '"', 1);
  }
});
