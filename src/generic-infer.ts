// 从构造器实参推断省略的泛型类型实参。
// 支持类型参数直接作为构造器参数类型，也支持列表等嵌套位置，例如
// 套娃(盒子<T>) 配合 新 套娃(新 盒子(3))。

import type { CompilationUnit, Decl, Expr, Stmt, TypeRef, Member, Param } from './ast.ts'

type GenericDecl = Extract<Decl, { kind: 'class' | 'struct' }>

function named(name: string, line: number, col: number): TypeRef {
  return { kind: 'named', name, typeArgs: [], line, col }
}

function literalType(e: Expr): TypeRef | null {
  const v = e.kind === 'named' ? e.value : e
  switch (v.kind) {
    case 'int': return named('整数', e.line, e.col)
    case 'float': return named('长小数', e.line, e.col)
    case 'string': return named('文本', e.line, e.col)
    case 'bool': return named('真假', e.line, e.col)
    case 'char': return named('字符', e.line, e.col)
    default: return null
  }
}

function typeKey(t: TypeRef): string {
  if (t.kind === 'array') return `${typeKey(t.elem)}[]`
  if (t.typeArgs.length === 0) return t.name
  return `${t.name}<${t.typeArgs.map(typeKey).join(',')}>`
}

function cloneType(t: TypeRef): TypeRef {
  return t.kind === 'array' ? { ...t, elem: cloneType(t.elem) } : { ...t, typeArgs: t.typeArgs.map(cloneType) }
}

function collectTemplates(decls: Decl[], out: Map<string, GenericDecl>): void {
  for (const d of decls) {
    if (d.kind === 'namespace') collectTemplates(d.decls, out)
    else if ((d.kind === 'class' || d.kind === 'struct') && (d.typeParams?.length ?? 0) > 0) out.set(d.name, d)
  }
}

function typeOfExpr(e: Expr, templates: Map<string, GenericDecl>): TypeRef | null {
  const literal = literalType(e)
  if (literal !== null) return literal
  if (e.kind === 'paren') return typeOfExpr(e.expr, templates)
  if (e.kind === 'cast') return e.type
  if (e.kind === 'new') {
    inferNew(e, templates)
    return e.type
  }
  if (e.kind === 'array' && e.elems.length > 0) {
    const elem = typeOfExpr(e.elems[0], templates)
    return elem === null ? null : { kind: 'array', elem, line: e.line, col: e.col }
  }
  return null
}

function unify(param: TypeRef, actual: TypeRef, params: string[], inferred: Map<string, TypeRef>): boolean {
  if (param.kind === 'named' && param.typeArgs.length === 0 && params.includes(param.name)) {
    const prev = inferred.get(param.name)
    if (prev === undefined) {
      inferred.set(param.name, cloneType(actual))
      return true
    }
    return typeKey(prev) === typeKey(actual)
  }
  if (param.kind === 'array') {
    return actual.kind === 'array' && unify(param.elem, actual.elem, params, inferred)
  }
  if (actual.kind !== 'named' || param.name !== actual.name || param.typeArgs.length !== actual.typeArgs.length) return false
  for (let i = 0; i < param.typeArgs.length; i++) {
    if (!unify(param.typeArgs[i], actual.typeArgs[i], params, inferred)) return false
  }
  return true
}

function inferNew(e: Extract<Expr, { kind: 'new' }>, templates: Map<string, GenericDecl>): void {
  if (e.type.kind !== 'named' || e.type.typeArgs.length > 0) return
  const tpl = templates.get(e.type.name)
  if (tpl === undefined) return
  const params = tpl.typeParams ?? []
  if (params.length === 0) return
  const ctor = tpl.members.find((m): m is Extract<Member, { kind: 'ctor' }> => m.kind === 'ctor')
  if (ctor === undefined) return

  const inferred = new Map<string, TypeRef>()
  for (let i = 0; i < ctor.params.length && i < e.args.length; i++) {
    const p: Param = ctor.params[i]
    const actual = typeOfExpr(e.args[i], templates)
    if (actual === null) continue
    if (!unify(p.type, actual, params, inferred)) return
  }
  if (inferred.size !== params.length) return
  e.type.typeArgs = params.map((p) => cloneType(inferred.get(p)!))
}

function walkExpr(e: Expr, templates: Map<string, GenericDecl>): void {
  switch (e.kind) {
    case 'new': inferNew(e, templates); e.args.forEach((a) => walkExpr(a, templates)); return
    case 'string': e.segs.forEach((s) => { if (s.kind === 'expr') walkExpr(s.expr, templates) }); return
    case 'binary': walkExpr(e.left, templates); walkExpr(e.right, templates); return
    case 'unary': case 'postfix': walkExpr(e.operand, templates); return
    case 'assign': walkExpr(e.target, templates); walkExpr(e.value, templates); return
    case 'cond': walkExpr(e.cond, templates); walkExpr(e.then, templates); walkExpr(e.else, templates); return
    case 'call': walkExpr(e.callee, templates); e.args.forEach((a) => walkExpr(a, templates)); return
    case 'named': walkExpr(e.value, templates); return
    case 'byref': walkExpr(e.expr, templates); return
    case 'member': walkExpr(e.target, templates); return
    case 'index': walkExpr(e.target, templates); walkExpr(e.index, templates); return
    case 'cast': walkExpr(e.expr, templates); return
    case 'array': e.elems.forEach((a) => walkExpr(a, templates)); return
    case 'paren': walkExpr(e.expr, templates); return
    case 'lambda':
      if (e.body.kind === 'block') walkStmt(e.body, templates)
      else walkExpr(e.body, templates)
      return
    default: return
  }
}

function walkStmt(s: Stmt, templates: Map<string, GenericDecl>): void {
  switch (s.kind) {
    case 'block': s.stmts.forEach((x) => walkStmt(x, templates)); return
    case 'var':
      if (s.init !== null) {
        walkExpr(s.init, templates)
        if (s.type.kind === 'named' && s.type.typeArgs.length === 0 &&
            s.init.kind === 'new' && s.init.type.kind === 'named' &&
            s.init.type.name === s.type.name && s.init.type.typeArgs.length > 0) {
          s.type.typeArgs = s.init.type.typeArgs
        }
      }
      return
    case 'expr': walkExpr(s.expr, templates); return
    case 'if': walkExpr(s.cond, templates); walkStmt(s.then, templates); if (s.els !== null) walkStmt(s.els, templates); return
    case 'while': walkExpr(s.cond, templates); walkStmt(s.body, templates); return
    case 'dowhile': walkStmt(s.body, templates); walkExpr(s.cond, templates); return
    case 'for':
      if (s.init !== null) walkStmt(s.init, templates)
      if (s.cond !== null) walkExpr(s.cond, templates)
      s.step.forEach((x) => walkExpr(x, templates))
      walkStmt(s.body, templates)
      return
    case 'foreach': walkExpr(s.iter, templates); walkStmt(s.body, templates); return
    case 'switch':
      walkExpr(s.subject, templates)
      for (const c of s.clauses) {
        if (c.label !== null) walkExpr(c.label, templates)
        c.stmts.forEach((x) => walkStmt(x, templates))
      }
      return
    case 'return': if (s.value !== null) walkExpr(s.value, templates); return
    case 'throw': walkExpr(s.value, templates); return
    case 'try':
      walkStmt(s.body, templates)
      for (const c of s.catches) walkStmt(c.body, templates)
      if (s.fin !== null) walkStmt(s.fin, templates)
      return
    case 'region': walkStmt(s.body, templates); return
    case 'using': walkExpr(s.target, templates); walkStmt(s.body, templates); return
    case 'localFunc': for (const p of s.params) if (p.def !== null) walkExpr(p.def, templates); walkStmt(s.body, templates); return
    default: return
  }
}

function walkMember(m: Member, templates: Map<string, GenericDecl>): void {
  switch (m.kind) {
    case 'field': if (m.init !== null) walkExpr(m.init, templates); return
    case 'method': for (const p of m.params) if (p.def !== null) walkExpr(p.def, templates); if (m.body !== null) walkStmt(m.body, templates); return
    case 'ctor': for (const p of m.params) if (p.def !== null) walkExpr(p.def, templates); if (m.baseArgs !== null) m.baseArgs.forEach((a) => walkExpr(a, templates)); walkStmt(m.body, templates); return
    case 'prop': for (const a of m.accessors) walkStmt(a.body, templates); return
    default: return
  }
}

export function inferGenericArgs(unit: CompilationUnit): void {
  const templates = new Map<string, GenericDecl>()
  collectTemplates(unit.decls, templates)
  if (templates.size === 0) return
  for (const d of unit.decls) {
    if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') {
      for (const m of d.members) walkMember(m, templates)
    } else if (d.kind === 'namespace') {
      // 命名空间里的声明已经由 collectTemplates 收集，这里只走成员。
      for (const x of d.decls) {
        if (x.kind === 'class' || x.kind === 'struct' || x.kind === 'interface') {
          for (const m of x.members) walkMember(m, templates)
        }
      }
    }
  }
  unit.stmts.forEach((s) => walkStmt(s, templates))
}
