// Csay 抽象语法树。与 docs/EBNF与词法-v1.md 一一对应。
// 约定：每个节点都带 line/col（1 基），便于报错定位。

export interface Base {
  line: number
  col: number
}

export type Modifier =
  | '公开' | '私有' | '保护' | '内部'
  | '静态' | '只读' | '抽象' | '虚拟' | '覆盖' | '常'

// ---------------- 类型引用 ----------------

export type TypeRef =
  | (Base & { kind: 'named'; name: string; typeArgs: TypeRef[] })
  | (Base & { kind: 'array'; elem: TypeRef })

// ---------------- 表达式 ----------------

export type StringSeg =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; expr: Expr }

export type Expr =
  | (Base & { kind: 'int'; text: string })
  | (Base & { kind: 'float'; text: string })
  | (Base & { kind: 'char'; value: number })
  | (Base & { kind: 'string'; interpolated: boolean; segs: StringSeg[] })
  | (Base & { kind: 'bool'; value: boolean })
  | (Base & { kind: 'null' })
  | (Base & { kind: 'name'; name: string })
  | (Base & { kind: 'this' })
  | (Base & { kind: 'base' })
  | (Base & { kind: 'value' })
  | (Base & { kind: 'binary'; op: string; left: Expr; right: Expr })
  | (Base & { kind: 'unary'; op: string; operand: Expr })
  | (Base & { kind: 'postfix'; op: string; operand: Expr })
  | (Base & { kind: 'assign'; op: string; target: Expr; value: Expr })
  | (Base & { kind: 'cond'; cond: Expr; then: Expr; else: Expr })
  | (Base & { kind: 'call'; callee: Expr; args: Expr[]; overload?: number })
  | (Base & { kind: 'named'; name: string; value: Expr })
  | (Base & { kind: 'byref'; mode: 'ref' | 'out'; expr: Expr })
  | (Base & { kind: 'member'; target: Expr; name: string; nullSafe?: boolean })
  | (Base & { kind: 'index'; target: Expr; index: Expr })
  | (Base & { kind: 'new'; type: TypeRef; args: Expr[] })
  | (Base & { kind: 'cast'; type: TypeRef; expr: Expr })
  | (Base & { kind: 'array'; elems: Expr[] })
  | (Base & { kind: 'paren'; expr: Expr })
  /** 无捕获的 Lambda：参数类型必须显式写出 */
  | (Base & { kind: 'lambda'; params: Param[]; body: Expr | Stmt; retType?: string })

// ---------------- 语句 ----------------

export interface Param {
  type: TypeRef
  name: string
  def: Expr | null
  mode?: 'ref' | 'out'
}

export interface CaseClause {
  /** null 表示 默认 */
  label: Expr | null
  stmts: Stmt[]
  line: number
  col: number
}

export interface CatchClause {
  type: TypeRef
  name: string
  body: Stmt
  filter?: Expr | null
}

export type Stmt =
  | (Base & { kind: 'block'; stmts: Stmt[] })
  | (Base & { kind: 'var'; type: TypeRef; name: string; init: Expr | null })
  | (Base & { kind: 'expr'; expr: Expr })
  | (Base & { kind: 'if'; cond: Expr; then: Stmt; els: Stmt | null })
  | (Base & { kind: 'while'; cond: Expr; body: Stmt })
  | (Base & { kind: 'dowhile'; body: Stmt; cond: Expr })
  | (Base & { kind: 'for'; init: Stmt | null; cond: Expr | null; step: Expr[]; body: Stmt })
  | (Base & { kind: 'foreach'; elemType: TypeRef | null; name: string; iter: Expr; body: Stmt })
  | (Base & { kind: 'switch'; subject: Expr; clauses: CaseClause[] })
  | (Base & { kind: 'return'; value: Expr | null })
  | (Base & { kind: 'break' })
  | (Base & { kind: 'continue' })
  | (Base & { kind: 'throw'; value: Expr })
  | (Base & { kind: 'try'; body: Stmt; catches: CatchClause[]; fin: Stmt | null })
  /** 区域块：块内所有堆分配在离开时整块回收 */
  | (Base & { kind: 'region'; body: Stmt })
  /** 使用块：离开时调用目标对象的 关闭()，异常路径也会关闭 */
  | (Base & { kind: 'using'; target: Expr; body: Stmt })
  | (Base & { kind: 'localFunc'; ret: TypeRef; name: string; params: Param[]; body: Stmt })
  | (Base & { kind: 'empty' })

// ---------------- 成员 ----------------

export interface Accessor {
  kind: 'get' | 'set'
  body: Stmt
}

export type Member =
  | (Base & { kind: 'field'; modifiers: Modifier[]; type: TypeRef; name: string; init: Expr | null })
  | (Base & { kind: 'method'; modifiers: Modifier[]; ret: TypeRef; name: string; params: Param[]; body: Stmt | null; exprBody?: Expr | null })
  | (Base & { kind: 'ctor'; modifiers: Modifier[]; name: string; params: Param[]; baseArgs: Expr[] | null; body: Stmt; exprBody?: Expr | null })
  | (Base & { kind: 'prop'; modifiers: Modifier[]; type: TypeRef; name: string; accessors: Accessor[]; exprBody?: Expr | null })
  | (Base & { kind: 'ifaceMethod'; ret: TypeRef; name: string; params: Param[] })
  | (Base & { kind: 'ifaceProp'; type: TypeRef; name: string; hasGet: boolean; hasSet: boolean })

// ---------------- 顶层声明 ----------------

export interface EnumItem {
  name: string
  value: Expr | null
  line: number
  col: number
}

export type Decl =
  | (Base & { kind: 'class' | 'struct'; modifiers: Modifier[]; name: string; typeParams?: string[]; typeConstraints?: Record<string, TypeRef[]>; bases: TypeRef[]; members: Member[] })
  | (Base & { kind: 'interface'; modifiers: Modifier[]; name: string; typeParams?: string[]; typeConstraints?: Record<string, TypeRef[]>; bases: TypeRef[]; members: Member[] })
  | (Base & { kind: 'enum'; modifiers: Modifier[]; name: string; items: EnumItem[] })
  | (Base & { kind: 'delegate'; modifiers: Modifier[]; name: string; params: Param[]; ret: TypeRef })
  | (Base & { kind: 'namespace'; name: string; decls: Decl[] })

export interface CompilationUnit {
  usings: string[]
  /** 顶层语句：编译时自动包进隐式 主()，对应 C# 9 的 top-level statements */
  stmts: Stmt[]
  decls: Decl[]
}

/** 用于往返比对：去掉所有位置信息 */
export function stripPositions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPositions)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'line' || k === 'col') continue
    out[k] = stripPositions(v)
  }
  return out
}
