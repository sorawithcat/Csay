// 粗粒度的区域逃逸摘要：判断一个函数/方法会不会把某个参数保存到字段、
// 容器、返回值或未知调用里。只用于抑制明显安全的区域调用警告，不追求精确。

import type { CompilationUnit, Decl, Expr, Member, Stmt } from './ast.ts'
import { BUILTIN_NAMES } from './stdlib.ts'

interface FnInfo {
  name: string
  params: string[]
  body: Stmt
}

type AliasMap = Map<string, Set<number>>
type Effects = Map<string, Set<number>>

function collectFuncs(decls: Decl[], stmts: Stmt[], out: FnInfo[]): void {
  for (const d of decls) {
    if (d.kind === 'namespace') collectFuncs(d.decls, [], out)
    else if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') {
      for (const m of d.members) {
        if (m.kind === 'method' && m.body !== null) out.push({ name: m.name, params: m.params.map((p) => p.name), body: m.body })
        else if (m.kind === 'ctor' && m.body !== null) out.push({ name: `构造:${d.name}`, params: m.params.map((p) => p.name), body: m.body })
      }
    }
  }
  for (const s of stmts) {
    if (s.kind === 'localFunc') {
      out.push({ name: s.name, params: s.params.map((p) => p.name), body: s.body })
      collectFuncs([], [s.body], out)
    } else {
      collectLocalFuncs(s, out)
    }
  }
}

function collectLocalFuncs(s: Stmt, out: FnInfo[]): void {
  switch (s.kind) {
    case 'block': s.stmts.forEach((x) => collectLocalFuncs(x, out)); return
    case 'if': collectLocalFuncs(s.then, out); if (s.els !== null) collectLocalFuncs(s.els, out); return
    case 'while': collectLocalFuncs(s.body, out); return
    case 'dowhile': collectLocalFuncs(s.body, out); return
    case 'for': collectLocalFuncs(s.body, out); return
    case 'foreach': collectLocalFuncs(s.body, out); return
    case 'switch': for (const c of s.clauses) c.stmts.forEach((x) => collectLocalFuncs(x, out)); return
    case 'try': collectLocalFuncs(s.body, out); for (const c of s.catches) collectLocalFuncs(c.body, out); if (s.fin !== null) collectLocalFuncs(s.fin, out); return
    case 'region': collectLocalFuncs(s.body, out); return
    case 'using': collectLocalFuncs(s.body, out); return
    case 'localFunc': out.push({ name: s.name, params: s.params.map((p) => p.name), body: s.body }); collectLocalFuncs(s.body, out); return
    default: return
  }
}

function emptySet(): Set<number> { return new Set() }

function mergeInto(dst: AliasMap, src: AliasMap): void {
  for (const [k, v] of src) {
    const cur = dst.get(k)
    if (cur === undefined) dst.set(k, new Set(v))
    else for (const n of v) cur.add(n)
  }
}

function aliasesOf(e: Expr, aliases: AliasMap): Set<number> {
  switch (e.kind) {
    case 'name': return aliases.get(e.name) ?? emptySet()
    case 'paren': case 'cast': return aliasesOf(e.expr, aliases)
    default: return emptySet()
  }
}

function mark(out: Set<number>, s: Set<number>): void {
  for (const n of s) out.add(n)
}

function analyze(fn: FnInfo, summaries: Effects, known: Set<string>): Set<number> {
  const escapes = new Set<number>()
  const aliases: AliasMap = new Map()
  fn.params.forEach((p, i) => aliases.set(p, new Set([i])))

  function walkExpr(e: Expr): void {
    switch (e.kind) {
      case 'string': for (const s of e.segs) if (s.kind === 'expr') walkExpr(s.expr); return
      case 'binary': walkExpr(e.left); walkExpr(e.right); return
      case 'unary': case 'postfix': walkExpr(e.operand); return
      case 'assign': {
        walkExpr(e.value)
        const a = aliasesOf(e.value, aliases)
        if (e.target.kind === 'name') {
          aliases.set(e.target.name, new Set(a))
        } else {
          mark(escapes, a)
          if (e.target.kind === 'member') walkExpr(e.target.target)
          else if (e.target.kind === 'index') { walkExpr(e.target.target); walkExpr(e.target.index) }
        }
        return
      }
      case 'cond': walkExpr(e.cond); walkExpr(e.then); walkExpr(e.else); return
      case 'call': {
        e.args.forEach(walkExpr)
        const name = e.callee.kind === 'name' ? e.callee.name : e.callee.kind === 'member' ? e.callee.name : null
        if (name === null) return
        const effects = summaries.get(name)
        e.args.forEach((arg, i) => {
          const a = aliasesOf(arg, aliases)
          if (effects !== undefined) {
            if (effects.has(i)) mark(escapes, a)
          } else if (!known.has(name) && !BUILTIN_NAMES.has(name)) {
            mark(escapes, a)
          }
        })
        return
      }
      case 'named': walkExpr(e.value); return
      case 'byref': walkExpr(e.expr); return
      case 'member': walkExpr(e.target); return
      case 'index': walkExpr(e.target); walkExpr(e.index); return
      case 'array': e.elems.forEach(walkExpr); return
      case 'paren': walkExpr(e.expr); return
      case 'lambda': if (e.body.kind === 'block') walkStmt(e.body); else walkExpr(e.body); return
      default: return
    }
  }

  function walkStmt(s: Stmt): void {
    switch (s.kind) {
      case 'block': s.stmts.forEach(walkStmt); return
      case 'var': if (s.init !== null) { walkExpr(s.init); aliases.set(s.name, new Set(aliasesOf(s.init, aliases))) } else aliases.delete(s.name); return
      case 'expr': walkExpr(s.expr); return
      case 'if': {
        walkExpr(s.cond)
        const before = new Map(aliases)
        walkStmt(s.then)
        const thenMap = new Map(aliases)
        aliases.clear(); mergeInto(aliases, before)
        if (s.els !== null) walkStmt(s.els)
        mergeInto(aliases, thenMap)
        return
      }
      case 'while': walkExpr(s.cond); { const before = new Map(aliases); walkStmt(s.body); mergeInto(aliases, before) } return
      case 'dowhile': { const before = new Map(aliases); walkStmt(s.body); walkExpr(s.cond); mergeInto(aliases, before) } return
      case 'for': {
        if (s.init !== null) walkStmt(s.init)
        if (s.cond !== null) walkExpr(s.cond)
        s.step.forEach(walkExpr)
        const before = new Map(aliases); walkStmt(s.body); mergeInto(aliases, before)
        return
      }
      case 'foreach': {
        walkExpr(s.iter)
        const before = new Map(aliases); aliases.delete(s.name); walkStmt(s.body); mergeInto(aliases, before)
        return
      }
      case 'switch': {
        walkExpr(s.subject)
        const before = new Map(aliases)
        const merged = new Map<string, Set<number>>()
        for (const c of s.clauses) {
          if (c.label !== null) walkExpr(c.label)
          aliases.clear(); mergeInto(aliases, before)
          c.stmts.forEach(walkStmt)
          mergeInto(merged, aliases)
        }
        aliases.clear(); mergeInto(aliases, before); mergeInto(aliases, merged)
        return
      }
      case 'return': if (s.value !== null) { walkExpr(s.value); mark(escapes, aliasesOf(s.value, aliases)) } return
      case 'throw': walkExpr(s.value); return
      case 'try': {
        const before = new Map(aliases)
        const merged = new Map<string, Set<number>>()
        walkStmt(s.body); mergeInto(merged, aliases)
        for (const c of s.catches) { aliases.clear(); mergeInto(aliases, before); aliases.delete(c.name); walkStmt(c.body); mergeInto(merged, aliases) }
        if (s.fin !== null) { aliases.clear(); mergeInto(aliases, before); walkStmt(s.fin); mergeInto(merged, aliases) }
        aliases.clear(); mergeInto(aliases, before); mergeInto(aliases, merged)
        return
      }
      case 'region': walkStmt(s.body); return
      case 'using': walkExpr(s.target); walkStmt(s.body); return
      case 'localFunc': return
      default: return
    }
  }

  walkStmt(fn.body)
  return escapes
}

export function collectRegionEffects(unit: CompilationUnit): Effects {
  const funcs: FnInfo[] = []
  collectFuncs(unit.decls, unit.stmts, funcs)
  const known = new Set(funcs.map((f) => f.name))
  const summaries: Effects = new Map()
  for (let pass = 0; pass < funcs.length + 2; pass++) {
    let changed = false
    for (const f of funcs) {
      const esc = analyze(f, summaries, known)
      let cur = summaries.get(f.name)
      if (cur === undefined) { cur = new Set(); summaries.set(f.name, cur) }
      for (const n of esc) if (!cur.has(n)) { cur.add(n); changed = true }
    }
    if (!changed) break
  }
  return summaries
}
