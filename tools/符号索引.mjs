// 编辑器符号索引：转到定义 / 查找引用。
// 只做名字级索引，不做类型推断；对 Csay 这种中文标识符已经足够实用。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { parse } from '../src/parser.ts'
import { tokenize } from '../src/lexer.ts'

const IDENT = /[\p{L}\p{N}_]/u
const MEMBER_KINDS = new Set(['field', 'method', 'property'])
const SKIP_DIRS = new Set(['.git', 'build', 'release', 'node_modules', 'codemirror', 'tcc', '.workbuddy'])

function isIdent(ch) {
  return !!ch && IDENT.test(ch)
}

function lineText(source, line) {
  return String(source).split(/\r?\n/)[line - 1] ?? ''
}

function locate(source, line, name, fromCol = 1) {
  const text = lineText(source, line)
  let at = text.indexOf(name, Math.max(0, fromCol - 1))
  if (at < 0) at = text.indexOf(name)
  return at < 0 ? 1 : at + 1
}

function resolveImport(from, name) {
  const dir = dirname(from)
  return resolve(dir, name.endsWith('.csay') ? name : name + '.csay')
}

export function wordAt(source, line, col) {
  const text = lineText(source, line)
  let i = Math.max(0, Math.min(col - 1, text.length))
  if (!isIdent(text[i]) && i > 0 && isIdent(text[i - 1])) i--
  if (!isIdent(text[i])) return null
  let start = i
  let end = i + 1
  while (start > 0 && isIdent(text[start - 1])) start--
  while (end < text.length && isIdent(text[end])) end++
  return { name: text.slice(start, end), start: start + 1, end: end + 1 }
}

function readLayer(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function loadLayers(entry, entrySource) {
  const layers = []
  const seen = new Set()
  function visit(path, source) {
    const abs = resolve(path)
    if (seen.has(abs)) return
    seen.add(abs)
    const src = source ?? readLayer(abs)
    if (src === null) return
    const { unit } = parse(src)
    layers.push({ path: abs, source: src, unit })
    for (const name of unit.usings) {
      const dep = resolveImport(abs, name)
      if (existsSync(dep)) visit(dep)
    }
  }
  visit(entry, entrySource)
  return layers
}

function addCandidate(out, layer, node, name, kind, container) {
  if (!name) return
  out.push({
    file: layer.path,
    line: node.line,
    col: locate(layer.source, node.line, name, node.col),
    name,
    kind,
    container: container ?? '',
  })
}

function addParams(out, layer, params, owner, container) {
  for (const p of params) {
    out.push({
      file: layer.path,
      line: owner.line,
      col: locate(layer.source, owner.line, p.name, owner.col),
      name: p.name,
      kind: 'parameter',
      container: container ?? '',
    })
  }
}

function walkExpr(out, layer, expr, container) {
  if (!expr) return
  switch (expr.kind) {
    case 'binary': walkExpr(out, layer, expr.left, container); walkExpr(out, layer, expr.right, container); break
    case 'unary': case 'postfix': walkExpr(out, layer, expr.operand, container); break
    case 'assign': walkExpr(out, layer, expr.target, container); walkExpr(out, layer, expr.value, container); break
    case 'cond': walkExpr(out, layer, expr.cond, container); walkExpr(out, layer, expr.then, container); walkExpr(out, layer, expr.else, container); break
    case 'call': walkExpr(out, layer, expr.callee, container); for (const a of expr.args) walkExpr(out, layer, a, container); break
    case 'member': walkExpr(out, layer, expr.target, container); break
    case 'index': walkExpr(out, layer, expr.target, container); walkExpr(out, layer, expr.index, container); break
    case 'new': for (const a of expr.args) walkExpr(out, layer, a, container); break
    case 'array': for (const a of expr.elems) walkExpr(out, layer, a, container); break
    case 'paren': walkExpr(out, layer, expr.expr, container); break
    case 'lambda':
      addParams(out, layer, expr.params, expr, container)
      if (expr.body.kind === 'block') walkStmt(out, layer, expr.body, container)
      else walkExpr(out, layer, expr.body, container)
      break
    default: break
  }
}

function walkStmt(out, layer, stmt, container) {
  if (!stmt) return
  switch (stmt.kind) {
    case 'block': for (const s of stmt.stmts) walkStmt(out, layer, s, container); break
    case 'var':
      addCandidate(out, layer, stmt, stmt.name, 'variable', container)
      walkExpr(out, layer, stmt.init, container)
      break
    case 'expr': walkExpr(out, layer, stmt.expr, container); break
    case 'if':
      walkExpr(out, layer, stmt.cond, container)
      walkStmt(out, layer, stmt.then, container)
      if (stmt.els) walkStmt(out, layer, stmt.els, container)
      break
    case 'while':
      walkExpr(out, layer, stmt.cond, container); walkStmt(out, layer, stmt.body, container); break
    case 'dowhile':
      walkStmt(out, layer, stmt.body, container); walkExpr(out, layer, stmt.cond, container); break
    case 'for':
      if (stmt.init) walkStmt(out, layer, stmt.init, container)
      walkExpr(out, layer, stmt.cond, container)
      for (const s of stmt.step) walkExpr(out, layer, s, container)
      walkStmt(out, layer, stmt.body, container)
      break
    case 'foreach':
      out.push({
        file: layer.path, line: stmt.line, col: locate(layer.source, stmt.line, stmt.name, stmt.col),
        name: stmt.name, kind: 'variable', container,
      })
      walkExpr(out, layer, stmt.iter, container)
      walkStmt(out, layer, stmt.body, container)
      break
    case 'switch':
      walkExpr(out, layer, stmt.subject, container)
      for (const c of stmt.clauses) for (const s of c.stmts) walkStmt(out, layer, s, container)
      break
    case 'return': walkExpr(out, layer, stmt.value, container); break
    case 'throw': walkExpr(out, layer, stmt.value, container); break
    case 'try':
      walkStmt(out, layer, stmt.body, container)
      for (const c of stmt.catches) {
        if (c.name) out.push({
          file: layer.path, line: stmt.line, col: locate(layer.source, stmt.line, c.name, stmt.col),
          name: c.name, kind: 'variable', container,
        })
        walkStmt(out, layer, c.body, container)
      }
      if (stmt.fin) walkStmt(out, layer, stmt.fin, container)
      break
    case 'region': walkStmt(out, layer, stmt.body, container); break
    case 'using':
      walkExpr(out, layer, stmt.target, container); walkStmt(out, layer, stmt.body, container); break
    case 'localFunc':
      addCandidate(out, layer, stmt, stmt.name, 'function', container)
      addParams(out, layer, stmt.params, stmt, container)
      walkStmt(out, layer, stmt.body, stmt.name)
      break
    default: break
  }
}

function walkMembers(out, layer, members, owner) {
  for (const m of members) {
    if (m.kind === 'field') {
      addCandidate(out, layer, m, m.name, 'field', owner)
      walkExpr(out, layer, m.init, m.name)
    } else if (m.kind === 'method') {
      addCandidate(out, layer, m, m.name, 'method', owner)
      addParams(out, layer, m.params, m, m.name)
      walkStmt(out, layer, m.body, m.name)
    } else if (m.kind === 'ctor') {
      addParams(out, layer, m.params, m, owner)
      walkStmt(out, layer, m.body, owner)
    } else if (m.kind === 'prop') {
      addCandidate(out, layer, m, m.name, 'property', owner)
      for (const a of m.accessors) walkStmt(out, layer, a.body, m.name)
    } else if (m.kind === 'ifaceMethod') {
      addCandidate(out, layer, m, m.name, 'method', owner)
    } else if (m.kind === 'ifaceProp') {
      addCandidate(out, layer, m, m.name, 'property', owner)
    }
  }
}

function walkDecls(out, layer, decls) {
  for (const d of decls) {
    if (d.kind === 'namespace') {
      addCandidate(out, layer, d, d.name, 'namespace', '')
      walkDecls(out, layer, d.decls)
      continue
    }
    const kind = d.kind === 'class' || d.kind === 'struct' ? 'class'
      : d.kind === 'interface' ? 'interface'
        : d.kind
    addCandidate(out, layer, d, d.name, kind, '')
    if (d.kind === 'enum') {
      for (const item of d.items) addCandidate(out, layer, item, item.name, 'enumItem', d.name)
    } else if (d.kind === 'delegate') {
      addParams(out, layer, d.params, d, d.name)
    } else {
      walkMembers(out, layer, d.members, d.name)
    }
  }
}

function collectCandidates(layers) {
  const out = []
  for (const layer of layers) {
    walkDecls(out, layer, layer.unit.decls)
    for (const s of layer.unit.stmts) walkStmt(out, layer, s, '')
  }
  return out
}

function memberOnlyAt(source, line, col) {
  const text = lineText(source, line)
  let i = Math.max(0, col - 2)
  while (i >= 0 && /\s/.test(text[i] ?? '')) i--
  return text[i] === '.'
}

function chooseDefinition(cands, entry, line, name, memberOnly) {
  const usable = cands.filter((c) => c.name === name && (!memberOnly || MEMBER_KINDS.has(c.kind)))
  const own = usable.filter((c) => c.file === entry)
  const earlier = own.filter((c) => c.line <= line).sort((a, b) => b.line - a.line || b.col - a.col)
  if (earlier.length) return earlier[0]
  if (own.length) return own[0]
  return usable[0] ?? null
}

function importTarget(entry, source, line, word) {
  const before = lineText(source, line).slice(0, Math.max(0, word.start - 1))
  if (!/^\s*引\s+$/.test(before)) return null
  const target = resolveImport(entry, word.name)
  if (!existsSync(target)) return null
  return { file: target, line: 1, col: 1, name: word.name, kind: 'file', container: '' }
}

export function findDefinition(entry, source, line, col) {
  const word = wordAt(source, line, col)
  if (!word) return { found: false, name: '', definition: null }
  const imported = importTarget(entry, source, line, word)
  if (imported) return { found: true, name: word.name, word, definition: imported }
  const layers = loadLayers(entry, source)
  const cands = collectCandidates(layers)
  const definition = chooseDefinition(cands, resolve(entry), line, word.name, memberOnlyAt(source, line, word.start))
  return { found: definition !== null, name: word.name, word, definition }
}

function collectFiles(dir, out) {
  if (out.length >= 500) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= 500) return
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectFiles(full, out)
    else if (e.isFile() && e.name.endsWith('.csay')) out.push(full)
  }
}

function tokenRefs(tokens, name, out, file, source) {
  for (const t of tokens) {
    if (t.kind === 'ident' && t.text === name) {
      out.push({ file, line: t.line, col: t.col, text: lineText(source, t.line).trim() })
    } else if (t.kind === 'string' && t.segments) {
      for (const seg of t.segments) {
        if (seg.kind === 'expr') tokenRefs(seg.tokens, name, out, file, source)
      }
    }
  }
}

export function findReferences(entry, source, line, col, workspace) {
  const def = findDefinition(entry, source, line, col)
  if (!def.definition) return { ...def, refs: [], truncated: false }
  const sources = new Map()
  for (const layer of loadLayers(entry, source)) sources.set(layer.path, layer.source)
  if (workspace) {
    const found = []
    try {
      if (existsSync(workspace) && statSync(workspace).isDirectory()) collectFiles(workspace, found)
    } catch {}
    for (const file of found) {
      const abs = resolve(file)
      if (sources.has(abs)) continue
      const text = readLayer(abs)
      if (text !== null && text.length <= 1_000_000) sources.set(abs, text)
    }
  }
  const refs = []
  for (const [file, text] of sources) {
    try {
      tokenRefs(tokenize(text).tokens, def.name, refs, file, text)
    } catch {}
  }
  refs.sort((a, b) => (a.file === resolve(entry) ? -1 : b.file === resolve(entry) ? 1 : 0) || a.line - b.line || a.col - b.col)
  const seen = new Set()
  const unique = []
  for (const r of refs) {
    const key = r.file + ':' + r.line + ':' + r.col
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...r, definition: r.file === def.definition.file && r.line === def.definition.line && r.col === def.definition.col })
  }
  return { ...def, refs: unique.slice(0, 200), truncated: unique.length > 200 }
}
