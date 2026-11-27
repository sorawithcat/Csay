// 轻量类型检查：只做能确定的成员、方法和参数数量检查。
// 名称是否存在由 checker.ts 负责；这里不重复报未定义名字。
import type { CompilationUnit, Decl, Expr, Stmt, Member, Param, TypeRef } from './ast.ts'
import { arrangeArguments } from './arguments.ts'
import { BUILTIN_NAMES } from './stdlib.ts'
import { collectRegionEffects } from './region-effects.ts'
import type { Diagnostic } from './token.ts'

type Ty = string

interface MemberSig {
  kind: 'field' | 'prop' | 'method'
  type: Ty
  params: Ty[]
  minArgs: number
  maxArgs: number
  isStatic: boolean
  isConst?: boolean
  paramNames?: string[]
  defaults?: (Expr | null)[]
  modes?: ('ref' | 'out' | null)[]
}

interface Shape {
  kind: 'class' | 'struct' | 'interface' | 'enum' | 'delegate'
  name: string
  bases: string[]
  fields: Map<string, MemberSig>
  methods: Map<string, MemberSig>
  /** 同名方法的重载列表；methods 保存第一个以便成员访问。 */
  methodOverloads: Map<string, MemberSig[]>
  props: Map<string, MemberSig>
  enumItems: Set<string>
  /** 仅委托：返回类型和参数类型 */
  delegateRet?: Ty
  delegateParams?: Ty[]
  delegateParamNames?: string[]
  /** 仅类/结构：构造器参数 */
  ctor?: { params: Ty[]; modes?: ('ref' | 'out' | null)[]; minArgs: number; maxArgs: number; paramNames?: string[]; defaults?: (Expr | null)[] }
  typeParams?: string[]
  typeConstraints?: Record<string, TypeRef[]>
}

interface FnSig {
  params: Ty[]
  paramNames: string[]
  defaults: (Expr | null)[]
  modes: ('ref' | 'out' | null)[]
  minArgs: number
  maxArgs: number
  ret: Ty
}

interface Ctx {
  diags: Diagnostic[]
  reported: Set<string>
  shapes: Map<string, Shape>
  funcs: Map<string, FnSig[]>
  thisType: Ty | null
  retType: Ty | null
  /** 当前控制流中确定为 空 的局部变量。 */
  nullVars: Set<string>
  /** 当前方法内确定为 空 的 自.字段。 */
  nullFields: Set<string>
  /** 当前文件顶层函数是否可能返回 空。 */
  nullReturns: Map<string, boolean>
  /** 顶层函数被调用时传入 空 的参数下标。 */
  nullParams: Map<string, Set<number>>
  /** 当前 区域 块内声明的引用变量。 */
  regionDepth: number
  regionVars: Set<string>
  regionEffects: Map<string, Set<number>>
  /** 当前 Lambda 块体的返回值类型；为 null 表示不在 Lambda 块体内。 */
  lambdaReturn: { type: Ty | null; bareAt?: { line: number; col: number } } | null
  /** 循环/切换的跳出状态，用于合并循环结束后的空值状态。 */
  breakStack: { loop: boolean; states: Set<string>[] }[]
}

function err(ctx: Ctx, message: string, line: number, col: number, hint?: string): void {
  const key = line + ':' + col + ':' + message
  if (ctx.reported.has(key)) return
  ctx.reported.add(key)
  ctx.diags.push({ severity: 'error', line, col, message, hint })
}

function warn(ctx: Ctx, message: string, line: number, col: number, hint?: string): void {
  const key = 'warning:' + line + ':' + col + ':' + message
  if (ctx.reported.has(key)) return
  ctx.reported.add(key)
  ctx.diags.push({ severity: 'warning', line, col, message, hint })
}

function isRegionValue(e: Expr, ctx: Ctx): boolean {
  if (e.kind === 'new' || e.kind === 'array') return true
  if (e.kind === 'name') return ctx.regionVars.has(e.name)
  if (e.kind === 'paren') return isRegionValue(e.expr, ctx)
  if (e.kind === 'cast') return isRegionValue(e.expr, ctx)
  return false
}

function isRegionType(t: Ty | undefined): boolean {
  return t !== undefined && (t.startsWith('类:') || t.startsWith('接口:') || t.startsWith('列表:') || t.startsWith('表:') || t.startsWith('委托:') || t.endsWith('[]'))
}

function restoreRegionVars(ctx: Ctx, before: Set<string>): void {
  for (const n of [...ctx.regionVars]) if (!before.has(n)) ctx.regionVars.delete(n)
}

function unwrapNamed(e: Expr): Expr {
  return e.kind === 'named' ? e.value : e
}

function addLambdaRefs(e: Expr, bound: Set<string>, out: Set<string>): void {
  switch (e.kind) {
    case 'name':
      if (!bound.has(e.name)) out.add(e.name)
      return
    case 'string':
      for (const seg of e.segs) if (seg.kind === 'expr') addLambdaRefs(seg.expr, bound, out)
      return
    case 'binary': addLambdaRefs(e.left, bound, out); addLambdaRefs(e.right, bound, out); return
    case 'unary': case 'postfix': addLambdaRefs(e.operand, bound, out); return
    case 'cast': case 'paren': addLambdaRefs(e.expr, bound, out); return
    case 'assign': addLambdaRefs(e.target, bound, out); addLambdaRefs(e.value, bound, out); return
    case 'cond': addLambdaRefs(e.cond, bound, out); addLambdaRefs(e.then, bound, out); addLambdaRefs(e.else, bound, out); return
    case 'call': addLambdaRefs(e.callee, bound, out); for (const a of e.args) addLambdaRefs(a, bound, out); return
    case 'named': addLambdaRefs(e.value, bound, out); return
    case 'byref': addLambdaRefs(e.expr, bound, out); return
    case 'member': addLambdaRefs(e.target, bound, out); return
    case 'index': addLambdaRefs(e.target, bound, out); addLambdaRefs(e.index, bound, out); return
    case 'new': for (const a of e.args) addLambdaRefs(a, bound, out); return
    case 'array': for (const a of e.elems) addLambdaRefs(a, bound, out); return
    case 'lambda': {
      const inner = new Set(bound)
      for (const p of e.params) inner.add(p.name)
      if (e.body.kind === 'block') addLambdaStmtRefs(e.body, inner, out)
      else addLambdaRefs(e.body, inner, out)
      return
    }
    default: return
  }
}

function addLambdaStmtRefs(s: Stmt, bound: Set<string>, out: Set<string>): void {
  switch (s.kind) {
    case 'block': for (const x of s.stmts) addLambdaStmtRefs(x, bound, out); return
    case 'var':
      if (s.init !== null) addLambdaRefs(s.init, bound, out)
      bound.add(s.name)
      return
    case 'expr': addLambdaRefs(s.expr, bound, out); return
    case 'if':
      addLambdaRefs(s.cond, bound, out)
      addLambdaStmtRefs(s.then, bound, out)
      if (s.els !== null) addLambdaStmtRefs(s.els, bound, out)
      return
    case 'while': addLambdaRefs(s.cond, bound, out); addLambdaStmtRefs(s.body, bound, out); return
    case 'dowhile': addLambdaStmtRefs(s.body, bound, out); addLambdaRefs(s.cond, bound, out); return
    case 'for':
      if (s.init !== null) addLambdaStmtRefs(s.init, bound, out)
      if (s.cond !== null) addLambdaRefs(s.cond, bound, out)
      for (const x of s.step) addLambdaRefs(x, bound, out)
      addLambdaStmtRefs(s.body, bound, out)
      return
    case 'foreach':
      addLambdaRefs(s.iter, bound, out)
      bound.add(s.name)
      addLambdaStmtRefs(s.body, bound, out)
      return
    case 'switch':
      addLambdaRefs(s.subject, bound, out)
      for (const c of s.clauses) {
        if (c.label !== null) addLambdaRefs(c.label, bound, out)
        for (const x of c.stmts) addLambdaStmtRefs(x, bound, out)
      }
      return
    case 'return': if (s.value !== null) addLambdaRefs(s.value, bound, out); return
    case 'throw': addLambdaRefs(s.value, bound, out); return
    case 'try':
      addLambdaStmtRefs(s.body, bound, out)
      for (const c of s.catches) {
        bound.add(c.name)
        addLambdaStmtRefs(c.body, bound, out)
      }
      if (s.fin !== null) addLambdaStmtRefs(s.fin, bound, out)
      return
    case 'region': addLambdaStmtRefs(s.body, bound, out); return
    case 'using': addLambdaRefs(s.target, bound, out); addLambdaStmtRefs(s.body, bound, out); return
    case 'localFunc':
      bound.add(s.name)
      for (const p of s.params) bound.add(p.name)
      addLambdaStmtRefs(s.body, bound, out)
      return
    default: return
  }
}

function lambdaRegionNames(e: Extract<Expr, { kind: 'lambda' }>): string[] {
  const bound = new Set(e.params.map((p) => p.name))
  const refs = new Set<string>()
  if (e.body.kind === 'block') addLambdaStmtRefs(e.body, bound, refs)
  else addLambdaRefs(e.body, bound, refs)
  return [...refs]
}

function checkRegionCall(e: Extract<Expr, { kind: 'call' }>, ctx: Ctx, env: Map<string, Ty>): void {
  if (ctx.regionDepth === 0) return
  if (e.callee.kind === 'name' && ctx.funcs.has(e.callee.name) && !BUILTIN_NAMES.has(e.callee.name)) {
    const effects = ctx.regionEffects.get(e.callee.name)
    for (const [i, arg] of e.args.entries()) {
      const a = unwrapNamed(arg)
      if (effects !== undefined && !effects.has(i)) continue
      if (isRegionValue(a, ctx)) {
        warn(ctx, `区域对象传给了函数「${e.callee.name}」`, a.line, a.col, '函数可能把它保存到区域外；需要长期保存时先复制')
      }
    }
    return
  }
  if (e.callee.kind === 'name' && (env.get(e.callee.name) ?? '').startsWith('委托:')) {
    for (const arg of e.args) {
      const a = unwrapNamed(arg)
      if (isRegionValue(a, ctx)) {
        warn(ctx, `区域对象传给了委托「${e.callee.name}」`, a.line, a.col, '委托可能在区域结束后才执行，并保存这个对象')
        return
      }
    }
    return
  }
  if (e.callee.kind !== 'member') return
  const method = e.callee.name
  const argIndex = method === '设置' || method === '插入' ? 1 : 0
  const containerMethods = new Set(['添加', '追加', '插入', '入队', '入栈', '设置'])
  if (containerMethods.has(method)) {
    if (isRegionValue(e.callee.target, ctx)) return
    const arg = e.args[argIndex]
    if (arg === undefined) return
    const a = unwrapNamed(arg)
    if (isRegionValue(a, ctx)) {
      warn(ctx, `区域对象可能被保存到容器（${method}）`, a.line, a.col, '区域结束时容器仍会指向已回收的内存')
    }
    return
  }
  if (isRegionValue(e.callee.target, ctx)) return
  const effects = ctx.regionEffects.get(method)
  for (const [i, arg] of e.args.entries()) {
    const a = unwrapNamed(arg)
    if (effects !== undefined && !effects.has(i)) continue
    if (isRegionValue(a, ctx)) {
      warn(ctx, `区域对象传给了方法「${method}」`, a.line, a.col, '方法可能把它保存到区域外')
      return
    }
  }
}

function checkRegionCtor(name: string, args: Expr[], ctx: Ctx): void {
  if (ctx.regionDepth === 0) return
  const effects = ctx.regionEffects.get(`构造:${name}`)
  for (const [i, arg] of args.entries()) {
    const a = unwrapNamed(arg)
    if (effects !== undefined && !effects.has(i)) continue
    if (isRegionValue(a, ctx)) {
      warn(ctx, `区域对象传给了构造器「${name}」`, a.line, a.col, '构造器可能把它保存到区域外')
    }
  }
}

function isNullTracked(t: Ty | null | undefined): boolean {
  return t !== undefined && t !== null && (t.startsWith('类:') || t.startsWith('接口:') || t.startsWith('委托:'))
}

function withNullScope<T>(ctx: Ctx, fn: () => T): T {
  const old = ctx.nullVars
  const oldFields = ctx.nullFields
  const oldBreaks = ctx.breakStack
  ctx.nullVars = new Set()
  ctx.nullFields = new Set()
  ctx.breakStack = []
  try {
    return fn()
  } finally {
    ctx.nullVars = old
    ctx.nullFields = oldFields
    ctx.breakStack = oldBreaks
  }
}

function mergeNullStates(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((x) => b.has(x)))
}

function nullReturnValue(e: Expr, known: Map<string, boolean>): boolean {
  if (e.kind === 'null') return true
  if (e.kind === 'paren' || e.kind === 'cast') return nullReturnValue(e.expr, known)
  if (e.kind === 'cond') return nullReturnValue(e.then, known) || nullReturnValue(e.else, known)
  if (e.kind === 'call' && (e.callee.kind === 'name' || e.callee.kind === 'member')) {
    return known.get(e.callee.name) === true
  }
  return false
}

function visitReturns(s: Stmt, fn: (value: Expr | null) => void): void {
  switch (s.kind) {
    case 'block':
      for (const x of s.stmts) visitReturns(x, fn)
      return
    case 'return':
      fn(s.value)
      return
    case 'if':
      visitReturns(s.then, fn)
      if (s.els !== null) visitReturns(s.els, fn)
      return
    case 'while':
    case 'dowhile':
      visitReturns(s.body, fn)
      return
    case 'for':
      visitReturns(s.body, fn)
      return
    case 'foreach':
      visitReturns(s.body, fn)
      return
    case 'switch':
      for (const c of s.clauses) for (const x of c.stmts) visitReturns(x, fn)
      return
    case 'try':
      visitReturns(s.body, fn)
      for (const c of s.catches) visitReturns(c.body, fn)
      if (s.fin !== null) visitReturns(s.fin, fn)
      return
    case 'region':
      visitReturns(s.body, fn)
      return
    case 'using':
      visitReturns(s.body, fn)
      return
    default:
      return
  }
}

function collectNullReturns(unit: CompilationUnit): Map<string, boolean> {
  const funcs = unit.stmts.filter((s): s is Extract<Stmt, { kind: 'localFunc' }> => s.kind === 'localFunc')
  const methods: { name: string; body: Stmt }[] = []
  const collectMethods = (decls: Decl[]): void => {
    for (const d of decls) {
      if (d.kind === 'namespace') {
        collectMethods(d.decls)
      } else if (d.kind === 'class' || d.kind === 'struct') {
        for (const m of d.members) {
          if (m.kind === 'method' && m.body !== null) methods.push({ name: m.name, body: m.body })
        }
      }
    }
  }
  collectMethods(unit.decls)
  const defs: { name: string; body: Stmt }[] = [
    ...funcs.map((f) => ({ name: f.name, body: f.body })),
    ...methods,
  ]
  const known = new Map<string, boolean>(defs.map((f) => [f.name, false]))
  let changed = true
  while (changed) {
    changed = false
    for (const f of defs) {
      if (known.get(f.name) === true) continue
      let found = false
      visitReturns(f.body, (value) => {
        if (value === null || nullReturnValue(value, known)) found = true
      })
      if (found) {
        known.set(f.name, true)
        changed = true
      }
    }
  }
  return known
}

function walkExprs(e: Expr, fn: (e: Expr) => void): void {
  fn(e)
  switch (e.kind) {
    case 'string':
      for (const s of e.segs) if (s.kind === 'expr') walkExprs(s.expr, fn)
      return
    case 'binary':
      walkExprs(e.left, fn)
      walkExprs(e.right, fn)
      return
    case 'unary':
    case 'postfix':
      walkExprs(e.operand, fn)
      return
    case 'assign':
      walkExprs(e.target, fn)
      walkExprs(e.value, fn)
      return
    case 'cond':
      walkExprs(e.cond, fn)
      walkExprs(e.then, fn)
      walkExprs(e.else, fn)
      return
    case 'call':
      walkExprs(e.callee, fn)
      for (const a of e.args) walkExprs(a, fn)
      return
    case 'named':
      walkExprs(e.value, fn)
      return
    case 'byref':
      walkExprs(e.expr, fn)
      return
    case 'member':
      walkExprs(e.target, fn)
      return
    case 'index':
      walkExprs(e.target, fn)
      walkExprs(e.index, fn)
      return
    case 'new':
      for (const a of e.args) walkExprs(a, fn)
      return
    case 'cast':
      walkExprs(e.expr, fn)
      return
    case 'array':
      for (const a of e.elems) walkExprs(a, fn)
      return
    case 'paren':
      walkExprs(e.expr, fn)
      return
    case 'lambda':
      for (const p of e.params) if (p.def !== null) walkExprs(p.def, fn)
      if (e.body.kind === 'block') walkStmtExprs(e.body, fn)
      else walkExprs(e.body, fn)
      return
    default:
      return
  }
}

function walkStmtExprs(s: Stmt, fn: (e: Expr) => void): void {
  switch (s.kind) {
    case 'block':
      for (const x of s.stmts) walkStmtExprs(x, fn)
      return
    case 'var':
      if (s.init !== null) walkExprs(s.init, fn)
      return
    case 'expr':
      walkExprs(s.expr, fn)
      return
    case 'if':
      walkExprs(s.cond, fn)
      walkStmtExprs(s.then, fn)
      if (s.els !== null) walkStmtExprs(s.els, fn)
      return
    case 'while':
      walkExprs(s.cond, fn)
      walkStmtExprs(s.body, fn)
      return
    case 'dowhile':
      walkStmtExprs(s.body, fn)
      walkExprs(s.cond, fn)
      return
    case 'for':
      if (s.init !== null) walkStmtExprs(s.init, fn)
      if (s.cond !== null) walkExprs(s.cond, fn)
      for (const x of s.step) walkExprs(x, fn)
      walkStmtExprs(s.body, fn)
      return
    case 'foreach':
      walkExprs(s.iter, fn)
      walkStmtExprs(s.body, fn)
      return
    case 'switch':
      walkExprs(s.subject, fn)
      for (const c of s.clauses) {
        if (c.label !== null) walkExprs(c.label, fn)
        for (const x of c.stmts) walkStmtExprs(x, fn)
      }
      return
    case 'return':
      if (s.value !== null) walkExprs(s.value, fn)
      return
    case 'throw':
      walkExprs(s.value, fn)
      return
    case 'try':
      walkStmtExprs(s.body, fn)
      for (const c of s.catches) {
        if (c.filter !== undefined && c.filter !== null) walkExprs(c.filter, fn)
        walkStmtExprs(c.body, fn)
      }
      if (s.fin !== null) walkStmtExprs(s.fin, fn)
      return
    case 'region':
      walkStmtExprs(s.body, fn)
      return
    case 'using':
      walkExprs(s.target, fn)
      walkStmtExprs(s.body, fn)
      return
    case 'localFunc':
      walkStmtExprs(s.body, fn)
      return
    default:
      return
  }
}

function collectNullArgs(unit: CompilationUnit): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const s of unit.stmts) {
    walkStmtExprs(s, (e) => {
      if (e.kind !== 'call' || (e.callee.kind !== 'name' && e.callee.kind !== 'member')) return
      const key = e.callee.kind === 'name' ? e.callee.name : `方法:${e.callee.name}`
      const set = out.get(key) ?? new Set<number>()
      for (const [i, a] of e.args.entries()) if (a.kind === 'null') set.add(i)
      if (set.size > 0) out.set(key, set)
    })
  }
  return out
}

function definitelyNull(e: Expr, ctx: Ctx): boolean {
  if (e.kind === 'null') return true
  if (e.kind === 'name') return ctx.nullVars.has(e.name)
  if (e.kind === 'call' && (e.callee.kind === 'name' || e.callee.kind === 'member')) {
    return ctx.nullReturns.get(e.callee.name) === true
  }
  return false
}

function memberKey(e: Extract<Expr, { kind: 'member' }>): string | null {
  if (e.target.kind === 'this') return `自.${e.name}`
  if (e.target.kind === 'name') return `${e.target.name}.${e.name}`
  if (e.target.kind === 'member') {
    const base = memberKey(e.target)
    return base === null ? null : `${base}.${e.name}`
  }
  return null
}

function forgetFields(ctx: Ctx, name: string): void {
  for (const key of [...ctx.nullFields]) {
    if (key.startsWith(name + '.')) ctx.nullFields.delete(key)
  }
}

function valuePath(e: Expr): string | null {
  if (e.kind === 'name') return e.name
  if (e.kind === 'member') return memberKey(e)
  return null
}

function directVarNames(s: Stmt): string[] {
  const stmts = s.kind === 'block' ? s.stmts : [s]
  return stmts.filter((x): x is Extract<Stmt, { kind: 'var' }> => x.kind === 'var').map((x) => x.name)
}

function restoreScoped(state: Set<string>, before: Set<string>, names: string[]): void {
  for (const n of names) {
    if (before.has(n)) state.add(n)
    else state.delete(n)
  }
}

function refineNull(e: Expr, whenTrue: boolean, set: Set<string>, env: Map<string, Ty>): void {  if (e.kind === 'binary' && e.op === '&&') {
    if (whenTrue) {
      refineNull(e.left, true, set, env)
      refineNull(e.right, true, set, env)
    }
    return
  }
  if (e.kind === 'binary' && e.op === '||') {
    if (!whenTrue) {
      refineNull(e.left, false, set, env)
      refineNull(e.right, false, set, env)
    }
    return
  }
  let left: Expr
  let right: Expr
  let equal = true
  if (e.kind === 'binary' && (e.op === '==' || e.op === '!=')) {
    left = e.left
    right = e.right
    equal = e.op === '=='
  } else if (e.kind === 'unary' && e.op === '!') {
    refineNull(e.operand, !whenTrue, set, env)
    return
  } else {
    return
  }
  const name = left.kind === 'name' && right.kind === 'null'
    ? left.name
    : right.kind === 'name' && left.kind === 'null' ? right.name : null
  if (name === null || !isNullTracked(env.get(name))) return
  const isNull = equal === whenTrue
  if (isNull) set.add(name)
  else set.delete(name)
}

function refineNullFields(e: Expr, whenTrue: boolean, set: Set<string>): void {
  if (e.kind === 'binary' && e.op === '&&') {
    if (whenTrue) {
      refineNullFields(e.left, true, set)
      refineNullFields(e.right, true, set)
    }
    return
  }
  if (e.kind === 'binary' && e.op === '||') {
    if (!whenTrue) {
      refineNullFields(e.left, false, set)
      refineNullFields(e.right, false, set)
    }
    return
  }
  if (e.kind === 'unary' && e.op === '!') {
    refineNullFields(e.operand, !whenTrue, set)
    return
  }
  if (e.kind !== 'binary' || (e.op !== '==' && e.op !== '!=')) return
  const equal = e.op === '=='
  const member = e.left.kind === 'null' ? e.right : e.right.kind === 'null' ? e.left : null
  if (member === null || member.kind !== 'member') return
  const key = memberKey(member)
  if (key === null) return
  const isNull = equal === whenTrue
  if (isNull) {
    if (set.has(key)) set.add(key)
  } else {
    set.delete(key)
  }
}

function addNullAfterLoop(cond: Expr, set: Set<string>, env: Map<string, Ty>): void {
  const probe = new Set(set)
  refineNull(cond, false, probe, env)
  for (const n of probe) if (!set.has(n)) set.add(n)
}

function sigKey(sig: Pick<FnSig, 'params' | 'modes'>): string {
  return sig.params.map((p, i) => `${sig.modes[i] ?? ''}:${p}`).join(',')
}

function addFnSig(ctx: Ctx, name: string, sig: FnSig): void {
  const list = ctx.funcs.get(name) ?? []
  if (!list.some((s) => sigKey(s) === sigKey(sig))) list.push(sig)
  ctx.funcs.set(name, list)
}

function resolveTypeRef(t: TypeRef, shapes: Map<string, Shape>): Ty | null {  if (t.kind === 'array') {
    const e = resolveTypeRef(t.elem, shapes)
    return e === null ? null : e + '[]'
  }
  if (t.name === '列表' || t.name === '集合' || t.name === '队列' || t.name === '栈') {
    const e = t.typeArgs[0] ? resolveTypeRef(t.typeArgs[0], shapes) : null
    return e === null ? null : `列表:${e}`
  }
  if (t.name === '表') {
    const k = t.typeArgs[0] ? resolveTypeRef(t.typeArgs[0], shapes) : null
    const v = t.typeArgs[1] ? resolveTypeRef(t.typeArgs[1], shapes) : null
    if (k === null || v === null) return null
    return `表:${k}:${v}`
  }
  if (t.typeArgs.length > 0) return null
  switch (t.name) {
    case '字节': case '有符号字节': case '短整数': case '无符号短整数':
    case '整数': case '无符号整数': case '长整数': case '无符号长整数':
    case '浮点数': case '长小数': case '文本': case '字符': case '真假': case '无':
      return t.name
    case '异常': case '参数异常': case '状态异常': case '文件异常': case '越界异常': case '格式异常':
      return t.name === '异常' ? '异常' : `异常:${t.name}`
    default: break
  }
  const s = shapes.get(t.name)
  if (s === undefined) return null
  if (s.kind === 'delegate') return `委托:${s.name}`
  if (s.kind === 'enum') return `枚举:${s.name}`
  if (s.kind === 'interface') return `接口:${s.name}`
  return `${s.kind === 'class' ? '类' : '结构'}:${s.name}`
}

function resolveTypeInShape(t: TypeRef, shape: Shape, shapes: Map<string, Shape>): Ty | null {
  const r = resolveTypeRef(t, shapes)
  if (r !== null) return r
  if (t.kind === 'named' && shape.typeParams?.includes(t.name)) return '?'
  if (t.kind === 'array') {
    const e = resolveTypeInShape(t.elem, shape, shapes)
    return e === null ? null : e + '[]'
  }
  if (t.name === '列表' || t.name === '集合' || t.name === '队列' || t.name === '栈') {
    const e = t.typeArgs[0] ? resolveTypeInShape(t.typeArgs[0], shape, shapes) : null
    return e === null ? null : `列表:${e}`
  }
  if (t.name === '表') {
    const k = t.typeArgs[0] ? resolveTypeInShape(t.typeArgs[0], shape, shapes) : null
    const v = t.typeArgs[1] ? resolveTypeInShape(t.typeArgs[1], shape, shapes) : null
    return k === null || v === null ? null : `表:${k}:${v}`
  }
  const target = shapes.get(t.name)
  if (target?.typeParams !== undefined) {
    const prefix = target.kind === 'interface' ? '接口' : target.kind === 'struct' ? '结构' : '类'
    return `${prefix}:${t.name}:?`
  }
  return null
}

function addMember(map: Map<string, MemberSig>, name: string, sig: MemberSig): void {
  if (!map.has(name)) map.set(name, sig)
}

function addMethod(s: Shape, name: string, sig: MemberSig): void {
  if (!s.methods.has(name)) s.methods.set(name, sig)
  const list = s.methodOverloads.get(name)
  if (list === undefined) s.methodOverloads.set(name, [sig])
  else list.push(sig)
}

function collectShapes(decls: Decl[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>()
  const pending: Decl[] = []
  const seenNames = new Set<string>()
  const walk = (list: Decl[]): void => {
    for (const d of list) {
      if (d.kind === 'namespace') walk(d.decls)
      else if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface' || d.kind === 'enum' || d.kind === 'delegate') {
        if (seenNames.has(d.name)) continue
        seenNames.add(d.name)
        pending.push(d)
      }
    }
  }
  walk(decls)

  // 先建空壳，字段类型可以引用后面才声明的类型。
  for (const d of pending) {
    if (d.kind === 'enum') {
      shapes.set(d.name, {
        kind: 'enum', name: d.name, bases: [], fields: new Map(), methods: new Map(), methodOverloads: new Map(),
        props: new Map(), enumItems: new Set(d.items.map((x) => x.name)),
      })
    } else if (d.kind === 'delegate') {
    if (d.params.some((p) => p.mode !== undefined)) {
      err(ctx, '委托类型不能有 引用/输出 参数', d.line, d.col)
    }
      shapes.set(d.name, {
        kind: 'delegate', name: d.name, bases: [], fields: new Map(), methods: new Map(), methodOverloads: new Map(),
        props: new Map(), enumItems: new Set(),
      })
    } else if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') {
      shapes.set(d.name, {
        kind: d.kind, name: d.name,
        bases: d.bases.flatMap((b) => b.kind === 'named' ? [b.name] : []),
        typeParams: d.typeParams,
        typeConstraints: d.typeConstraints,
        fields: new Map(), methods: new Map(), methodOverloads: new Map(), props: new Map(), enumItems: new Set(),
      })
    }
  }

  const addAliases = (list: Decl[], path: string[]): void => {
    for (const d of list) {
      if (d.kind === 'namespace') {
        addAliases(d.decls, [...path, ...d.name.split('.')])
        continue
      }
      if (d.kind !== 'class' && d.kind !== 'struct' && d.kind !== 'interface' && d.kind !== 'enum' && d.kind !== 'delegate') continue
      const s = shapes.get(d.name)
      if (s !== undefined) shapes.set([...path, d.name].join('.'), s)
    }
  }
  addAliases(decls, [])

  for (const d of pending) {
    if (d.kind === 'delegate') {
      const s = shapes.get(d.name)!
      const ret = resolveTypeRef(d.ret, shapes)
      const params = d.params.map((p) => resolveTypeRef(p.type, shapes))
      if (ret !== null && params.every((p) => p !== null)) {
        s.delegateRet = ret
        s.delegateParams = params as Ty[]
        s.delegateParamNames = d.params.map((p) => p.name)
      }
      continue
    }
    if (d.kind !== 'class' && d.kind !== 'struct' && d.kind !== 'interface') continue
    const s = shapes.get(d.name)!
    for (const m of d.members) {
      if (m.kind === 'method' && m.name === d.name) {
        const params = m.params.map((p) => resolveTypeInShape(p.type, s, shapes))
        if (params.every((p) => p !== null)) {
          s.ctor = { params: params as Ty[], modes: m.params.map((p) => p.mode ?? null), paramNames: m.params.map((p) => p.name), defaults: m.params.map((p) => p.def), minArgs: m.params.filter((p) => p.def === null).length, maxArgs: m.params.length }
        }
        continue
      }
      if (m.kind === 'field') {
        const t = resolveTypeInShape(m.type, s, shapes)
        if (t !== null) addMember(s.fields, m.name, { kind: 'field', type: t, params: [], minArgs: 0, maxArgs: 0, isStatic: m.modifiers.includes('静态'), isConst: m.modifiers.includes('常') })
      } else if (m.kind === 'prop') {
        const t = resolveTypeInShape(m.type, s, shapes)
        if (t !== null) addMember(s.props, m.name, { kind: 'prop', type: t, params: [], minArgs: 0, maxArgs: 0, isStatic: m.modifiers.includes('静态') })
      } else if (m.kind === 'method' || m.kind === 'ifaceMethod') {
        const t = resolveTypeInShape(m.ret, s, shapes)
        const params = m.params.map((p) => resolveTypeInShape(p.type, s, shapes))
        if (t !== null && params.every((p) => p !== null)) {
          addMethod(s, m.name, {
            kind: 'method', type: t, params: params as Ty[],
            paramNames: m.params.map((p) => p.name), defaults: m.params.map((p) => p.def),
            modes: m.params.map((p) => p.mode ?? null),
            minArgs: m.params.filter((p) => p.def === null).length, maxArgs: m.params.length,
            isStatic: m.kind === 'method' && m.modifiers.includes('静态'),
          })
        }
      } else if (m.kind === 'ifaceProp') {
        const t = resolveTypeInShape(m.type, s, shapes)
        if (t !== null) addMember(s.props, m.name, { kind: 'prop', type: t, params: [], minArgs: 0, maxArgs: 0, isStatic: false })
      } else if (m.kind === 'ctor') {
        const params = m.params.map((p) => resolveTypeInShape(p.type, s, shapes))
        if (params.every((p) => p !== null)) {
          s.ctor = { params: params as Ty[], modes: m.params.map((p) => p.mode ?? null), paramNames: m.params.map((p) => p.name), defaults: m.params.map((p) => p.def), minArgs: m.params.filter((p) => p.def === null).length, maxArgs: m.params.length }
        }
      }
    }
    shapes.set(d.name, s)
  }
  return shapes
}

function objParts(t: Ty): { kind: 'class' | 'struct' | 'interface'; name: string } | null {
  if (t.startsWith('类:')) return { kind: 'class', name: t.slice(2) }
  if (t.startsWith('结构:')) return { kind: 'struct', name: t.slice(3) }
  if (t.startsWith('接口:')) return { kind: 'interface', name: t.slice(3) }
  return null
}

function methodOf(shapes: Map<string, Shape>, owner: string, name: string): MemberSig | null {
  let cur: string | null = owner
  const seen = new Set<string>()
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const s = shapes.get(cur)
    if (s === undefined) return null
    const m = s.methods.get(name)
    if (m !== undefined) return m
    const base = s.bases.length > 0 ? shapes.get(s.bases[0]) : undefined
    cur = base !== undefined && (base.kind === 'class' || base.kind === 'struct') ? base.name : null
  }
  return null
}

function listElem(t: Ty): Ty | null {
  if (t.startsWith('列表:')) return t.slice(3)
  if (t.endsWith('[]')) return t.slice(0, -2)
  return null
}

function findInObject(ctx: Ctx, t: Ty, name: string, seen = new Set<string>()): MemberSig | null {
  const p = objParts(t)
  if (p === null || seen.has(p.name)) return null
  seen.add(p.name)
  if (p.kind === 'interface') {
    const s = ctx.shapes.get(p.name)
    if (s === undefined) return null
    return s.methods.get(name) ?? s.props.get(name) ?? null
  }
  const s = ctx.shapes.get(p.name)
  if (s === undefined) return null
  const own = s.fields.get(name) ?? s.props.get(name) ?? s.methods.get(name)
  if (own !== undefined) return own
  for (const b of s.bases) {
    const found = findInObject(ctx, `${p.kind === 'struct' ? '结构' : '类'}:${b}`, name, seen)
    if (found !== null) return found
  }
  return null
}

function findMethodsInObject(ctx: Ctx, t: Ty, name: string, seen = new Set<string>()): MemberSig[] {
  const p = objParts(t)
  if (p === null || seen.has(p.name)) return []
  seen.add(p.name)
  const s = ctx.shapes.get(p.name)
  if (s === undefined) return []
  const own = s.methodOverloads.get(name)
  if (own !== undefined) return own
  for (const b of s.bases) {
    const found = findMethodsInObject(ctx, `${p.kind === 'struct' ? '结构' : p.kind === 'interface' ? '接口' : '类'}:${b}`, name, seen)
    if (found.length > 0) return found
  }
  return []
}

interface OverloadLike {
  params: Ty[]
  minArgs: number
  maxArgs: number
  paramNames?: string[]
  defaults?: (Expr | null)[]
}

/** 按参数类型选择重载；命名参数先按候选的形参名重排，只给显式传入的实参打分。 */
function chooseOverload<T extends OverloadLike>(
  ctx: Ctx, list: T[], args: Expr[], argTypes: (Ty | null)[], label: string,
  line: number, col: number,
): { sig: T; index: number } | null {
  const known = new Map<Expr, Ty | null>()
  args.forEach((a, i) => known.set(a.kind === 'named' ? a.value : a, argTypes[i] ?? null))
  const hasNamed = args.some((a) => a.kind === 'named')
  const scored: { sig: T; index: number; score: number; defaults: number }[] = []
  for (let index = 0; index < list.length; index++) {
    const candidate = list[index]
    let arranged: Expr[]
    let usedDefaults = 0
    if (hasNamed) {
      const r = arrangeArguments(args, candidate.paramNames ?? [], candidate.defaults ?? [])
      if (r.error !== undefined) continue
      arranged = r.args
      usedDefaults = arranged.length - args.length
    } else {
      if (args.length < candidate.minArgs || args.length > candidate.maxArgs) continue
      arranged = args
      usedDefaults = candidate.params.length - args.length
    }
    let score = 0
    let ok = true
    for (let i = 0; i < arranged.length; i++) {
      const a = arranged[i]
      if (!known.has(a)) continue
      const actual = known.get(a) ?? null
      if (actual === null) continue
      if (actual === candidate.params[i]) score += 2
      else if (isSubtype(ctx, actual, candidate.params[i])) score += 1
      else {
        ok = false
        break
      }
    }
    if (ok) scored.push({ sig: candidate, index, score, defaults: usedDefaults })
  }
  if (scored.length === 0) {
    err(ctx, `找不到匹配的「${label}」重载`, line, col, `有 ${args.length} 个参数`)
    return null
  }
  const best = Math.max(...scored.map((x) => x.score))
  let winners = scored.filter((x) => x.score === best)
  if (winners.length > 1) {
    const least = Math.min(...winners.map((x) => x.defaults))
    winners = winners.filter((x) => x.defaults === least)
  }
  if (winners.length !== 1) {
    err(ctx, `找不到匹配的「${label}」重载`, line, col, `有 ${args.length} 个参数`)
    return null
  }
  return { sig: winners[0].sig, index: winners[0].index }
}

function chooseMethod(
  ctx: Ctx, list: MemberSig[], args: Expr[], argTypes: (Ty | null)[], label: string,
  line: number, col: number,
): { sig: MemberSig; index: number } | null {
  return chooseOverload(ctx, list, args, argTypes, label, line, col)
}

function objectMemberNames(ctx: Ctx, t: Ty): string[] {
  const p = objParts(t)
  if (p === null) return []
  const s = ctx.shapes.get(p.name)
  if (s === undefined) return []
  const out: string[] = []
  for (const k of s.fields.keys()) out.push(k)
  for (const k of s.props.keys()) out.push(k)
  for (const k of s.methods.keys()) out.push(k)
  for (const b of s.bases) out.push(...objectMemberNames(ctx, `${p.kind === 'struct' ? '结构' : '类'}:${b}`))
  return out
}

interface BuiltinMember {
  kind: 'field' | 'method'
  type: Ty
  params: Ty[]
  minArgs: number
  maxArgs: number
  desc?: string
}

const TEXT_MEMBERS = new Map<string, BuiltinMember>([
  ['长度', { kind: 'field', type: '整数', params: [], minArgs: 0, maxArgs: 0, desc: '文本长度' }],
  ['切分', { kind: 'method', type: '列表:文本', params: ['文本'], minArgs: 1, maxArgs: 1, desc: '按分隔符切分' }],
  ['切分空白', { kind: 'method', type: '列表:文本', params: [], minArgs: 0, maxArgs: 0, desc: '按空白切分' }],
  ['替换', { kind: 'method', type: '文本', params: ['文本', '文本'], minArgs: 2, maxArgs: 2, desc: '替换子串' }],
  ['含', { kind: 'method', type: '真假', params: ['文本'], minArgs: 1, maxArgs: 1, desc: '是否包含子串' }],
  ['转大写', { kind: 'method', type: '文本', params: [], minArgs: 0, maxArgs: 0 }],
  ['转小写', { kind: 'method', type: '文本', params: [], minArgs: 0, maxArgs: 0 }],
  ['去除空白', { kind: 'method', type: '文本', params: [], minArgs: 0, maxArgs: 0 }],
  ['转整数', { kind: 'method', type: '整数', params: [], minArgs: 0, maxArgs: 0 }],
  ['转长小数', { kind: 'method', type: '长小数', params: [], minArgs: 0, maxArgs: 0 }],
  ['转浮点数', { kind: 'method', type: '浮点数', params: [], minArgs: 0, maxArgs: 0 }],
])

const LIST_MEMBERS = new Map<string, BuiltinMember>([
  ['数量', { kind: 'field', type: '整数', params: [], minArgs: 0, maxArgs: 0 }],
  ['长度', { kind: 'field', type: '整数', params: [], minArgs: 0, maxArgs: 0 }],
  ['追加', { kind: 'method', type: '无', params: [], minArgs: 1, maxArgs: 1 }],
  ['插入', { kind: 'method', type: '无', params: ['整数'], minArgs: 2, maxArgs: 2 }],
  ['删除', { kind: 'method', type: '无', params: ['整数'], minArgs: 1, maxArgs: 1 }],
  ['清空', { kind: 'method', type: '无', params: [], minArgs: 0, maxArgs: 0 }],
  ['含', { kind: 'method', type: '真假', params: ['?'], minArgs: 1, maxArgs: 1 }],
  ['查找', { kind: 'method', type: '整数', params: [], minArgs: 1, maxArgs: 1 }],
  ['排序', { kind: 'method', type: '无', params: [], minArgs: 0, maxArgs: 0 }],
  ['最大', { kind: 'method', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
  ['最小', { kind: 'method', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
  ['反转', { kind: 'method', type: '无', params: [], minArgs: 0, maxArgs: 0 }],
  ['切片', { kind: 'method', type: '列表:?', params: ['整数', '整数'], minArgs: 2, maxArgs: 2 }],
  ['去重', { kind: 'method', type: '无', params: [], minArgs: 0, maxArgs: 0 }],
  ['集合添加', { kind: 'method', type: '真假', params: [], minArgs: 1, maxArgs: 1 }],
  ['入队', { kind: 'method', type: '无', params: [], minArgs: 1, maxArgs: 1 }],
  ['入栈', { kind: 'method', type: '无', params: [], minArgs: 1, maxArgs: 1 }],
  ['出队', { kind: 'method', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
  ['出栈', { kind: 'method', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
])

const MAP_MEMBERS = new Map<string, BuiltinMember>([
  ['数量', { kind: 'field', type: '整数', params: [], minArgs: 0, maxArgs: 0 }],
  ['含', { kind: 'method', type: '真假', params: ['?'], minArgs: 1, maxArgs: 1 }],
  ['取值', { kind: 'method', type: '?', params: ['?', '?'], minArgs: 2, maxArgs: 2 }],
  ['条目', { kind: 'method', type: '列表:条目', params: [], minArgs: 0, maxArgs: 0 }],
  ['设置', { kind: 'method', type: '无', params: ['?', '?'], minArgs: 2, maxArgs: 2 }],
  ['删除', { kind: 'method', type: '无', params: ['?'], minArgs: 1, maxArgs: 1 }],
])

const ENTRY_MEMBERS = new Map<string, BuiltinMember>([
  ['键', { kind: 'field', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
  ['值', { kind: 'field', type: '?', params: [], minArgs: 0, maxArgs: 0 }],
])

const ERROR_MEMBERS = new Map<string, BuiltinMember>([
  ['信息', { kind: 'field', type: '文本', params: [], minArgs: 0, maxArgs: 0 }],
  ['类型', { kind: 'field', type: '文本', params: [], minArgs: 0, maxArgs: 0 }],
])

function builtinMembers(t: Ty): Map<string, BuiltinMember> | null {
  if (t === '文本') return TEXT_MEMBERS
  if (t.startsWith('列表:')) return LIST_MEMBERS
  if (t.startsWith('表:')) return MAP_MEMBERS
  if (t.startsWith('条目:')) return ENTRY_MEMBERS
  if (t === '异常' || t.startsWith('异常:')) return ERROR_MEMBERS
  if (t.endsWith('[]') && t !== '[]') return ARRAY_MEMBERS
  return null
}

const ARRAY_MEMBERS = new Map<string, BuiltinMember>([
  ['长度', { kind: 'field', type: '整数', params: [], minArgs: 0, maxArgs: 0 }],
  ['添加', { kind: 'method', type: '无', params: ['?'], minArgs: 1, maxArgs: 1 }],
  ['删除', { kind: 'method', type: '无', params: ['整数'], minArgs: 1, maxArgs: 1 }],
  ['插入', { kind: 'method', type: '无', params: ['整数', '?'], minArgs: 2, maxArgs: 2 }],
])

function builtinMember(t: Ty, name: string): BuiltinMember | null {
  const table = builtinMembers(t)
  if (table === null) return null
  const m = table.get(name)
  if (m === undefined) return null
  let params = m.params
  if (t.startsWith('列表:')) {
    const elem = listElem(t) ?? '?'
    if (name === '追加' || name === '含' || name === '查找' || name === '集合添加' || name === '入队' || name === '入栈') {
      params = [elem]
    } else if (name === '插入') {
      params = ['整数', elem]
    }
  }
  if (m.type === '?') return { ...m, params, type: listElem(t) ?? '?' }
  if (m.type === '列表:?') return { ...m, params, type: t }
  return { ...m, params }
}

function memberNames(t: Ty, ctx: Ctx): string[] {
  const table = builtinMembers(t)
  if (table !== null) return [...table.keys()]
  if (t.startsWith('枚举:')) {
    const s = ctx.shapes.get(t.slice(3))
    return s === undefined ? [] : [...s.enumItems]
  }
  if (t.startsWith('类型:')) {
    const s = ctx.shapes.get(t.slice(3))
    if (s === undefined) return []
    const out: string[] = []
    for (const [name, m] of s.fields) if (m.isStatic) out.push(name)
    for (const [name, m] of s.props) if (m.isStatic) out.push(name)
    for (const [name, m] of s.methods) if (m.isStatic) out.push(name)
    return out
  }
  const p = objParts(t)
  if (p !== null) return objectMemberNames(ctx, t)
  return []
}

function unknownMember(ctx: Ctx, t: Ty, name: string, line: number, col: number): void {
  const label = t.startsWith('类:') || t.startsWith('结构:') || t.startsWith('接口:') || t.startsWith('类型:')
    ? t.slice(t.indexOf(':') + 1)
    : t
  const names = memberNames(t, ctx)
  let hint = ''
  if (names.length > 0) hint = `可用成员：${names.join('、')}`
  err(ctx, `类型「${label}」没有成员「${name}」`, line, col, hint || undefined)
}

function inferString(e: Expr, env: Map<string, Ty>, ctx: Ctx): void {
  if (e.kind !== 'string') return
  for (const seg of e.segs) if (seg.kind === 'expr') infer(seg.expr, env, ctx)
}

function castAllowed(from: Ty, to: Ty): boolean {
  if (from === to) return true
  const numeric = (t: Ty): boolean => isNumeric(t)
  if (numeric(from) && numeric(to)) return true
  if (from === '整数' && to.startsWith('枚举:')) return true
  if (from.startsWith('枚举:') && to === '整数') return true
  if (from.startsWith('枚举:') && to.startsWith('枚举:')) return true
  if (to === '文本' && (isInteger(from) || from === '长小数' || from === '浮点数' || from === '真假' || from.startsWith('枚举:'))) return true
  if (from === '文本' && numeric(to)) return true
  if (from === '空' && (to.startsWith('类:') || to.startsWith('接口:'))) return true
  if ((from.startsWith('类:') || from.startsWith('接口:')) && (to.startsWith('类:') || to.startsWith('接口:'))) return true
  return false
}

function infer(e: Expr, env: Map<string, Ty>, ctx: Ctx, isCallee = false): Ty | null {
  switch (e.kind) {
    case 'int': return '整数'
    case 'float': return '长小数'
    case 'char': return '字符'
    case 'string':
      inferString(e, env, ctx)
      return '文本'
    case 'bool': return '真假'
    case 'null': return '空'
    case 'name': {
      const local = env.get(e.name)
      if (local !== undefined) return local
      const s = ctx.shapes.get(e.name)
      if (s !== undefined) return `类型:${e.name}`
      const fns = ctx.funcs.get(e.name)
      if (fns !== undefined && fns.length === 1) return `函数:${fns[0].params.join(',')}->${fns[0].ret}`
      return null
    }
    case 'this': return ctx.thisType
    case 'base': {
      const p = ctx.thisType === null ? null : objParts(ctx.thisType)
      if (p === null) return null
      const s = ctx.shapes.get(p.name)
      const b = s?.bases[0]
      return b === undefined ? null : `${p.kind === 'struct' ? '结构' : '类'}:${b}`
    }
    case 'value': return null
    case 'cast': {
      const target = resolveTypeRef(e.type, ctx.shapes)
      const source = infer(e.expr, env, ctx)
      if (target === null) return null
      if (source !== null && !castAllowed(source, target)) {
        err(ctx, `不能把「${source}」转换成「${target}」`, e.line, e.col, '检查转换目标类型')
      }
      return target
    }
    case 'paren': return infer(e.expr, env, ctx)
    case 'binary': {
      if (e.op === '&&' || e.op === '||') {
        infer(e.left, env, ctx)
        const saved = new Set(ctx.nullVars)
        refineNull(e.left, e.op === '&&', ctx.nullVars, env)
        infer(e.right, env, ctx)
        ctx.nullVars = saved
        return '真假'
      }
      const l = infer(e.left, env, ctx)
      const r = infer(e.right, env, ctx)
      if (e.op === '??') {
        if (l !== null && !isObjectLike(l)) {
          err(ctx, `?? 左边必须是类、列表或表，实际是「${l}」`, e.line, e.col)
        }
        if (l !== null && r !== null) {
          checkValue(ctx, '?? 右边的值', l, r, e.right.line, e.right.col)
        }
        return l ?? r
      }
      if (['==', '!=', '<', '<=', '>', '>=', '且', '或'].includes(e.op)) {
        if (e.op === '==' || e.op === '!=') {
          const other = l === '空' ? r : r === '空' ? l : null
          if (other !== null && other !== '空' && !isObjectLike(other)) {
            err(ctx, `「${other}」不能和 空 比较`, e.line, e.col, '空 目前只能用于类、接口、列表、表、数组、委托和异常')
          }
        }
        return '真假'
      }
      if (e.op === '+' && (l === '文本' || r === '文本')) return '文本'
      if (l === '长小数' || r === '长小数') return '长小数'
      if (l === '浮点数' || r === '浮点数') return '浮点数'
      if (l === '长整数' || r === '长整数' || l === '无符号长整数' || r === '无符号长整数') return '长整数'
      if (isInteger(l ?? '') || isInteger(r ?? '')) return '整数'
      return l ?? r
    }
    case 'unary': {
      const t = infer(e.operand, env, ctx)
      return e.op === '!' ? '真假' : t
    }
    case 'postfix': return infer(e.operand, env, ctx)
    case 'assign': {
      const target = infer(e.target, env, ctx)
      const value = infer(e.value, env, ctx)
      const constField = constFieldOf(e.target, env, ctx)
      if (constField !== null) err(ctx, `常字段「${constField}」不能赋值`, e.line, e.col, '常字段的值在声明处固定')
      checkValue(ctx, '赋值', target, value, e.line, e.col)
      if (e.target.kind === 'name' && isNullTracked(target)) {
        if (definitelyNull(e.value, ctx)) ctx.nullVars.add(e.target.name)
        else ctx.nullVars.delete(e.target.name)
      }
      if (e.op === '=' && e.target.kind === 'name') forgetFields(ctx, e.target.name)
      if (e.op === '=' && e.target.kind === 'member') {
        const key = memberKey(e.target)
        if (key !== null && isNullTracked(target)) {
          if (definitelyNull(e.value, ctx)) ctx.nullFields.add(key)
          else ctx.nullFields.delete(key)
        }
      }
      if (ctx.regionDepth > 0 && e.op === '=' && isRegionValue(e.value, ctx) && !value?.startsWith('结构:')) {
        if (e.target.kind === 'name' && !ctx.regionVars.has(e.target.name)) {
          warn(ctx, `区域对象赋给了区域外的变量「${e.target.name}」`, e.line, e.col, '区域结束时对象会失效；需要长期保存时不要放进区域')
        } else if (e.target.kind === 'member' && !(e.target.target.kind === 'name' && ctx.regionVars.has(e.target.target.name))) {
          warn(ctx, `区域对象可能逃逸到字段「${e.target.name}」`, e.line, e.col, '区域结束时字段仍会指向已回收的内存')
        } else if (e.target.kind === 'index' && !(e.target.target.kind === 'name' && ctx.regionVars.has(e.target.target.name))) {
          warn(ctx, '区域对象可能逃逸到区域外的数组或表', e.line, e.col, '区域结束时容器仍会指向已回收的内存')
        }
      }
      return target
    }
    case 'cond': {
      infer(e.cond, env, ctx)
      const a = infer(e.then, env, ctx)
      const b = infer(e.else, env, ctx)
      return a === b ? a : null
    }
    case 'named': return infer(e.value, env, ctx)
    case 'byref': return infer(e.expr, env, ctx)
    case 'call': {
      for (const a of e.args) {
        const path = valuePath(a)
        if (path !== null) forgetFields(ctx, path)
      }
      if (e.callee.kind === 'member') {
        const path = valuePath(e.callee.target)
        if (path !== null) forgetFields(ctx, path)
      }
      checkRegionCall(e, ctx, env)
      if (e.callee.kind === 'name' && ctx.nullVars.has(e.callee.name)) {
        err(ctx, `变量「${e.callee.name}」可能为 空，不能调用`, e.line, e.col, '先判断空引用')
        return null
      }
      if (e.callee.kind === 'name') {
        const argTypes = e.args.map((a) => infer(a, env, ctx))
        const list = ctx.funcs.get(e.callee.name)
        if (list === undefined) {
          const self = ctx.thisType === null ? null : objParts(ctx.thisType)
          const shape = self === null ? undefined : ctx.shapes.get(self.name)
          const methods = shape?.methodOverloads.get(e.callee.name) ?? []
          let m: MemberSig | undefined
          if (methods.length > 1) {
            const chosen = chooseMethod(ctx, methods, e.args, argTypes, e.callee.name, e.line, e.col)
            if (chosen === null) return null
            e.overload = chosen.index
            m = chosen.sig
          } else {
            e.overload = 0
            m = methods[0] ?? shape?.methods.get(e.callee.name)
          }
          if (m !== undefined) {
            const args = arrange(ctx, `方法「${e.callee.name}」`, e.args, m.paramNames ?? [], m.defaults ?? [], e.line, e.col)
            if (args === null) return m.type
            checkArgs(ctx, `方法「${e.callee.name}」`, m.minArgs, m.maxArgs, args.length, e.line, e.col)
            checkByrefArgs(ctx, `方法「${e.callee.name}」`, args, m.modes ?? [], e.line, e.col)
            checkArgTypes(ctx, `方法「${e.callee.name}」`, m.params, args, env, e.line, e.col)
            return m.type
          }
          if (BUILTIN_NAMES.has(e.callee.name) && e.args.some((a) => a.kind === 'named')) {
            err(ctx, `内建函数「${e.callee.name}」不支持命名参数`, e.line, e.col)
          }
          return null
        }
        let fn: FnSig | undefined
        if (list.length === 1) {
          fn = list[0]
          e.overload = 0
        } else {
          const chosen = chooseOverload(ctx, list, e.args, argTypes, e.callee.name, e.line, e.col)
          if (chosen === null) return null
          fn = chosen.sig
          e.overload = chosen.index
        }
        if (fn === undefined) return null
        const args = arrange(ctx, `函数「${e.callee.name}」`, e.args, fn.paramNames, fn.defaults, e.line, e.col)
        if (args === null) return fn.ret
        checkArgs(ctx, `函数「${e.callee.name}」`, fn.minArgs, fn.maxArgs, args.length, e.line, e.col)
        checkByrefArgs(ctx, `函数「${e.callee.name}」`, args, fn.modes, e.line, e.col)
        checkArgTypes(ctx, `函数「${e.callee.name}」`, fn.params, args, env, e.line, e.col)
        return fn.ret
      }
      if (e.callee.kind === 'member') {
        const recv = infer(e.callee.target, env, ctx)
        const argTypes = e.args.map((a) => infer(a, env, ctx))
        if (recv === null) return null
        if (e.callee.nullSafe && !recv.startsWith('类:') && !recv.startsWith('接口:') && !recv.startsWith('列表:') && !recv.startsWith('表:')) {
          err(ctx, '?. 左边必须是类、接口、列表或表对象', e.callee.line, e.callee.col)
          return null
        }
        const name = e.callee.name
        const b = builtinMember(recv, name)
        if (b !== null) {
          if (b.kind !== 'method') {
            err(ctx, `「${name}」不是方法，不能这样调用`, e.callee.line, e.callee.col)
            return null
          }
          if (e.callee.nullSafe && recv.startsWith('表:') && name === '取值') {
            const rest = recv.slice(2)
            const vt = rest.slice(rest.indexOf(':') + 1)
            if (!isNumeric(vt) && vt !== '真假' && vt !== '文本' && !vt.startsWith('列表:') && !vt.startsWith('表:') && !vt.endsWith('[]')) {
              err(ctx, `?. 表取值不支持值类型 ${vt}`, e.callee.line, e.callee.col)
              return null
            }
          }
          if (e.args.some((a) => a.kind === 'named')) {
            err(ctx, `内建方法「${name}」不支持命名参数`, e.callee.line, e.callee.col)
            return b.type
          }
          checkArgs(ctx, `「${name}」`, b.minArgs, b.maxArgs, e.args.length, e.callee.line, e.callee.col)
          if (recv.endsWith('[]')) {
            const elem = recv.slice(0, -2)
            if (name === '添加') checkArgTypes(ctx, `「${name}」`, [elem], e.args, env, e.callee.line, e.callee.col)
            if (name === '插入') checkArgTypes(ctx, `「${name}」`, ['整数', elem], e.args, env, e.callee.line, e.callee.col)
          }
          checkArgTypes(ctx, `「${name}」`, b.params, e.args, env, e.callee.line, e.callee.col)
          return b.type
        }
        if (recv.startsWith('枚举:')) return null
        if (recv.startsWith('类型:')) {
          const typeName = recv.slice(3)
          const s = ctx.shapes.get(typeName)
          if (s === undefined || s.kind === 'enum') return null
          const methods = findMethodsInObject(ctx, `${s.kind === 'class' ? '类' : '结构'}:${typeName}`, name)
          let m: MemberSig | null
          if (methods.length > 1) {
            const chosen = chooseMethod(ctx, methods, e.args, argTypes, name, e.callee.line, e.callee.col)
            if (chosen === null) return null
            e.overload = chosen.index
            m = chosen.sig
          } else {
            e.overload = 0
            m = methods[0] ?? findInObject(ctx, `${s.kind === 'class' ? '类' : '结构'}:${typeName}`, name)
          }
          if (m === null) {
            unknownMember(ctx, recv, name, e.callee.line, e.callee.col)
            return null
          }
          if (!m.isStatic) {
            err(ctx, `「${name}」不是静态方法，不能通过类型名调用`, e.callee.line, e.callee.col)
            return null
          }
          if (m.kind !== 'method') {
            err(ctx, `「${name}」不是方法，不能这样调用`, e.callee.line, e.callee.col)
            return null
          }
          const args = arrange(ctx, `「${name}」`, e.args, m.paramNames ?? [], m.defaults ?? [], e.callee.line, e.callee.col)
          if (args === null) return m.type
          checkArgs(ctx, `「${name}」`, m.minArgs, m.maxArgs, args.length, e.callee.line, e.callee.col)
          checkByrefArgs(ctx, `「${name}」`, args, m.modes ?? [], e.callee.line, e.callee.col)
          checkArgTypes(ctx, `「${name}」`, m.params, args, env, e.callee.line, e.callee.col)
          return m.type
        }
        const p = objParts(recv)
        if (builtinMembers(recv) !== null) {
          unknownMember(ctx, recv, name, e.callee.line, e.callee.col)
          return null
        }
        if (p !== null) {
          const methods = findMethodsInObject(ctx, recv, name)
          let m: MemberSig | null
          if (methods.length > 1) {
            const chosen = chooseMethod(ctx, methods, e.args, argTypes, name, e.callee.line, e.callee.col)
            if (chosen === null) return null
            e.overload = chosen.index
            m = chosen.sig
          } else {
            e.overload = 0
            m = methods[0] ?? findInObject(ctx, recv, name)
          }
          if (m === null) {
            unknownMember(ctx, recv, name, e.callee.line, e.callee.col)
            return null
          }
          if (m.kind !== 'method') {
            if (e.callee.nullSafe) {
              err(ctx, `「${name}」不是返回引用类型的方法，不能用 ?.`, e.callee.line, e.callee.col)
              return null
            }
            if (m.kind === 'field' && m.type.startsWith('委托:')) {
              const d = ctx.shapes.get(m.type.slice(3))
              if (d?.delegateParams !== undefined) {
                const args = arrange(ctx, `委托「${m.type.slice(3)}」`, e.args, d.delegateParamNames ?? [], [], e.callee.line, e.callee.col)
                if (args === null) return d.delegateRet ?? null
                checkArgs(ctx, `委托「${m.type.slice(3)}」`, d.delegateParams.length, d.delegateParams.length, args.length, e.callee.line, e.callee.col)
                checkArgTypes(ctx, `委托「${m.type.slice(3)}」`, d.delegateParams, args, env, e.callee.line, e.callee.col)
              }
              return d?.delegateRet ?? null
            }
            err(ctx, `「${name}」是${m.kind === 'field' ? '字段' : '属性'}，不是方法`, e.callee.line, e.callee.col)
            return null
          }
          if (e.callee.nullSafe && !isNullSafeResult(m.type)) {
            err(ctx, `「${name}」的返回值不能为空，不能用 ?.`, e.callee.line, e.callee.col)
            return null
          }
          const args = arrange(ctx, `「${name}」`, e.args, m.paramNames ?? [], m.defaults ?? [], e.callee.line, e.callee.col)
          if (args === null) return m.type
          checkArgs(ctx, `「${name}」`, m.minArgs, m.maxArgs, args.length, e.callee.line, e.callee.col)
          checkByrefArgs(ctx, `「${name}」`, args, m.modes ?? [], e.callee.line, e.callee.col)
          checkArgTypes(ctx, `「${name}」`, m.params, args, env, e.callee.line, e.callee.col)
          return m.type
        }
        return null
      }
      if (e.callee.kind === 'null') {
        err(ctx, '不能调用空值', e.callee.line, e.callee.col)
        return null
      }
      infer(e.callee, env, ctx, true)
      for (const a of e.args) infer(a, env, ctx)
      return null
    }
    case 'member': {
      const path = memberKey(e)
      if (path !== null) {
        const dot = path.lastIndexOf('.')
        const owner = path.slice(0, dot)
        const item = path.slice(dot + 1)
        const s = ctx.shapes.get(owner)
        if (s !== undefined && s.kind === 'enum') {
          if (s.enumItems.has(item)) return `枚举:${s.name}`
          unknownMember(ctx, `类型:${owner}`, item, e.line, e.col)
          return null
        }
      }
      if (e.nullSafe) {
        const recv = infer(e.target, env, ctx)
        if (recv === null) return null
        if (!recv.startsWith('类:') && !recv.startsWith('接口:') && !recv.startsWith('列表:') && !recv.startsWith('表:') && !recv.endsWith('[]') && recv !== '异常' && !recv.startsWith('异常:')) {
          err(ctx, '?. 左边必须是类、接口、列表、表或数组对象', e.line, e.col)
          return null
        }
        if (recv === '异常' || recv.startsWith('异常:')) {
          if (e.name === '信息' || e.name === '类型') return '文本'
          err(ctx, `异常没有成员「${e.name}」`, e.line, e.col)
          return null
        }
        if ((recv.startsWith('列表:') || recv.startsWith('表:')) && (e.name === '数量' || e.name === '长度')) return '整数'
        if (recv.endsWith('[]') && e.name === '长度') return '整数'
        const m = findInObject(ctx, recv, e.name)
        if (m === null) {
          unknownMember(ctx, recv, e.name, e.line, e.col)
          return null
        }
        if (!isNullSafeResult(m.type)) {
          err(ctx, `「${e.name}」的${m.kind === 'method' ? '返回值' : '类型'}不能为空，不能用 ?.`, e.line, e.col)
          return null
        }
        return m.type
      }
      const recv = infer(e.target, env, ctx)
      if (recv === null) return null
      if (e.target.kind === 'name' && ctx.nullVars.has(e.target.name)) {
        err(ctx, `变量「${e.target.name}」可能为 空，不能用 . 访问`, e.line, e.col, '先判断空引用，或改用 ?.')
        return null
      }
      if (e.target.kind === 'call' && definitelyNull(e.target, ctx)) {
        err(ctx, '表达式可能为 空，不能用 . 访问', e.line, e.col, '先判断空引用，或改用 ?.')
        return null
      }
      if (e.target.kind === 'null') {
        err(ctx, '不能用 . 访问空值', e.line, e.col, '先判断空引用，或改用 ?.')
        return null
      }
      if (!e.nullSafe && e.target.kind === 'member') {
        const key = memberKey(e.target)
        if (key !== null && ctx.nullFields.has(key)) {
          err(ctx, `字段「${key}」可能为 空，不能用 . 访问`, e.line, e.col, '先判断空引用，或改用 ?.')
          return null
        }
      }
      if (recv.startsWith('类型:')) {
        const typeName = recv.slice(3)
        const s = ctx.shapes.get(typeName)
        if (s === undefined) return null
        if (s.kind === 'enum') {
          if (s.enumItems.has(e.name)) return `枚举:${typeName}`
          unknownMember(ctx, recv, e.name, e.line, e.col)
          return null
        }
        const m = findInObject(ctx, `${s.kind === 'class' ? '类' : '结构'}:${typeName}`, e.name)
        if (m === null) {
          unknownMember(ctx, recv, e.name, e.line, e.col)
          return null
        }
        if (!m.isStatic) {
          err(ctx, `「${e.name}」不是静态成员，不能通过类型名访问`, e.line, e.col)
          return null
        }
        if (m.kind === 'method' && !isCallee) {
          err(ctx, `「${e.name}」是方法，需要写成 ${e.name}(...)`, e.line, e.col, '补上括号并传入参数')
          return null
        }
        return m.type
      }
      const b = builtinMember(recv, e.name)
      if (b !== null) {
        if (b.kind === 'method' && !isCallee) {
          err(ctx, `「${e.name}」是方法，需要写成 ${e.name}(...)`, e.line, e.col, '补上括号并传入参数')
          return null
        }
        return b.type
      }
      if (recv.startsWith('枚举:')) {
        unknownMember(ctx, recv, e.name, e.line, e.col)
        return null
      }
      if (builtinMembers(recv) !== null) {
        unknownMember(ctx, recv, e.name, e.line, e.col)
        return null
      }
      const p = objParts(recv)
      if (p !== null) {
        const m = findInObject(ctx, recv, e.name)
        if (m === null) {
          unknownMember(ctx, recv, e.name, e.line, e.col)
          return null
        }
        if (m.kind === 'prop' && m.isStatic) {
          err(ctx, `静态属性「${e.name}」要通过类型名访问`, e.line, e.col)
          return null
        }
        if (m.kind === 'method' && !isCallee) {
          err(ctx, `「${e.name}」是方法，需要写成 ${e.name}(...)`, e.line, e.col, '补上括号并传入参数')
          return null
        }
        return m.type
      }
      return null
    }
    case 'index': {
      const t = infer(e.target, env, ctx)
      infer(e.index, env, ctx)
      if (e.target.kind === 'name' && ctx.nullVars.has(e.target.name)) {
        err(ctx, `变量「${e.target.name}」可能为 空，不能用 [] 访问`, e.line, e.col, '先判断空引用')
        return null
      }
      if (e.target.kind === 'call' && definitelyNull(e.target, ctx)) {
        err(ctx, '表达式可能为 空，不能用 [] 访问', e.line, e.col, '先判断空引用')
        return null
      }
      if (e.target.kind === 'null') {
        err(ctx, '不能用 [] 访问空值', e.line, e.col, '先判断空引用')
        return null
      }
      return listElem(t ?? '') ?? (t !== null && t.startsWith('表:') ? t.slice(t.indexOf(':', 2) + 1) : null)
    }
    case 'new': {
      for (const a of e.args) infer(a, env, ctx)
      const t = resolveTypeRef(e.type, ctx.shapes)
      const p = t === null ? null : objParts(t)
      if (p !== null) {
        const s = ctx.shapes.get(p.name)
        if (s?.ctor !== undefined) {
          const args = arrange(ctx, `构造器「${p.name}」`, e.args, s.ctor.paramNames ?? [], s.ctor.defaults ?? [], e.line, e.col)
          if (args === null) return t
          checkArgs(ctx, `构造器「${p.name}」`, s.ctor.minArgs, s.ctor.maxArgs, args.length, e.line, e.col)
          checkByrefArgs(ctx, `构造器「${p.name}」`, args, s.ctor.modes ?? [], e.line, e.col)
          checkArgTypes(ctx, `构造器「${p.name}」`, s.ctor.params, args, env, e.line, e.col)
          checkRegionCtor(p.name, e.args, ctx)
        } else if (e.args.length > 0) err(ctx, `类型「${p.name}」没有构造器，不能传参数`, e.line, e.col)
      }
      return t
    }
    case 'array': {
      for (const el of e.elems) infer(el, env, ctx)
      return null
    }
    case 'lambda': {
      if (ctx.regionDepth > 0) {
        for (const name of lambdaRegionNames(e)) {
          if (ctx.regionVars.has(name)) {
            warn(ctx, `区域对象可能被 Lambda 捕获「${name}」`, e.line, e.col, 'Lambda 可能在区域结束后才执行')
            break
          }
        }
      }
      const inner = new Map(env)
      const paramTypes = e.params.map((p) => resolveTypeRef(p.type, ctx.shapes))
      if (paramTypes.some((t) => t === null)) return null
      e.params.forEach((p, i) => inner.set(p.name, paramTypes[i] as Ty))
      if (e.body.kind === 'block') {
        const collector: { type: Ty | null; bareAt?: { line: number; col: number } } = { type: null }
        const oldRet = ctx.retType
        const oldLambda = ctx.lambdaReturn
        ctx.retType = null
        ctx.lambdaReturn = collector
        withNullScope(ctx, () => checkStmt(e.body, inner, ctx))
        ctx.lambdaReturn = oldLambda
        ctx.retType = oldRet
        if (collector.bareAt !== undefined && collector.type !== null) {
          err(ctx, 'Lambda 有返回值时不能使用不带值的 返回', collector.bareAt.line, collector.bareAt.col)
        }
        const ret = collector.type ?? '无'
        e.retType = ret
        return `函数:${(paramTypes as Ty[]).join(',')}->${ret}`
      }
      let bodyType: Ty | null = null
      withNullScope(ctx, () => { bodyType = infer(e.body, inner, ctx) })
      if (bodyType === null) return null
      e.retType = bodyType
      return `函数:${(paramTypes as Ty[]).join(',')}->${bodyType}`
    }
    default: return null
  }
}

function arrange(ctx: Ctx, what: string, args: Expr[], names: string[], defaults: (Expr | null)[], line: number, col: number): Expr[] | null {
  const r = arrangeArguments(args, names, defaults)
  if (r.error !== undefined) {
    err(ctx, `${what}${r.error}`, line, col)
    return null
  }
  return r.args
}

function checkArgs(ctx: Ctx, what: string, min: number, max: number, got: number, line: number, col: number): void {
  if (got >= min && got <= max) return
  const need = min === max ? `${min}` : `${min} 到 ${max}`
  err(ctx, `${what}需要 ${need} 个参数，实际给了 ${got} 个`, line, col)
}

const INTEGER_TYPES = new Set([
  '字节', '有符号字节', '短整数', '无符号短整数',
  '整数', '无符号整数', '长整数', '无符号长整数', '字符',
])

function isInteger(t: Ty): boolean {
  return INTEGER_TYPES.has(t)
}

function isNumeric(t: Ty): boolean {
  return isInteger(t) || t === '浮点数' || t === '长小数'
}

function isObjectLike(t: Ty): boolean {
  return t.startsWith('类:') || t.startsWith('接口:') || t.startsWith('列表:') || t.startsWith('表:') || t.startsWith('委托:') || t.endsWith('[]') || t === '异常' || t.startsWith('异常:')
}

function isNullSafeResult(t: Ty): boolean {
  return t === '文本' || t.startsWith('类:') || t.startsWith('接口:') || t.startsWith('列表:') || t.startsWith('表:') || t.startsWith('委托:') || t === '异常' || t.startsWith('异常:') || t.endsWith('[]')
}

function isSubtype(ctx: Ctx, src: Ty, dst: Ty, seen = new Set<string>()): boolean {
  if (src === dst) return true
  if (dst === '任意') return true
  if (src === '任意') return false
  if (src.startsWith('函数:') && dst.startsWith('委托:')) {
    const shape = ctx.shapes.get(dst.slice(3))
    if (shape === undefined || shape.delegateParams === undefined || shape.delegateRet === undefined) return false
    const arrow = src.lastIndexOf('->')
    if (arrow < 3) return false
    const paramsText = src.slice(3, arrow)
    const params = paramsText === '' ? [] : paramsText.split(',')
    const ret = src.slice(arrow + 2)
    return ret === shape.delegateRet && params.length === shape.delegateParams.length &&
      params.every((p, i) => p === shape.delegateParams![i])
  }
  if (isNumeric(src) && isNumeric(dst)) return true
  if (src === '空') return isObjectLike(dst)
  if (isNumeric(src) || isNumeric(dst)) return false

  const sp = objParts(src)
  const dp = objParts(dst)
  if (sp === null || dp === null || seen.has(sp.name + '>' + dp.name)) return false
  seen.add(sp.name + '>' + dp.name)
  const shape = ctx.shapes.get(sp.name)
  if (shape === undefined) return false
  for (const b of shape.bases) {
    const bases = sp.kind === 'interface'
      ? [`接口:${b}`]
      : [`类:${b}`, `结构:${b}`, `接口:${b}`]
    for (const base of bases) {
      if (base === dst || isSubtype(ctx, base, dst, seen)) return true
    }
  }
  return false
}

function checkValue(ctx: Ctx, what: string, dst: Ty | null, src: Ty | null, line: number, col: number): void {
  if (dst === null || src === null) return
  if (dst === '?' || src === '?' || dst.includes('?') || src.includes('?')) return
  if (isSubtype(ctx, src, dst)) return
  err(ctx, `${what}的类型是「${src}」，不能当成「${dst}」使用`, line, col, '检查类型，或先用转换函数显式转换')
}

function checkArgTypes(ctx: Ctx, what: string, params: Ty[], args: Expr[], env: Map<string, Ty>, line: number, col: number): void {
  for (let i = 0; i < args.length && i < params.length; i++) {
    checkValue(ctx, `${what}第 ${i + 1} 个参数`, params[i], infer(args[i], env, ctx), args[i].line, args[i].col)
  }
}

function shapeTyOf(name: string, shapes: Map<string, Shape>): string {
  const s = shapes.get(name)
  if (s === undefined) return name
  const prefix = s.kind === 'class' ? '类' : s.kind === 'struct' ? '结构' : s.kind === 'interface' ? '接口' : s.kind === 'enum' ? '枚举' : '委托'
  return `${prefix}:${s.name}`
}

function satisfiesGenericConstraint(
  shapes: Map<string, Shape>, actual: string, constraint: TypeRef, seen: Set<string> = new Set(),
): boolean {
  const target = resolveTypeRef(constraint, shapes)
  if (target === null) return true
  if (actual === target) return true
  const parts = objParts(actual)
  if (parts === null || seen.has(parts.name)) return false
  seen.add(parts.name)
  const shape = shapes.get(parts.name)
  if (shape === undefined) return false
  return shape.bases.some((b) => satisfiesGenericConstraint(shapes, shapeTyOf(b, shapes), constraint, seen))
}

function typeRefLabel(t: TypeRef): string {
  return t.typeArgs.length === 0 ? t.name : `${t.name}<${t.typeArgs.map(typeRefLabel).join(',')}>`
}

function checkTypeRef(ctx: Ctx, t: TypeRef): void {
  if (t.kind === 'array') {
    checkTypeRef(ctx, t.elem)
    return
  }
  if (t.name === '任意') {
    err(ctx, `类型「${t.name}」还没有实现`, t.line, t.col, '当前可用的基本类型是 整数、长整数、字节、浮点数、长小数、文本、真假、无')
    return
  }
  for (const a of t.typeArgs) checkTypeRef(ctx, a)
  const shape = ctx.shapes.get(t.name)
  if (shape?.typeParams !== undefined && t.typeArgs.length > 0) {
    shape.typeParams.forEach((p, i) => {
      const constraints = shape.typeConstraints?.[p] ?? []
      if (constraints.length === 0 || i >= t.typeArgs.length) return
      const actual = resolveTypeRef(t.typeArgs[i], ctx.shapes)
      if (actual === null) return
      for (const constraint of constraints) {
        if (!satisfiesGenericConstraint(ctx.shapes, actual, constraint)) {
          err(ctx, `类型实参「${actual.replace(/^(类|结构|接口|枚举|委托):/, '')}」不满足泛型参数「${p}」的约束「${typeRefLabel(constraint)}」`, t.typeArgs[i].line, t.typeArgs[i].col)
          return
        }
      }
    })
  }
  if (t.name !== '表') return
  if (t.typeArgs.length < 2) {
    err(ctx, '表 需要两个类型参数：键类型和值类型', t.line, t.col)
    return
  }
  const k = resolveTypeRef(t.typeArgs[0], ctx.shapes)
  const v = resolveTypeRef(t.typeArgs[1], ctx.shapes)
  if (k !== null && k !== '文本' && k !== '真假' && !isInteger(k)) {
    err(ctx, `表的键只支持 文本、整数或真假类型，实际是「${k}」`, t.typeArgs[0].line, t.typeArgs[0].col)
  }
  const nested = v !== null && (v.startsWith('列表:') || v.startsWith('表:') || v.endsWith('[]'))
  if (v !== null && !nested && !isNumeric(v) && v !== '文本' && v !== '真假') {
    err(ctx, `表的值只支持基本类型、列表、表或数组，实际是「${v}」`, t.typeArgs[1].line, t.typeArgs[1].col)
  }
}

function isConstDefault(e: Expr, shapes: Map<string, Shape>): boolean {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'char':
    case 'bool':
    case 'null':
      return true
    case 'string':
      return e.segs.every((s) => s.kind === 'text')
    case 'unary':
      return (e.op === '+' || e.op === '-' || e.op === '!') && isConstDefault(e.operand, shapes)
    case 'binary':
      return !['=', '+=', '-=', '*=', '/=', '%=', '??='].includes(e.op) &&
        isConstDefault(e.left, shapes) && isConstDefault(e.right, shapes)
    case 'paren':
      return isConstDefault(e.expr, shapes)
    case 'cast':
      return isConstDefault(e.expr, shapes)
    case 'member':
      return e.target.kind === 'name' && shapes.get(e.target.name)?.kind === 'enum'
    default:
      return false
  }
}

function checkByrefArgs(ctx: Ctx, what: string, args: Expr[], modes: ('ref' | 'out' | null)[], line: number, col: number): void {
  args.forEach((a, i) => {
    const mode = modes[i] ?? null
    if (mode === null) {
      if (a.kind === 'byref') err(ctx, `${what} 的参数不是引用/输出参数`, a.line, a.col)
      return
    }
    const label = mode === 'ref' ? '引用' : '输出'
    if (a.kind !== 'byref') {
      err(ctx, `${what} 的第 ${i + 1} 个参数需要 ${label} 变量`, line, col)
      return
    }
    if (a.mode !== mode) {
      err(ctx, `${what} 的第 ${i + 1} 个参数需要 ${label}`, a.line, a.col)
      return
    }
    if (a.expr.kind !== 'name') {
      err(ctx, `${what} 的 ${label} 实参必须是变量`, a.line, a.col)
    }
  })
}

function paramsOf(params: Param[], ctx: Ctx): { params: Ty[]; paramNames: string[]; defaults: (Expr | null)[]; modes: ('ref' | 'out' | null)[]; minArgs: number; maxArgs: number } | null {
  let sawDefault = false
  for (const p of params) {
    checkTypeRef(ctx, p.type)
    if (p.mode !== undefined && p.def !== null) {
      err(ctx, '引用/输出参数不能有默认值', p.def.line, p.def.col)
    }
    if (p.mode !== undefined && p.type.kind === 'array') {
      err(ctx, '引用/输出暂不支持数组参数', p.type.line, p.type.col)
    }
    if (p.def !== null) {
      sawDefault = true
      if (!isConstDefault(p.def, ctx.shapes)) {
        err(ctx, '默认参数必须是常量表达式', p.def.line, p.def.col, '默认值不能引用参数、局部变量或调用函数')
      }
    } else if (sawDefault) {
      err(ctx, '默认参数必须放在参数表末尾', p.type.line, p.type.col, '把没有默认值的参数放到前面')
    }
  }
  const types = params.map((p) => resolveTypeRef(p.type, ctx.shapes))
  if (types.some((t) => t === null)) return null
  params.forEach((p, i) => {
    if (p.def === null || types[i] === null) return
    const actual = infer(p.def, new Map(), ctx)
    if (actual !== null) checkValue(ctx, `参数「${p.name}」的默认值`, types[i], actual, p.def.line, p.def.col)
  })
  const firstDefault = params.findIndex((p) => p.def !== null)
  return {
    params: types as Ty[],
    paramNames: params.map((p) => p.name),
    defaults: params.map((p) => p.def),
    modes: params.map((p) => p.mode ?? null),
    minArgs: firstDefault < 0 ? params.length : firstDefault,
    maxArgs: params.length,
  }
}

function checkStmt(s: Stmt, env: Map<string, Ty>, ctx: Ctx): void {
  switch (s.kind) {
    case 'var': {
      checkTypeRef(ctx, s.type)
      const init = s.init === null ? null : infer(s.init, env, ctx)
      const declared = resolveTypeRef(s.type, ctx.shapes)
      if (declared !== null && init !== null) checkValue(ctx, `变量「${s.name}」`, declared, init, s.line, s.col)
      const t = declared ?? init
      if (t !== null) env.set(s.name, t)
      if (isNullTracked(t ?? undefined)) {
        if (s.init !== null && definitelyNull(s.init, ctx)) ctx.nullVars.add(s.name)
        else ctx.nullVars.delete(s.name)
      } else {
        ctx.nullVars.delete(s.name)
      }
      if (ctx.regionDepth > 0 && isRegionType(t ?? undefined)) ctx.regionVars.add(s.name)
      return
    }
    case 'expr': {
      infer(s.expr, env, ctx)
      return
    }
    case 'return': {
      if (ctx.lambdaReturn !== null) {
        const collector = ctx.lambdaReturn
        if (s.value === null) {
          collector.bareAt = { line: s.line, col: s.col }
          return
        }
        const value = infer(s.value, env, ctx)
        if (collector.type === null) collector.type = value
        else checkValue(ctx, 'Lambda 返回值', collector.type, value, s.line, s.col)
        if (ctx.regionDepth > 0 && isRegionValue(s.value, ctx)) {
          warn(ctx, '区域对象从区域返回', s.value.line, s.value.col, '区域结束时对象会失效；返回前先复制或改用移出区域')
        }
        return
      }
      if (ctx.retType === '无' && s.value !== null) {
        err(ctx, '这个函数没有返回值，不能返回一个值', s.line, s.col)
        infer(s.value, env, ctx)
        return
      }
      const value = s.value === null ? null : infer(s.value, env, ctx)
      if (s.value !== null) checkValue(ctx, '返回值', ctx.retType, value, s.line, s.col)
      if (ctx.regionDepth > 0 && s.value !== null && isRegionValue(s.value, ctx)) {
        warn(ctx, '区域对象从区域返回', s.value.line, s.value.col, '区域结束时对象会失效；返回前先复制或改用移出区域')
      }
      return
    }
    case 'if': {
      const before = new Set(ctx.nullVars)
      const beforeFields = new Set(ctx.nullFields)
      infer(s.cond, env, ctx)
      const thenState = new Set(before)
      refineNull(s.cond, true, thenState, env)
      const elseState = new Set(before)
      refineNull(s.cond, false, elseState, env)
      const thenFields = new Set(beforeFields)
      refineNullFields(s.cond, true, thenFields)
      const elseFields = new Set(beforeFields)
      refineNullFields(s.cond, false, elseFields)
      ctx.nullVars = thenState
      ctx.nullFields = thenFields
      const regionThen = new Set(ctx.regionVars)
      checkStmt(s.then, new Map(env), ctx)
      restoreRegionVars(ctx, regionThen)
      const afterThen = new Set(ctx.nullVars)
      const afterThenFields = new Set(ctx.nullFields)
      restoreScoped(afterThen, before, directVarNames(s.then))
      ctx.nullVars = elseState
      ctx.nullFields = elseFields
      const regionElse = new Set(ctx.regionVars)
      if (s.els !== null) checkStmt(s.els, new Map(env), ctx)
      restoreRegionVars(ctx, regionElse)
      const afterElse = new Set(ctx.nullVars)
      const afterElseFields = new Set(ctx.nullFields)
      if (s.els !== null) restoreScoped(afterElse, before, directVarNames(s.els))
      ctx.nullVars = mergeNullStates(afterThen, afterElse)
      ctx.nullFields = mergeNullStates(afterThenFields, afterElseFields)
      return
    }
    case 'while': {
      const before = new Set(ctx.nullVars)
      infer(s.cond, env, ctx)
      const bodyState = new Set(ctx.nullVars)
      refineNull(s.cond, true, bodyState, env)
      const regionBefore = new Set(ctx.regionVars)
      const breaks = { loop: true, states: [] as Set<string>[] }
      ctx.breakStack.push(breaks)
      ctx.nullVars = bodyState
      checkStmt(s.body, new Map(env), ctx)
      ctx.breakStack.pop()
      restoreRegionVars(ctx, regionBefore)
      let after = new Set(before)
      addNullAfterLoop(s.cond, after, env)
      for (const st of breaks.states) after = mergeNullStates(after, st)
      ctx.nullVars = after
      return
    }
    case 'dowhile': {
      const before = new Set(ctx.nullVars)
      const regionBefore = new Set(ctx.regionVars)
      const breaks = { loop: true, states: [] as Set<string>[] }
      ctx.breakStack.push(breaks)
      checkStmt(s.body, new Map(env), ctx)
      ctx.breakStack.pop()
      restoreRegionVars(ctx, regionBefore)
      infer(s.cond, env, ctx)
      let after = new Set(before)
      addNullAfterLoop(s.cond, after, env)
      for (const st of breaks.states) after = mergeNullStates(after, st)
      ctx.nullVars = after
      return
    }
    case 'for': {
      const before = new Set(ctx.nullVars)
      const regionBefore = new Set(ctx.regionVars)
      const inner = new Map(env)
      if (s.init !== null) checkStmt(s.init, inner, ctx)
      const bodyState = new Set(ctx.nullVars)
      if (s.cond !== null) {
        infer(s.cond, inner, ctx)
        refineNull(s.cond, true, bodyState, inner)
      }
      for (const st of s.step) infer(st, inner, ctx)
      const breaks = { loop: true, states: [] as Set<string>[] }
      ctx.breakStack.push(breaks)
      ctx.nullVars = bodyState
      checkStmt(s.body, new Map(inner), ctx)
      ctx.breakStack.pop()
      restoreRegionVars(ctx, regionBefore)
      let after = new Set(before)
      if (s.cond !== null) addNullAfterLoop(s.cond, after, inner)
      for (const st of breaks.states) after = mergeNullStates(after, st)
      ctx.nullVars = after
      return
    }
    case 'foreach': {
      const before = new Set(ctx.nullVars)
      const regionBefore = new Set(ctx.regionVars)
      const it = infer(s.iter, env, ctx)
      const inner = new Map(env)
      if (s.elemType !== null) checkTypeRef(ctx, s.elemType)
      const elem = resolveTypeRef(s.elemType ?? { kind: 'named', name: '整数', typeArgs: [], line: s.line, col: s.col }, ctx.shapes) ?? listElem(it ?? '')
      if (elem !== null) inner.set(s.name, elem)
      if (ctx.regionDepth > 0 && isRegionType(elem ?? undefined)) ctx.regionVars.add(s.name)
      checkStmt(s.body, inner, ctx)
      restoreRegionVars(ctx, regionBefore)
      ctx.nullVars = before
      return
    }
    case 'switch': {
      const before = new Set(ctx.nullVars)
      infer(s.subject, env, ctx)
      const states: Set<string>[] = []
      ctx.breakStack.push({ loop: false, states: [] })
      for (const c of s.clauses) {
        ctx.nullVars = new Set(before)
        const regionBefore = new Set(ctx.regionVars)
        if (c.label !== null) infer(c.label, env, ctx)
        checkStmt({ kind: 'block', stmts: c.stmts, line: c.line, col: c.col }, new Map(env), ctx)
        restoreRegionVars(ctx, regionBefore)
        states.push(new Set(ctx.nullVars))
      }
      ctx.breakStack.pop()
      ctx.nullVars = states.length === 0 ? before : states.reduce(mergeNullStates)
      return
    }
    case 'break': {
      const top = ctx.breakStack[ctx.breakStack.length - 1]
      if (top !== undefined) top.states.push(new Set(ctx.nullVars))
      return
    }
    case 'throw': infer(s.value, env, ctx); return
    case 'try': {
      const before = new Set(ctx.nullVars)
      ctx.nullVars = new Set(before)
      checkStmt(s.body, new Map(env), ctx)
      const states: Set<string>[] = [new Set(ctx.nullVars)]
      for (const c of s.catches) {
        ctx.nullVars = new Set(before)
        const inner = new Map(env)
        checkTypeRef(ctx, c.type)
        const t = resolveTypeRef(c.type, ctx.shapes)
        if (t !== null) inner.set(c.name, t)
        if (c.filter) {
          const ft = infer(c.filter, inner, ctx)
          if (ft !== '真假') err(ctx, '捕获 的过滤条件必须是真假值', c.filter.line, c.filter.col)
        }
        checkStmt(c.body, inner, ctx)
        restoreScoped(ctx.nullVars, before, [c.name])
        states.push(new Set(ctx.nullVars))
      }
      ctx.nullVars = states.reduce(mergeNullStates)
      if (s.fin !== null) checkStmt(s.fin, new Map(env), ctx)
      return
    }
    case 'block': {
      const before = new Set(ctx.nullVars)
      const regionBefore = new Set(ctx.regionVars)
      const inner = new Map(env)
      for (const st of s.stmts) checkStmt(st, inner, ctx)
      restoreScoped(ctx.nullVars, before, directVarNames(s))
      restoreRegionVars(ctx, regionBefore)
      return
    }
    case 'region': {
      const before = new Set(ctx.regionVars)
      ctx.regionDepth++
      checkStmt(s.body, new Map(env), ctx)
      ctx.regionDepth--
      restoreRegionVars(ctx, before)
      return
    }
    case 'using': {
      const t = infer(s.target, env, ctx)
      const o = objParts(t)
      if (o === null || o.kind !== 'class') {
        err(ctx, '使用 的目标必须是类对象', s.target.line, s.target.col, '使用 只用于带 关闭() 方法的类')
      } else {
        const m = methodOf(ctx.shapes, o.name, '关闭')
        if (m === null) {
          err(ctx, `类「${o.name}」没有 关闭 方法，不能用于 使用`, s.target.line, s.target.col, '给类加一个无参 关闭() 方法')
        } else if (m.isStatic) {
          err(ctx, '使用 不能调用静态 关闭 方法', s.target.line, s.target.col)
        } else if (m.params.length !== 0) {
          err(ctx, '关闭 方法不能带参数', s.target.line, s.target.col)
        }
      }
      checkStmt(s.body, new Map(env), ctx)
      return
    }
    case 'localFunc': {
      const sig = paramsOf(s.params, ctx)
      const ret = resolveTypeRef(s.ret, ctx.shapes) ?? '无'
      if (sig !== null) addFnSig(ctx, s.name, { ...sig, ret })
      const inner = new Map(env)
      if (sig !== null) for (let i = 0; i < s.params.length; i++) inner.set(s.params[i].name, sig.params[i])
      const old = ctx.thisType
      const oldRet = ctx.retType
      const oldLambda = ctx.lambdaReturn
      ctx.retType = ret
      ctx.lambdaReturn = null
      withNullScope(ctx, () => {
        seedNullParams(s.params, ctx)
        const nullArgs = ctx.nullParams.get(s.name)
        if (nullArgs !== undefined) {
          for (const i of nullArgs) {
            const p = s.params[i]
            if (p !== undefined) ctx.nullVars.add(p.name)
          }
        }
        checkStmt(s.body, inner, ctx)
      })
      ctx.thisType = old
      ctx.retType = oldRet
      ctx.lambdaReturn = oldLambda
      return
    }
    default: return
  }
}

function seedNullParams(params: Param[], ctx: Ctx): void {
  for (const p of params) {
    if (p.def !== null && definitelyNull(p.def, ctx)) ctx.nullVars.add(p.name)
  }
}

function checkMemberModifiers(m: Member, ctx: Ctx): void {
  const mods = m.modifiers ?? []
  const access = mods.filter((x) => x === '公开' || x === '私有' || x === '保护' || x === '内部')
  if (access.length > 1) {
    err(ctx, `成员「${m.name}」只能有一个访问修饰符`, m.line, m.col, '公开、私有、保护和内部只能选一个')
  }
  if (mods.includes('密封')) {
    err(ctx, `成员「${m.name}」不能使用 密封`, m.line, m.col, '密封只能用于类')
  }
  if (m.kind !== 'field' && mods.includes('常')) {
    err(ctx, `成员「${m.name}」的 常 只能用于字段`, m.line, m.col)
  }
  if (m.kind !== 'field' && m.kind !== 'prop' && mods.includes('只读')) {
    err(ctx, `成员「${m.name}」的 只读 只能用于字段或属性`, m.line, m.col)
  }
  if (m.kind !== 'method' && (mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象'))) {
    err(ctx, `成员「${m.name}」的 虚拟/覆盖/抽象 只能用于方法`, m.line, m.col)
  }
  if (m.kind === 'ctor' && mods.some((x) => x !== '公开' && x !== '私有' && x !== '保护' && x !== '内部')) {
    err(ctx, `构造器「${m.name}」只能使用访问修饰符`, m.line, m.col)
  }
  if (m.kind === 'method' && mods.includes('静态') && (mods.includes('虚拟') || mods.includes('覆盖') || mods.includes('抽象'))) {
    err(ctx, `静态方法「${m.name}」不能是虚拟、覆盖或抽象方法`, m.line, m.col)
  }
  if (m.kind === 'method' && mods.includes('抽象') && mods.includes('私有')) {
    err(ctx, `抽象方法「${m.name}」不能是私有方法`, m.line, m.col)
  }
  if (m.kind === 'prop' && mods.includes('只读') && m.accessors.some((a) => a.kind === 'set')) {
    err(ctx, `只读属性「${m.name}」不能有 写 访问器`, m.line, m.col)
  }
}

function constantKind(e: Expr): 'num' | 'text' | 'bool' | 'char' | null {
  switch (e.kind) {
    case 'int': case 'float': return 'num'
    case 'char': return 'char'
    case 'string': return e.segs.every((seg) => seg.kind === 'text') ? 'text' : null
    case 'bool': return 'bool'
    case 'paren': return constantKind(e.expr)
    case 'unary': {
      const k = constantKind(e.operand)
      if (k === null) return null
      if (e.op === '!') return k === 'bool' ? 'bool' : null
      if (e.op === '-' || e.op === '+') return k === 'num' || k === 'char' ? k : null
      return null
    }
    case 'binary': {
      const l = constantKind(e.left)
      const r = constantKind(e.right)
      if (l === null || r === null) return null
      if (e.op === '&&' || e.op === '||' || e.op === '且' || e.op === '或') {
        return l === 'bool' && r === 'bool' ? 'bool' : null
      }
      if (['==', '!=', '<', '<=', '>', '>='].includes(e.op)) return 'bool'
      if (['+', '-', '*', '/', '%'].includes(e.op)) {
        return l === 'text' || r === 'text' ? null : 'num'
      }
      return null
    }
    default: return null
  }
}

function checkConstField(m: Extract<Member, { kind: 'field' }>, ctx: Ctx): void {
  if (m.init === null) {
    err(ctx, `常字段「${m.name}」必须在声明处初始化`, m.line, m.col)
    return
  }
  const kind = constantKind(m.init)
  if (kind === null) {
    err(ctx, `常字段「${m.name}」的初始值必须是编译期常量`, m.init.line, m.init.col, '可以使用字面量、括号和常量运算')
    return
  }
  const t = resolveTypeRef(m.type, ctx.shapes)
  if (t === null) return
  const ok = t === '文本'
    ? kind === 'text'
    : t === '真假'
      ? kind === 'bool'
      : t === '字符'
        ? kind === 'char'
        : isNumeric(t) && (kind === 'num' || kind === 'char')
  if (!ok) {
    err(ctx, `常字段「${m.name}」的初始值类型与字段类型「${t}」不匹配`, m.init.line, m.init.col)
  }
}


function constFieldOf(target: Expr, env: Map<string, Ty>, ctx: Ctx): string | null {
  if (target.kind === 'name') {
    if (ctx.thisType !== null) {
      const p = objParts(ctx.thisType)
      if (p !== null) {
        const f = ctx.shapes.get(p.name)?.fields.get(target.name)
        if (f?.isConst === true) return target.name
      }
    }
    const s = ctx.shapes.get(target.name)
    if (s !== undefined) {
      for (const [name, f] of s.fields) if (f.isConst === true) return name
    }
    return null
  }
  if (target.kind !== 'member') return null
  const t = infer(target.target, env, ctx)
  let shape: Shape | undefined
  if (t !== null && t.startsWith('类型:')) shape = ctx.shapes.get(t.slice(3))
  else if (t !== null) {
    const p = objParts(t)
    if (p !== null) shape = ctx.shapes.get(p.name)
  }
  const f = shape?.fields.get(target.name)
  return f?.isConst === true ? target.name : null
}

function checkMemberDecl(m: Member, env: Map<string, Ty>, ctx: Ctx): void {
  checkMemberModifiers(m, ctx)
  if (m.kind === 'field') {
    checkTypeRef(ctx, m.type)
    if (m.init !== null) infer(m.init, env, ctx)
    if (m.modifiers.includes('常')) checkConstField(m, ctx)
  } else if (m.kind === 'prop') {
    checkTypeRef(ctx, m.type)
    const oldThis = ctx.thisType
    if (m.modifiers.includes('静态')) ctx.thisType = null
    for (const a of m.accessors) withNullScope(ctx, () => checkStmt(a.body, new Map(env), ctx))
    ctx.thisType = oldThis
  } else if (m.kind === 'method' || m.kind === 'ctor') {
    const inner = new Map(env)
    const sig = paramsOf(m.params, ctx)
    if (sig !== null) for (let i = 0; i < m.params.length; i++) inner.set(m.params[i].name, sig.params[i])
    const oldRet = ctx.retType
    ctx.retType = m.kind === 'method' ? resolveTypeRef(m.ret, ctx.shapes) : null
    if (m.kind === 'method') checkTypeRef(ctx, m.ret)
    if (m.body !== null) {
      withNullScope(ctx, () => {
        seedNullParams(m.params, ctx)
        if (m.kind === 'method') {
          const nullArgs = ctx.nullParams.get(`方法:${m.name}`)
          if (nullArgs !== undefined) {
            for (const i of nullArgs) {
              const p = m.params[i]
              if (p !== undefined) ctx.nullVars.add(p.name)
            }
          }
        }
        checkStmt(m.body as Stmt, inner, ctx)
      })
    }
    ctx.retType = oldRet
  } else if (m.kind === 'ifaceMethod') {
    checkTypeRef(ctx, m.ret)
    paramsOf(m.params, ctx)
  } else if (m.kind === 'ifaceProp') {
    checkTypeRef(ctx, m.type)
  }
}

function checkDuplicateMembers(members: Member[], ctx: Ctx, kind: 'class' | 'struct' | 'interface'): void {
  const seen = new Map<string, Member>()
  for (const m of members) {
    const prev = seen.get(m.name)
    if (prev === undefined) {
      seen.set(m.name, m)
      continue
    }
    const bothMethods = (prev.kind === 'method' || prev.kind === 'ifaceMethod') && (m.kind === 'method' || m.kind === 'ifaceMethod')
    if (bothMethods) {
      if (kind === 'interface') {
        err(ctx, `接口方法「${m.name}」不能重载`, m.line, m.col)
        continue
      }
      const mods = [...(prev.kind === 'method' ? prev.modifiers : []), ...(m.kind === 'method' ? m.modifiers : [])]
      if (mods.some((x) => x === '虚拟' || x === '覆盖' || x === '抽象')) {
        err(ctx, `虚拟、覆盖或抽象方法「${m.name}」不能重载`, m.line, m.col)
        continue
      }
      const sigKeyOf = (x: Member): string => x.params.map((p) => resolveTypeRef(p.type, ctx.shapes) ?? '?').join('|')
      if (sigKeyOf(prev) === sigKeyOf(m)) {
        err(ctx, `方法「${m.name}」的重载签名重复`, m.line, m.col)
      }
      continue
    }
    err(ctx, `成员「${m.name}」重复定义`, m.line, m.col, '字段、属性和方法不能同名')
  }
}

function checkDecl(d: Decl, ctx: Ctx): void {
  if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'interface') checkDuplicateMembers(d.members, ctx, d.kind)
  if (d.kind === 'class' || d.kind === 'struct') {
    const p = objParts(`${d.kind === 'class' ? '类' : '结构'}:${d.name}`)
    if (p === null) return
    const s = ctx.shapes.get(d.name)
    if (s === undefined) return
    const env = new Map<string, Ty>()
    for (const [name, m] of s.fields) if (!m.isStatic) env.set(name, m.type)
    for (const [name, m] of s.props) env.set(name, m.type)
    const old = ctx.thisType
    ctx.thisType = `${d.kind === 'class' ? '类' : '结构'}:${d.name}`
    for (const m of d.members) checkMemberDecl(m, env, ctx)
    ctx.thisType = old
  } else if (d.kind === 'interface') {
    const old = ctx.thisType
    ctx.thisType = `接口:${d.name}`
    for (const m of d.members) checkMemberDecl(m, new Map(), ctx)
    ctx.thisType = old
  } else if (d.kind === 'namespace') {
    for (const inner of d.decls) checkDecl(inner, ctx)
  } else if (d.kind === 'delegate') {
    for (const p of d.params) checkTypeRef(ctx, p.type)
    checkTypeRef(ctx, d.ret)
  }
}

export function checkSemantics(unit: CompilationUnit, extraDecls: Decl[] = [], extraFuncs: Stmt[] = [], regionUnit: CompilationUnit = unit): Diagnostic[] {
  const analysisUnit: CompilationUnit = {
    usings: unit.usings,
    stmts: [...regionUnit.stmts, ...unit.stmts.filter((s) => !regionUnit.stmts.includes(s))],
    decls: [...regionUnit.decls, ...unit.decls.filter((d) => !regionUnit.decls.includes(d))],
  }
  const ctx: Ctx = {
    diags: [], reported: new Set(),
    shapes: collectShapes([...extraDecls, ...unit.decls]),
    funcs: new Map(),
    thisType: null,
    retType: null,
    nullVars: new Set(),
    nullFields: new Set(),
    nullReturns: collectNullReturns(analysisUnit),
    nullParams: collectNullArgs(analysisUnit),
    regionDepth: 0,
    regionVars: new Set(),
    regionEffects: collectRegionEffects(regionUnit),
    lambdaReturn: null,
    breakStack: [],
  }
  const seenFuncs = new Map<string, { line: number; col: number; keys: string[]; hasDefaults: boolean }>()
  const allStmts = [...extraFuncs, ...unit.stmts.filter((s) => !extraFuncs.includes(s))]
  for (const s of allStmts) {
    if (s.kind !== 'localFunc') continue
    const sig = paramsOf(s.params, ctx)
    if (sig === null) continue
    const key = sigKey(sig)
    const prev = seenFuncs.get(s.name)
    if (prev !== undefined && prev.keys.includes(key)) {
      err(ctx, `函数「${s.name}」重复定义`, s.line, s.col, '参数类型和参数个数都相同')
      continue
    }
    if (prev !== undefined) {
      prev.keys.push(key)
    } else {
      seenFuncs.set(s.name, { line: s.line, col: s.col, keys: [key], hasDefaults: sig.defaults.some((d) => d !== null) })
    }
    addFnSig(ctx, s.name, { ...sig, ret: resolveTypeRef(s.ret, ctx.shapes) ?? '无' })
  }
  const top = new Map<string, Ty>()
  for (const s of unit.stmts) checkStmt(s, top, ctx)
  for (const d of unit.decls) checkDecl(d, ctx)
  return ctx.diags
}
