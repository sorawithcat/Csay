// 自定义泛型：编译期单态化。只支持类型参数写在类/结构/接口上，使用时显式给类型实参。
// 例如 类 盒子<T> 与 盒子<整数> 会生成一个独立的 盒子_整数 类型。

import type {
  CompilationUnit, Decl, TypeRef, Expr, Stmt, Member, Accessor, Param,
} from './ast.ts'

type GenericDecl = Extract<Decl, { kind: 'class' | 'struct' | 'interface' }>
type TypeEnv = Map<string, TypeRef>

function named(name: string, line: number, col: number): TypeRef {
  return { kind: 'named', name, typeArgs: [], line, col }
}

function typeKey(t: TypeRef): string {
  if (t.kind === 'array') return `${typeKey(t.elem)}[]`
  if (t.typeArgs.length === 0) return t.name
  return `${t.name}<${t.typeArgs.map(typeKey).join(',')}>`
}

function mangle(t: TypeRef): string {
  if (t.kind === 'array') return `${mangle(t.elem)}_数组`
  const base = t.name.replace(/\./g, '_')
  if (t.typeArgs.length === 0) return base
  return `${base}_${t.typeArgs.map(mangle).join('_')}`
}

function cloneType(t: TypeRef): TypeRef {
  return t.kind === 'array'
    ? { ...t, elem: cloneType(t.elem) }
    : { ...t, typeArgs: t.typeArgs.map(cloneType) }
}

export function expandGenerics(unit: CompilationUnit): CompilationUnit {
  const templates = new Map<string, GenericDecl>()
  const collect = (decls: Decl[]): void => {
    for (const d of decls) {
      if (d.kind === 'namespace') collect(d.decls)
      else if ((d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') && (d.typeParams?.length ?? 0) > 0) {
        templates.set(d.name, d)
      }
    }
  }
  collect(unit.decls)
  if (templates.size === 0) return unit

  const made = new Map<string, GenericDecl>()
  const order: GenericDecl[] = []
  const usedNames = new Set<string>()
  for (const d of unit.decls) {
    if (d.kind !== 'namespace' && d.typeParams === undefined) usedNames.add(d.name)
  }

  function rewriteType(t: TypeRef, env: TypeEnv = new Map()): TypeRef {
    if (t.kind === 'array') return { ...t, elem: rewriteType(t.elem, env) }
    const args = t.typeArgs.map((a) => rewriteType(a, env))
    if (env.has(t.name) && args.length === 0) return rewriteType(env.get(t.name)!, new Map())
    const tpl = templates.get(t.name)
    if (tpl !== undefined) {
      if (args.length !== (tpl.typeParams?.length ?? 0)) {
        throw new Error(`泛型「${t.name}」需要 ${tpl.typeParams?.length ?? 0} 个类型参数`)
      }
      const key = `${t.name}<${args.map(typeKey).join(',')}>`
      let decl = made.get(key)
      if (decl === undefined) {
        let name = `${t.name}_${args.map(mangle).join('_')}`
        let n = 2
        while (usedNames.has(name)) name = `${t.name}_${args.map(mangle).join('_')}_${n++}`
        usedNames.add(name)
        decl = structuredClone(tpl) as GenericDecl
        made.set(key, decl)
        fillDecl(decl, tpl, args, name)
        order.push(decl)
      }
      return named(decl.name, t.line, t.col)
    }
    return { ...t, typeArgs: args }
  }

  function fillDecl(decl: GenericDecl, tpl: GenericDecl, args: TypeRef[], name: string): void {
    const env: TypeEnv = new Map()
    ;(tpl.typeParams ?? []).forEach((p, i) => env.set(p, args[i]))
    env.set(tpl.name, named(name, tpl.line, tpl.col))
    decl.name = name
    decl.typeParams = []
    decl.bases = decl.bases.map((b) => rewriteType(b, env))
    for (const m of decl.members) {
      if (m.kind === 'ctor' && m.name === tpl.name) m.name = name
      rewriteMember(m, env)
    }
  }

  function rewriteTypeRefsInStmt(s: Stmt, env: TypeEnv): void {
    switch (s.kind) {
      case 'block': s.stmts.forEach((x) => rewriteTypeRefsInStmt(x, env)); return
      case 'var': s.type = rewriteType(s.type, env); if (s.init !== null) rewriteExpr(s.init, env); return
      case 'expr': rewriteExpr(s.expr, env); return
      case 'if': rewriteExpr(s.cond, env); rewriteTypeRefsInStmt(s.then, env); if (s.els !== null) rewriteTypeRefsInStmt(s.els, env); return
      case 'while': rewriteExpr(s.cond, env); rewriteTypeRefsInStmt(s.body, env); return
      case 'dowhile': rewriteTypeRefsInStmt(s.body, env); rewriteExpr(s.cond, env); return
      case 'for':
        if (s.init !== null) rewriteTypeRefsInStmt(s.init, env)
        if (s.cond !== null) rewriteExpr(s.cond, env)
        s.step.forEach((x) => rewriteExpr(x, env))
        rewriteTypeRefsInStmt(s.body, env)
        return
      case 'foreach':
        if (s.elemType !== null) s.elemType = rewriteType(s.elemType, env)
        rewriteExpr(s.iter, env); rewriteTypeRefsInStmt(s.body, env); return
      case 'switch':
        rewriteExpr(s.subject, env)
        for (const c of s.clauses) {
          if (c.label !== null) rewriteExpr(c.label, env)
          c.stmts.forEach((x) => rewriteTypeRefsInStmt(x, env))
        }
        return
      case 'return': if (s.value !== null) rewriteExpr(s.value, env); return
      case 'throw': rewriteExpr(s.value, env); return
      case 'try':
        rewriteTypeRefsInStmt(s.body, env)
        for (const c of s.catches) {
          c.type = rewriteType(c.type, env)
          rewriteTypeRefsInStmt(c.body, env)
        }
        if (s.fin !== null) rewriteTypeRefsInStmt(s.fin, env)
        return
      case 'region': rewriteTypeRefsInStmt(s.body, env); return
      case 'using': rewriteExpr(s.target, env); rewriteTypeRefsInStmt(s.body, env); return
      case 'localFunc':
        s.ret = rewriteType(s.ret, env)
        for (const p of s.params) p.type = rewriteType(p.type, env)
        rewriteTypeRefsInStmt(s.body, env)
        return
      default: return
    }
  }

  function rewriteExpr(e: Expr, env: TypeEnv): void {
    switch (e.kind) {
      case 'string':
        for (const seg of e.segs) if (seg.kind === 'expr') rewriteExpr(seg.expr, env)
        return
      case 'binary': rewriteExpr(e.left, env); rewriteExpr(e.right, env); return
      case 'unary': case 'postfix': rewriteExpr(e.operand, env); return
      case 'assign': rewriteExpr(e.target, env); rewriteExpr(e.value, env); return
      case 'cond': rewriteExpr(e.cond, env); rewriteExpr(e.then, env); rewriteExpr(e.else, env); return
      case 'call': rewriteExpr(e.callee, env); e.args.forEach((x) => rewriteExpr(x, env)); return
      case 'member': rewriteExpr(e.target, env); return
      case 'index': rewriteExpr(e.target, env); rewriteExpr(e.index, env); return
      case 'new':
        e.type = rewriteType(e.type, env)
        e.args.forEach((x) => rewriteExpr(x, env))
        return
      case 'array': e.elems.forEach((x) => rewriteExpr(x, env)); return
      case 'paren': rewriteExpr(e.expr, env); return
      case 'lambda':
        for (const p of e.params) p.type = rewriteType(p.type, env)
        if (e.body.kind === 'block') rewriteTypeRefsInStmt(e.body, env)
        else rewriteExpr(e.body, env)
        return
      default: return
    }
  }

  function rewriteMember(m: Member, env: TypeEnv): void {
    switch (m.kind) {
      case 'field':
        m.type = rewriteType(m.type, env)
        if (m.init !== null) rewriteExpr(m.init, env)
        return
      case 'method':
        m.ret = rewriteType(m.ret, env)
        for (const p of m.params) p.type = rewriteType(p.type, env)
        if (m.body !== null) rewriteTypeRefsInStmt(m.body, env)
        return
      case 'ctor':
        for (const p of m.params) p.type = rewriteType(p.type, env)
        if (m.baseArgs !== null) m.baseArgs.forEach((x) => rewriteExpr(x, env))
        rewriteTypeRefsInStmt(m.body, env)
        return
      case 'prop':
        m.type = rewriteType(m.type, env)
        for (const a of m.accessors) rewriteTypeRefsInStmt(a.body, env)
        return
      case 'ifaceMethod':
        m.ret = rewriteType(m.ret, env)
        for (const p of m.params) p.type = rewriteType(p.type, env)
        return
      case 'ifaceProp': m.type = rewriteType(m.type, env); return
    }
  }

  function rewriteDecl(d: Decl): Decl | null {
    if (d.kind === 'namespace') {
      d.decls = d.decls.map(rewriteDecl).filter((x): x is Decl => x !== null)
      return d
    }
    if ((d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') && (d.typeParams?.length ?? 0) > 0) {
      return null
    }
    switch (d.kind) {
      case 'class': case 'struct': case 'interface':
        d.bases = d.bases.map((b) => rewriteType(b))
        for (const m of d.members) rewriteMember(m, new Map())
        return d
      case 'enum':
        for (const it of d.items) if (it.value !== null) rewriteExpr(it.value, new Map())
        return d
    }
  }

  unit.stmts.forEach((s) => rewriteTypeRefsInStmt(s, new Map()))
  unit.decls = unit.decls.map(rewriteDecl).filter((x): x is Decl => x !== null)
  for (const d of order) unit.decls.push(d)
  return unit
}
