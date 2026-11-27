// 轻量语义检查：找出「完全不存在」的名字引用。
// 不做类型分析，只查作用域里有没有这个名字——已能把拼错变量名、
// 调用不存在的函数这类问题在编辑期报出来。
import type { CompilationUnit, Decl, Expr, Stmt, Member, Param } from './ast.ts'
import type { Diagnostic } from './token.ts'
import { BUILTIN_NAMES } from './stdlib.ts'

interface Ctx {
  diags: Diagnostic[]
  reported: Set<string>
}

function err(ctx: Ctx, name: string, line: number, col: number): void {
  const key = name + ':' + line + ':' + col
  if (ctx.reported.has(key)) return
  ctx.reported.add(key)
  ctx.diags.push({
    severity: 'error', line, col,
    message: `未定义的名字「${name}」`,
    hint: '检查拼写；如果是变量，先声明它；如果是函数，确认它在当前文件或 引 进来的文件里',
  })
}

/**
 * 收集一段语句里声明的所有名字（函数级并集，不做块级区分）。
 */
export function collectNames(stmts: Stmt[], scope: Set<string>): void {
  for (const s of stmts) {
    switch (s.kind) {
      case 'var': scope.add(s.name); break
      case 'localFunc': scope.add(s.name); break
      case 'foreach': if (s.name) scope.add(s.name); break
      case 'block': collectNames(s.stmts, scope); break
      case 'if':
        collectNames([s.then], scope)
        if (s.els !== null) collectNames([s.els], scope)
        break
      case 'while': case 'dowhile': case 'region': collectNames([s.body], scope); break
      case 'using': collectNames([s.body], scope); break
      case 'for': collectNames([s.body], scope); break
      case 'try':
        collectNames([s.body], scope)
        for (const c of s.catches) {
          scope.add(c.name)
          collectNames([c.body], scope)
        }
        if (s.fin !== null) collectNames([s.fin], scope)
        break
      case 'switch':
        for (const c of s.clauses) collectNames(c.stmts, scope)
        break
      default: break
    }
  }
}

function checkExpr(e: Expr, scope: Set<string>, ctx: Ctx): void {
  switch (e.kind) {
    case 'name':
      if (!scope.has(e.name) && !BUILTIN_NAMES.has(e.name)) err(ctx, e.name, e.line, e.col)
      return
    case 'binary':
      checkExpr(e.left, scope, ctx); checkExpr(e.right, scope, ctx); return
    case 'unary': case 'postfix':
      checkExpr(e.operand, scope, ctx); return
    case 'assign':
      checkExpr(e.target, scope, ctx); checkExpr(e.value, scope, ctx); return
    case 'cond':
      checkExpr(e.cond, scope, ctx); checkExpr(e.then, scope, ctx); checkExpr(e.else, scope, ctx); return
    case 'call':
      if (e.callee.kind === 'name') {
        if (!scope.has(e.callee.name) && !BUILTIN_NAMES.has(e.callee.name)) {
          err(ctx, e.callee.name, e.callee.line, e.callee.col)
        }
      } else {
        checkExpr(e.callee, scope, ctx)
      }
      for (const a of e.args) checkExpr(a, scope, ctx)
      return
    case 'named': checkExpr(e.value, scope, ctx); return
    case 'byref': checkExpr(e.expr, scope, ctx); return
    case 'member':
      // 成员名不是作用域引用，只检查接收者
      checkExpr(e.target, scope, ctx); return
    case 'index':
      checkExpr(e.target, scope, ctx); checkExpr(e.index, scope, ctx); return
    case 'new':
      for (const a of e.args) checkExpr(a, scope, ctx)
      return
    case 'array':
      for (const el of e.elems) checkExpr(el, scope, ctx)
      return
    case 'lambda': {
      const inner = new Set(scope)
      for (const p of e.params) inner.add(p.name)
      if (e.body.kind === 'block') {
        collectNames(e.body.stmts, inner)
        checkStmts(e.body.stmts, inner, ctx)
      } else {
        checkExpr(e.body, inner, ctx)
      }
      return
    }
    case 'paren':
      checkExpr(e.expr, scope, ctx); return
    case 'string':
      for (const seg of e.segs) {
        if (seg.kind === 'expr') checkExpr(seg.expr, scope, ctx)
      }
      return
    default: return
  }
}

function checkStmts(stmts: Stmt[], scope: Set<string>, ctx: Ctx): void {
  for (const s of stmts) checkStmt(s, scope, ctx)
}

function checkStmt(s: Stmt, scope: Set<string>, ctx: Ctx): void {
  switch (s.kind) {
    case 'var':
      if (s.init !== null) checkExpr(s.init, scope, ctx)
      scope.add(s.name)
      return
    case 'expr': checkExpr(s.expr, scope, ctx); return
    case 'return':
      if (s.value !== null) checkExpr(s.value, scope, ctx)
      return
    case 'if':
      checkExpr(s.cond, scope, ctx); checkStmt(s.then, scope, ctx)
      if (s.els !== null) checkStmt(s.els, scope, ctx)
      return
    case 'while': checkExpr(s.cond, scope, ctx); checkStmt(s.body, scope, ctx); return
    case 'dowhile': checkStmt(s.body, scope, ctx); checkExpr(s.cond, scope, ctx); return
    case 'for':
      if (s.init !== null) checkStmt(s.init, scope, ctx)
      if (s.cond !== null) checkExpr(s.cond, scope, ctx)
      for (const st of s.step) checkExpr(st, scope, ctx)
      checkStmt(s.body, scope, ctx)
      return
    case 'foreach':
      checkExpr(s.iter, scope, ctx)
      scope.add(s.name)
      checkStmt(s.body, scope, ctx)
      return
    case 'switch': {
      checkExpr(s.subject, scope, ctx)
      for (const c of s.clauses) {
        if (c.label !== null) checkExpr(c.label, scope, ctx)
        checkStmts(c.stmts, scope, ctx)
      }
      return
    }
    case 'throw': checkExpr(s.value, scope, ctx); return
    case 'try':
      checkStmt(s.body, scope, ctx)
      for (const c of s.catches) {
        scope.add(c.name)
        checkStmt(c.body, scope, ctx)
      }
      if (s.fin !== null) checkStmt(s.fin, scope, ctx)
      return
    case 'block': checkStmts(s.stmts, scope, ctx); return
    case 'region': checkStmt(s.body, scope, ctx); return
    case 'using': checkExpr(s.target, scope, ctx); checkStmt(s.body, scope, ctx); return
    case 'localFunc':
      scope.add(s.name)
      for (const p of s.params) scope.add(p.name)
      if (s.body.kind === 'block') collectNames(s.body.stmts, scope)
      checkStmt(s.body, scope, ctx)
      return
    default: return
  }
}

function checkMember(m: Member, outerScope: Set<string>, ctx: Ctx): void {
  const locals = new Set(outerScope)
  switch (m.kind) {
    case 'field':
      if (m.init !== null) checkExpr(m.init, locals, ctx)
      locals.add(m.name)
      return
    case 'method': case 'ctor': {
      for (const p of m.params) locals.add(p.name)
      if (m.body === null) return
      if (m.body.kind === 'block') collectNames(m.body.stmts, locals)
      checkStmt(m.body, locals, ctx)
      return
    }
    case 'prop':
      for (const a of m.accessors) checkStmt(a.body, locals, ctx)
      locals.add(m.name)
      return
    default: return
  }
}

function checkDecl(d: Decl, ctx: Ctx, classMembers: Map<string, Set<string>>, classBases: Map<string, string>): void {
  switch (d.kind) {
    case 'class': case 'struct': {
      // 类成员互相可见：先把所有成员名（含继承链）收集起来，再逐个检查
      const members = new Set<string>()
      const addBase = (name: string): void => {
        for (const m of classMembers.get(name) ?? []) members.add(m)
        const base = classBases.get(name)
        if (base !== undefined) addBase(base)
      }
      for (const b of d.bases) if (b.kind === 'named') addBase(b.name)
      for (const m of d.members) {
        if (m.kind === 'field' || m.kind === 'prop' || m.kind === 'method' || m.kind === 'ctor') {
          members.add(m.name)
        }
      }
      for (const m of d.members) checkMember(m, members, ctx)
      return
    }
    case 'interface':
      // 接口成员没有方法体，无需检查
      return
    case 'enum':
      for (const item of d.items) {
        if (item.value !== null) checkExpr(item.value, new Set<string>(), ctx)
      }
      return
    case 'namespace':
      for (const inner of d.decls) checkDecl(inner, ctx, classMembers, classBases)
      return
    default: return
  }
}

export function checkNames(unit: CompilationUnit, extraNames: Iterable<string> = []): Diagnostic[] {
  const ctx: Ctx = { diags: [], reported: new Set() }
  const globals = new Set<string>(extraNames)

  const addGlobals = (decls: Decl[]): void => {
    for (const d of decls) {
      if (d.kind === 'namespace') {
        for (const part of d.name.split('.')) globals.add(part)
        addGlobals(d.decls)
      } else if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface' || d.kind === 'enum' || d.kind === 'delegate') globals.add(d.name)
    }
  }
  addGlobals(unit.decls)

  const topScope = new Set(globals)
  collectNames(unit.stmts, topScope)
  checkStmts(unit.stmts, topScope, ctx)

  const classMembers = new Map<string, Set<string>>()
  const classBases = new Map<string, string>()
  const walk = (decls: Decl[]): void => {
    for (const d of decls) {
      if (d.kind === 'namespace') walk(d.decls)
      else if (d.kind === 'class' || d.kind === 'struct') {
        classMembers.set(d.name, new Set(d.members.flatMap((m) =>
          m.kind === 'field' || m.kind === 'prop' || m.kind === 'method' || m.kind === 'ctor' ? [m.name] : [])))
        const base = d.bases.find((b) => b.kind === 'named')
        if (base !== undefined && base.kind === 'named') classBases.set(d.name, base.name)
      }
    }
  }
  walk(unit.decls)
  for (const d of unit.decls) checkDecl(d, ctx, classMembers, classBases)

  return ctx.diags
}
