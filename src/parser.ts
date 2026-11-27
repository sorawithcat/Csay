// Csay 递归下降解析器。文法见 docs/EBNF与词法-v1.md。
// 整体 LL(2)：只有「语句开头是标识符」这一处需要看两个 token 判断是不是变量声明。

import { tokenize } from './lexer.ts'
import type { Token, Diagnostic } from './token.ts'
import type {
  CompilationUnit, Decl, Member, Stmt, Expr, TypeRef, Param, Modifier,
  Accessor, CaseClause, CatchClause, EnumItem, StringSeg,
} from './ast.ts'

const PRIMITIVE_TYPES = new Set([
  '字节', '有符号字节', '短整数', '无符号短整数',
  '整数', '无符号整数', '长整数', '无符号长整数',
  '浮点数', '长小数', '文本', '字符', '真假', '无',
])
const MODIFIERS = new Set<Modifier>([
  '公开', '私有', '保护', '内部', '静态', '只读', '抽象', '虚拟', '覆盖', '常', '密封',
])
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%='])

export class ParseError extends Error {
  diag: Diagnostic
  constructor(diag: Diagnostic) {
    super(diag.message)
    this.diag = diag
  }
}

const EOF: Token = { kind: 'eof', text: '', line: 0, col: 0 }

export class Parser {
  private tokens: Token[]
  private pos = 0
  private diags: Diagnostic[]
  /** 嵌套深度：在属性 写 { } 里大于 0，此时「值」代表被赋的新值 */
  private valueDepth = 0

  constructor(tokens: Token[], diags: Diagnostic[] = []) {
    this.tokens = tokens
    this.diags = diags
  }

  // ---------- 基础 ----------

  private peek(k = 0): Token {
    const i = this.pos + k
    return i < this.tokens.length ? this.tokens[i] : EOF
  }

  private at(text: string): boolean {
    return this.peek().text === text && this.peek().kind !== 'eof'
  }

  private atEof(): boolean {
    return this.peek().kind === 'eof'
  }

  private next(): Token {
    const t = this.peek()
    if (t.kind !== 'eof') this.pos++
    return t
  }

  private eat(text: string): boolean {
    if (this.at(text)) {
      this.pos++
      return true
    }
    return false
  }

  private err(message: string, hint?: string): ParseError {
    const t = this.peek()
    const diag: Diagnostic = {
      severity: 'error',
      line: t.line,
      col: t.col,
      message,
      hint,
    }
    this.diags.push(diag)
    return new ParseError(diag)
  }

  private endStmt(): void {
    /* 分号可选：写了就消费，没写就当语句结束。中文场景下省去切换输入法。 */
    if (this.at(';')) this.next()
  }

  private expect(text: string, what: string): Token {
    if (this.at(text)) return this.next()
    const t = this.peek()
    const found = t.kind === 'eof' ? '文件结尾' : `「${t.text}」`
    throw this.err(`这里需要${what}，但读到的是${found}`, `请补上 ${text}`)
  }

  private expectIdent(what: string): string {
    const t = this.peek()
    if (t.kind === 'ident') {
      this.next()
      return t.text
    }
    if (t.kind === 'keyword') {
      throw this.err(`「${t.text}」是保留字，不能当${what}用`,
        `换一个名字，比如「${what}1」`)
    }
    throw this.err(`这里需要一个${what}，但读到的是「${t.text}」`)
  }

  private parseQualifiedName(): string {
    let name = this.expectIdent('名字')
    while (this.at('.') && this.peek(1).kind === 'ident') {
      this.next()
      name += '.' + this.next().text
    }
    return name
  }

  // ---------- 编译单元 ----------

  parseUnit(): CompilationUnit {
    const usings: string[] = []
    while (this.at('引')) {
      this.next()
      if (this.peek().kind === 'string') {
        const t = this.next()
        const text = t.segments?.find((x) => x.kind === 'text')
        if (t.segments?.some((x) => x.kind === 'expr') || text === undefined || text.kind !== 'text') {
          throw this.err('引 后面的路径不能包含插值', '写固定的文件名，例如 引 "工具.csay"')
        }
        usings.push(text.text)
      } else usings.push(this.parseQualifiedName())
      this.endStmt()
    }

    // 顶层语句和类型声明可以交错；编译时顶层语句仍会被包进隐式 主()。
    const stmts: Stmt[] = []
    const decls: Decl[] = []
    while (!this.atEof()) {
      if (this.at('命名空间')) {
        decls.push(this.parseNamespace())
      } else if (this.isDeclStart()) {
        decls.push(this.parseDecl())
      } else {
        stmts.push(this.parseStmt())
      }
    }
    return { usings, stmts, decls }
  }

  /** 顶层是否已进入类型声明区 */
  private isDeclStart(): boolean {
    const t = this.peek()
    if (t.text === '命名空间' || t.text === '类' || t.text === '结构' || t.text === '接口' || t.text === '枚举' || t.text === '委托') {
      return true
    }
    return t.kind === 'keyword' && MODIFIERS.has(t.text as Modifier)
  }

  private parseNamespace(): Decl {
    const t = this.next()
    const name = this.parseQualifiedName()
    this.expect('{', '左花括号「{」')
    const decls: Decl[] = []
    while (!this.at('}') && !this.atEof()) decls.push(this.parseDecl())
    this.expect('}', '右花括号「}」')
    return { kind: 'namespace', name, decls, line: t.line, col: t.col }
  }

  // ---------- 类型声明 ----------

  private parseModifiers(): Modifier[] {
    const out: Modifier[] = []
    for (;;) {
      const t = this.peek()
      if (t.kind !== 'keyword') break
      if (!MODIFIERS.has(t.text as Modifier)) break
      out.push(t.text as Modifier)
      this.next()
    }
    return out
  }

  private parseDecl(): Decl {
    const mods = this.parseModifiers()
    const t = this.peek()
    if (t.text === '命名空间') return this.parseNamespace()
    if (t.text === '类' || t.text === '结构' || t.text === '接口') {
      return this.parseClassLike(mods)
    }
    if (t.text === '枚举') return this.parseEnum(mods)
    if (t.text === '委托') return this.parseDelegate(mods)
    const found = t.kind === 'eof' ? '文件结尾' : `「${t.text}」`
    throw this.err(`这里应该是一个声明或语句，读到${found}`,
      '顶层语句和类型声明可以按任意顺序书写')
  }

  private parseDelegate(mods: Modifier[]): Decl {
    const kw = this.next()
    const name = this.expectIdent('委托名')
    this.expect('(', '委托名后面需要参数表')
    const params: Param[] = []
    if (!this.at(')')) {
      do {
        const type = this.parseType()
        params.push({ type, name: `p${params.length}`, def: null })
      } while (this.eat(','))
    }
    this.expect(')', '委托参数表少了一个右括号')
    this.expect(':', '委托声明需要返回类型')
    const ret = this.parseType()
    this.expect(';', '委托声明末尾需要分号')
    return { kind: 'delegate', modifiers: mods, name, params, ret, line: kw.line, col: kw.col }
  }

  private parseClassLike(mods: Modifier[]): Decl {
    const kw = this.next()
    const kind = kw.text === '类' ? 'class' : kw.text === '结构' ? 'struct' : 'interface'
    const name = this.expectIdent('类型名')
    const typeParams: string[] = []
    const typeConstraints: Record<string, TypeRef[]> = {}
    if (this.eat('<')) {
      do {
        const p = this.expectIdent('类型参数名')
        typeParams.push(p)
        if (this.eat(':')) {
          const cs = [this.parseType()]
          while (this.eat('&')) cs.push(this.parseType())
          typeConstraints[p] = cs
        }
      } while (this.eat(','))
      this.expect('>', '类型参数表少了一个右尖括号「>」')
    }
    const bases: TypeRef[] = []
    if (this.eat(':')) {
      do {
        bases.push(this.parseType())
      } while (this.eat(','))
    }
    this.expect('{', '左花括号「{」')
    const members: Member[] = []
    while (!this.at('}') && !this.atEof()) {
      members.push(this.parseMember(kind, name))
    }
    this.expect('}', `「${name}」少了一个右花括号`)

    // 类没有写构造器时自动补一个无参构造，否则 新 类名() 会找不到
    if ((kind === 'class' || kind === 'struct') && !members.some((m) => m.kind === 'ctor')) {
      members.push({
        kind: 'ctor', modifiers: [], name,
        params: [], baseArgs: null,
        body: { kind: 'block', stmts: [], line: kw.line, col: kw.col },
        line: kw.line, col: kw.col,
      })
    }
    return {
      kind: kind as 'class' | 'struct' | 'interface',
      modifiers: mods, name, typeParams, typeConstraints, bases, members,
      line: kw.line, col: kw.col,
    }
  }

  private parseEnum(mods: Modifier[]): Decl {
    const kw = this.next()
    const name = this.expectIdent('枚举名')
    this.expect('{', '左花括号「{」')
    const items: EnumItem[] = []
    while (!this.at('}') && !this.atEof()) {
      const t = this.peek()
      const itemName = this.expectIdent('枚举成员名')
      let value: Expr | null = null
      if (this.eat('=')) value = this.parseExpr()
      items.push({ name: itemName, value, line: t.line, col: t.col })
      if (!this.eat(',')) break
    }
    this.expect('}', `枚举「${name}」少了一个右花括号`)
    return { kind: 'enum', modifiers: mods, name, items, line: kw.line, col: kw.col }
  }

  // ---------- 成员 ----------

  private parseMember(owner: 'class' | 'struct' | 'interface', className?: string): Member {
    if (owner === 'interface') return this.parseInterfaceMember()

    const mods = this.parseModifiers()
    const t = this.peek()

    // 名字后面直接是 (：可能是构造器（名字 = 类名），也可能是省略返回类型的方法
    if (t.kind === 'ident' && this.peek(1).text === '(') {
      const isCtor = className !== undefined && t.text === className
      const name = this.next().text
      const params = this.parseParamList()
      let baseArgs: Expr[] | null = null
      if (this.eat(':')) {
        if (!isCtor) throw this.err(`「${name}」不是构造器，只有与类同名的成员才能写「: 基(...)」`)
        if (this.at('基')) {
          this.next()
          this.expect('(', '左括号「(」')
          baseArgs = this.parseArgs()
          this.expect(')', '右括号「)」')
        } else {
          throw this.err('构造器后面只能写「: 基(...)」来调用父类构造器')
        }
      }
      let body: Stmt | null
      let exprBody: Expr | null = null
      if (mods.includes('抽象') && this.at(';')) {
        this.next()
        body = null
      } else if (this.at('=>')) {
        const eb = this.parseExpressionBody(null)
        body = eb.body
        exprBody = eb.expr
      } else {
        body = this.parseBlock()
      }
      if (mods.includes('抽象') && body !== null) throw this.err('抽象方法不能有方法体')
      if (isCtor) {
        return { kind: 'ctor', modifiers: mods, name, params, baseArgs, body, exprBody, line: t.line, col: t.col }
      }
      // 省略返回类型的方法：返回 无
      return {
        kind: 'method', modifiers: mods,
        ret: { kind: 'named', name: '无', typeArgs: [] },
        name, params, body, exprBody, line: t.line, col: t.col,
      }
    }

    const type = this.parseType()
    const name = this.expectIdent('成员名')

    if (this.at('(')) {
      const params = this.parseParamList()
      let body: Stmt | null
      let exprBody: Expr | null = null
      if (mods.includes('抽象') && this.at(';')) {
        this.next()
        body = null
      } else if (this.at('=>')) {
        const eb = this.parseExpressionBody(type)
        body = eb.body
        exprBody = eb.expr
      } else {
        body = this.parseBlock()
      }
      if (mods.includes('抽象') && body !== null) throw this.err('抽象方法不能有方法体')
      return { kind: 'method', modifiers: mods, ret: type, name, params, body, exprBody, line: t.line, col: t.col }
    }
    if (this.at('=>')) {
      const eb = this.parseExpressionBody(type)
      return {
        kind: 'prop', modifiers: mods, type, name,
        accessors: [{ kind: 'get', body: eb.body }], exprBody: eb.expr, line: t.line, col: t.col,
      }
    }
    if (this.at('{')) {
      const accessors = this.parseAccessors()
      return { kind: 'prop', modifiers: mods, type, name, accessors, line: t.line, col: t.col }
    }
    let init: Expr | null = null
    if (this.eat('=')) init = this.parseExpr()
    this.endStmt()
    return { kind: 'field', modifiers: mods, type, name, init, line: t.line, col: t.col }
  }

  private parseExpressionBody(type: TypeRef | null): { body: Stmt; expr: Expr } {
    this.expect('=>', '表达式体成员需要 =>')
    const expr = this.parseExpr()
    this.endStmt()
    const isVoid = type === null || (type.kind === 'named' && type.name === '无')
    const inner: Stmt = isVoid
      ? { kind: 'expr', expr, line: expr.line, col: expr.col }
      : { kind: 'return', value: expr, line: expr.line, col: expr.col }
    return { body: { kind: 'block', stmts: [inner], line: expr.line, col: expr.col }, expr }
  }

  private parseInterfaceMember(): Member {
    const t = this.peek()
    const type = this.parseType()
    const name = this.expectIdent('接口成员名')

    if (this.at('(')) {
      const params = this.parseParamList()
      this.endStmt()
      return { kind: 'ifaceMethod', ret: type, name, params, line: t.line, col: t.col }
    }
    this.expect('{', '左花括号「{」')
    let hasGet = false
    let hasSet = false
    if (this.eat('取')) {
      hasGet = true
      this.endStmt()
    }
    if (this.eat('写')) {
      hasSet = true
      this.endStmt()
    }
    if (!hasGet && !hasSet) {
      throw this.err('接口属性必须有 取 或 写')
    }
    this.expect('}', '右花括号「}」')
    return { kind: 'ifaceProp', type, name, hasGet, hasSet, line: t.line, col: t.col }
  }

  private parseAccessors(): Accessor[] {
    this.expect('{', '左花括号「{」')
    const out: Accessor[] = []
    while (!this.at('}') && !this.atEof()) {
      if (this.at('取')) {
        this.next()
        out.push({ kind: 'get', body: this.parseBlock() })
      } else if (this.at('写')) {
        this.next()
        this.valueDepth++
        const body = this.parseBlock()
        this.valueDepth--
        out.push({ kind: 'set', body })
      } else {
        throw this.err('属性里只能写 取 { } 或 写 { }',
          `读到的是「${this.peek().text}」`)
      }
    }
    this.expect('}', '属性少了一个右花括号')
    return out
  }

  private parseParamList(): Param[] {
    this.expect('(', '左括号「(」')
    const out: Param[] = []
    if (!this.at(')')) {
      do {
        let mode: 'ref' | 'out' | undefined
        if (this.at('引用') || this.at('输出')) {
          mode = this.next().text === '引用' ? 'ref' : 'out'
        }
        const type = this.parseType()
        const name = this.expectIdent('参数名')
        let def: Expr | null = null
        if (this.eat('=')) def = this.parseExpr()
        out.push({ type, name, def, mode })
      } while (this.eat(','))
    }
    this.expect(')', '参数表少了一个右括号')
    return out
  }

  // ---------- 类型 ----------

  parseType(): TypeRef {
    let t = this.parseNamedType()
    while (this.at('[') && this.peek(1).text === ']') {
      const line = this.peek().line
      const col = this.peek().col
      this.next()
      this.next()
      t = { kind: 'array', elem: t, line, col }
    }
    return t
  }

  private parseNamedType(): TypeRef {
    const t = this.peek()
    const isPrim = PRIMITIVE_TYPES.has(t.text)
    if (t.kind !== 'ident' && !isPrim) {
      const found = t.kind === 'eof' ? '文件结尾' : `「${t.text}」`
      throw this.err(`这里需要一个类型，但读到的是${found}`,
        '类型可以写 整数、长整数、字节、浮点数、长小数、文本、真假，或者你自己定义的类型名')
    }
    this.next()
    let name = t.text
    while (this.at('.') && this.peek(1).kind === 'ident') {
      this.next()
      name += '.' + this.next().text
    }
    const typeArgs: TypeRef[] = []
    if (this.at('<')) {
      this.next()
      do {
        typeArgs.push(this.parseType())
      } while (this.eat(','))
      this.expect('>', '泛型参数表少了一个右尖括号「>」')
    }
    return { kind: 'named', name, typeArgs, line: t.line, col: t.col }
  }

  // ---------- 语句 ----------

  parseBlock(): Stmt {
    const t = this.expect('{', '左花括号「{」')
    const stmts: Stmt[] = []
    while (!this.at('}') && !this.atEof()) stmts.push(this.parseStmt())
    this.expect('}', '这个块少了一个右花括号「}」')
    return { kind: 'block', stmts, line: t.line, col: t.col }
  }

  parseStmt(): Stmt {
    const t = this.peek()
    switch (t.text) {
      case '{': return this.parseBlock()
      case '若': return this.parseIf()
      case '只要': return this.parseWhile()
      case '做': return this.parseDoWhile()
      case '循环': return this.parseFor()
      case '遍历': return this.parseForEach()
      case '选择': return this.parseSwitch()
      case '试': return this.parseTry()
      case '区域': {
        this.next()
        const body = this.parseBlock()
        return { kind: 'region', body, line: t.line, col: t.col }
      }
      case '使用': {
        this.next()
        this.expect('(', '使用 后面要写 (资源)')
        const target = this.parseExpr()
        this.expect(')', '使用 的括号没有闭合')
        const body = this.parseBlock()
        return { kind: 'using', target, body, line: t.line, col: t.col }
      }
      case '返回': {
        this.next()
        let value: Expr | null = null
        if (!this.at(';')) value = this.parseExpr()
        this.endStmt()
        return { kind: 'return', value, line: t.line, col: t.col }
      }
      case '跳出': {
        this.next()
        this.endStmt()
        return { kind: 'break', line: t.line, col: t.col }
      }
      case '跳过': {
        this.next()
        this.endStmt()
        return { kind: 'continue', line: t.line, col: t.col }
      }
      case '抛出': {
        this.next()
        const value = this.parseExpr()
        this.endStmt()
        return { kind: 'throw', value, line: t.line, col: t.col }
      }
      case ';': {
        this.next()
        return { kind: 'empty', line: t.line, col: t.col }
      }
      default:
        break
    }
    if (this.looksLikeLocalFunc()) return this.parseLocalFunc()
    if (this.looksLikeVarDecl()) return this.parseVarDeclStmt()
    const expr = this.parseExpr()
    this.endStmt()
    return { kind: 'expr', expr, line: expr.line, col: expr.col }
  }

  /**
   * 判断语句开头是不是「类型 名字」。
   * 这是整份文法里唯一需要看两个 token 的地方：
   *   点 p = 新 点()   → 变量声明
   *   点.长度()        → 表达式
   *   整数 加倍(整数 甲) → 本地函数
   * 返回类型在第几个 token 结束，-1 表示开头不是类型。
   */
  private scanType(): number {
    let i = 0
    const t0 = this.peek(0)
    if (PRIMITIVE_TYPES.has(t0.text)) {
      i = 1
    } else if (t0.kind === 'ident') {
      i = 1
      while (this.peek(i).text === '.' && this.peek(i + 1).kind === 'ident') i += 2
      if (this.peek(i).text === '<') {
        let depth = 0
        for (;;) {
          const t = this.peek(i)
          if (t.kind === 'eof') return -1
          if (t.text === '<') depth++
          else if (t.text === '>') {
            depth--
            if (depth === 0) { i++; break }
          }
          i++
        }
      }
    } else {
      return -1
    }
    while (this.peek(i).text === '[' && this.peek(i + 1).text === ']') i += 2
    return i
  }

  private looksLikeVarDecl(): boolean {
    const i = this.scanType()
    if (i < 0) return false
    return this.peek(i).kind === 'ident' && this.peek(i + 1).text !== '('
  }

  private looksLikeLocalFunc(): boolean {
    const i = this.scanType()
    if (i < 0) return false
    return this.peek(i).kind === 'ident' && this.peek(i + 1).text === '('
  }

  private parseLocalFunc(): Stmt {
    const t = this.peek()
    const ret = this.parseType()
    const name = this.expectIdent('函数名')
    const params = this.parseParamList()
    const body = this.parseBlock()
    return { kind: 'localFunc', ret, name, params, body, line: t.line, col: t.col }
  }

  private parseVarDeclCore(): Stmt {
    const t = this.peek()
    const type = this.parseType()
    const name = this.expectIdent('变量名')
    let init: Expr | null = null
    if (this.eat('=')) init = this.parseExpr()
    if (type.kind === 'named' && type.typeArgs.length === 0 && init !== null &&
        init.kind === 'new' && init.type.kind === 'named' &&
        init.type.name === type.name && init.type.typeArgs.length > 0) {
      type.typeArgs = init.type.typeArgs
    }
    return { kind: 'var', type, name, init, line: t.line, col: t.col }
  }

  private parseVarDeclStmt(): Stmt {
    const v = this.parseVarDeclCore()
    this.endStmt()
    return v
  }

  /**
   * 控制语句的体。统一包成块，保证 AST 只有一种形态，
   * 打印器与解析器往返时不会因为「源里有没有写花括号」产生差异。
   */
  private parseBody(): Stmt {
    if (this.at('{')) return this.parseBlock()
    const s = this.parseStmt()
    return { kind: 'block', stmts: [s], line: s.line, col: s.col }
  }

  private parseIf(): Stmt {
    const t = this.next()
    return this.parseIfBody(t.line, t.col)
  }

  private parseIfBody(line: number, col: number): Stmt {
    this.expect('(', '条件需要写在括号里，缺左括号「(」')
    const cond = this.parseExpr()
    this.expect(')', '条件括号没有闭合，缺右括号「)」')
    const then = this.parseBody()
    let els: Stmt | null = null
    if (this.at('否则')) {
      this.next()
      if (this.at('若')) {
        throw this.err('「否则若」要连写成三个字，中间不能有空格',
          '把 「否则 若」 改成 「否则若」')
      }
      els = this.parseBody()
    } else if (this.at('否则若')) {
      const t = this.next()
      els = this.parseIfBody(t.line, t.col)
    }
    return { kind: 'if', cond, then, els, line, col }
  }

  private parseWhile(): Stmt {
    const t = this.next()
    this.expect('(', '条件需要写在括号里')
    const cond = this.parseExpr()
    this.expect(')', '条件括号没有闭合')
    const body = this.parseBody()
    return { kind: 'while', cond, body, line: t.line, col: t.col }
  }

  private parseDoWhile(): Stmt {
    const t = this.next()
    const body = this.parseBody()
    if (!this.at('只要')) throw this.err('做 语句后面必须接「只要 (条件);」')
    this.next()
    this.expect('(', '条件需要写在括号里')
    const cond = this.parseExpr()
    this.expect(')', '条件括号没有闭合')
    this.endStmt()
    return { kind: 'dowhile', body, cond, line: t.line, col: t.col }
  }

  private parseFor(): Stmt {
    const t = this.next()
    this.expect('(', '循环 后面的三段要写在括号里')
    let init: Stmt | null = null
    if (!this.at(';')) {
      if (this.looksLikeVarDecl()) init = this.parseVarDeclCore()
      else {
        const e = this.parseExpr()
        init = { kind: 'expr', expr: e, line: e.line, col: e.col }
      }
    }
    this.expect(';', '循环 的第一段后面需要分号')
    let cond: Expr | null = null
    if (!this.at(';')) cond = this.parseExpr()
    this.expect(';', '循环 的第二段后面需要分号')
    const step: Expr[] = []
    if (!this.at(')')) {
      do {
        step.push(this.parseExpr())
      } while (this.eat(','))
    }
    this.expect(')', '循环 的括号没有闭合')
    const body = this.parseBody()
    return { kind: 'for', init, cond, step, body, line: t.line, col: t.col }
  }

  private parseForEach(): Stmt {
    const t = this.next()
    this.expect('(', '遍历 后面要写 (元素 在 集合)')
    let elemType: TypeRef | null = null
    const save = this.pos
    try {
      elemType = this.parseType()
      if (this.peek().kind !== 'ident') {
        this.pos = save
        elemType = null
      }
    } catch {
      this.pos = save
      elemType = null
    }
    const name = this.expectIdent('循环变量名')
    if (!this.at('在')) {
      throw this.err('遍历 里缺少「在」', '写法是：遍历 (元素 在 集合) { ... }')
    }
    this.next()
    const iter = this.parseExpr()
    this.expect(')', '遍历 的括号没有闭合')
    const body = this.parseBody()
    return { kind: 'foreach', elemType, name, iter, body, line: t.line, col: t.col }
  }

  private parseSwitch(): Stmt {
    const t = this.next()
    this.expect('(', '选择 后面要写 (被判断的值)')
    const subject = this.parseExpr()
    this.expect(')', '选择 的括号没有闭合')
    this.expect('{', '选择 后面需要一个左花括号')
    const clauses: CaseClause[] = []
    const atCase = (): boolean => this.at('情况')
    while (!this.at('}') && !this.atEof()) {
      const c = this.peek()
      if (atCase()) {
        this.next()
        const label = this.parseExpr()
        this.expect(':', '情况 后面需要冒号「:」')
        const stmts: Stmt[] = []
        while (!atCase() && !this.at('默认') && !this.at('}') && !this.atEof()) {
          stmts.push(this.parseStmt())
        }
        clauses.push({ label, stmts, line: c.line, col: c.col })
      } else if (this.at('默认')) {
        this.next()
        this.expect(':', '默认 后面需要冒号「:」')
        const stmts: Stmt[] = []
        while (!atCase() && !this.at('默认') && !this.at('}') && !this.atEof()) {
          stmts.push(this.parseStmt())
        }
        clauses.push({ label: null, stmts, line: c.line, col: c.col })
      } else {
        throw this.err('选择 里面只能写「情况 值:」或「默认:」',
          `读到的是「${this.peek().text}」`)
      }
    }
    this.expect('}', '选择 少了一个右花括号')
    return { kind: 'switch', subject, clauses, line: t.line, col: t.col }
  }

  private parseTry(): Stmt {
    const t = this.next()
    const body = this.parseBlock()
    const catches: CatchClause[] = []
    while (this.at('捕获')) {
      this.next()
      this.expect('(', '捕获 后面要写 (异常类型 变量名)')
      const type = this.parseType()
      const name = this.expectIdent('异常变量名')
      this.expect(')', '捕获 的括号没有闭合')
      let filter: Expr | null = null
      if (this.at('若')) {
        this.next()
        filter = this.parseExpr()
      }
      catches.push({ type, name, filter, body: this.parseBlock() })
    }
    let fin: Stmt | null = null
    if (this.at('最终')) {
      this.next()
      fin = this.parseBlock()
    }
    if (catches.length === 0 && fin === null) {
      throw this.err('试 后面必须跟 捕获 或 最终', '只写 试 { } 没有意义')
    }
    return { kind: 'try', body, catches, fin, line: t.line, col: t.col }
  }

  // ---------- 表达式 ----------

  parseExpr(): Expr {
    return this.parseAssign()
  }

  private parseAssign(): Expr {
    const left = this.parseCond()
    const t = this.peek()
    if (ASSIGN_OPS.has(t.text)) {
      this.next()
      const value = this.parseAssign()
      return { kind: 'assign', op: t.text, target: left, value, line: left.line, col: left.col }
    }
    return left
  }

  private parseCond(): Expr {
    const cond = this.parseCoalesce()
    if (this.at('?')) {
      const t = this.next()
      const then = this.parseExpr()
      this.expect(':', '三元表达式里缺少冒号「:」')
      const els = this.parseCond()
      return { kind: 'cond', cond, then, else: els, line: t.line, col: t.col }
    }
    return cond
  }

  private parseCoalesce(): Expr {
    let left = this.parseOr()
    while (this.at('??')) {
      const t = this.next()
      const right = this.parseCoalesce()
      left = { kind: 'binary', op: t.text, left, right, line: left.line, col: left.col }
    }
    return left
  }

  private binaryLevel(nextLevel: () => Expr, ops: Set<string>): Expr {
    let left = nextLevel()
    for (;;) {
      const t = this.peek()
      if (!ops.has(t.text)) break
      this.next()
      const right = nextLevel()
      left = { kind: 'binary', op: t.text, left, right, line: left.line, col: left.col }
    }
    return left
  }

  private parseOr(): Expr {
    return this.binaryLevel(() => this.parseAnd(), new Set(['||']))
  }

  private parseAnd(): Expr {
    return this.binaryLevel(() => this.parseEquality(), new Set(['&&']))
  }

  private parseEquality(): Expr {
    return this.binaryLevel(() => this.parseRelational(), new Set(['==', '!=']))
  }

  private parseRelational(): Expr {
    return this.binaryLevel(() => this.parseAdditive(), new Set(['<', '<=', '>', '>=']))
  }

  private parseAdditive(): Expr {
    return this.binaryLevel(() => this.parseMultiplicative(), new Set(['+', '-']))
  }

  private parseMultiplicative(): Expr {
    return this.binaryLevel(() => this.parseUnary(), new Set(['*', '/', '%']))
  }

  private parseUnary(): Expr {
    const t = this.peek()
    if (t.text === '!' || t.text === '-' || t.text === '++' || t.text === '--') {
      this.next()
      const operand = this.parseUnary()
      return { kind: 'unary', op: t.text, operand, line: t.line, col: t.col }
    }
    return this.parsePostfix()
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary()
    for (;;) {
      if (this.at('(')) {
        this.next()
        const args = this.parseArgs()
        this.expect(')', '调用少了一个右括号')
        e = { kind: 'call', callee: e, args, line: e.line, col: e.col }
        continue
      }
      if (this.at('.') || this.at('?.')) {
        const nullSafe = this.at('?.')
        this.next()
        const name = this.expectIdent('成员名')
        e = { kind: 'member', target: e, name, nullSafe, line: e.line, col: e.col }
        continue
      }
      if (this.at('[')) {
        this.next()
        const index = this.parseExpr()
        this.expect(']', '下标少了一个右方括号')
        e = { kind: 'index', target: e, index, line: e.line, col: e.col }
        continue
      }
      if (this.at('++') || this.at('--')) {
        const op = this.next()
        e = { kind: 'postfix', op: op.text, operand: e, line: e.line, col: e.col }
        continue
      }
      break
    }
    return e
  }

  private parseArgs(): Expr[] {
    const out: Expr[] = []
    if (!this.at(')')) {
      do {
        const t = this.peek()
        const after = this.peek(1)
        const modeArg = (this.at('引用') || this.at('输出')) && (after.kind === 'ident' || after.text === '自' || after.text === '基')
        if (modeArg) {
          const mode = this.next().text === '引用' ? 'ref' : 'out'
          const value = this.parseExpr()
          out.push({ kind: 'byref', mode, expr: value, line: t.line, col: t.col })
        } else if (t.kind === 'ident' && this.peek(1).text === ':') {
          this.next()
          this.next()
          const value = this.parseExpr()
          out.push({ kind: 'named', name: t.text, value, line: t.line, col: t.col })
        } else {
          out.push(this.parseExpr())
        }
      } while (this.eat(','))
    }
    return out
  }

  /** 从当前位置的 ( 扫到匹配的 )，后面是否紧跟 => */
  private looksLikeLambda(): boolean {    let depth = 0
    for (let i = this.pos; i < this.tokens.length; i++) {
      const t = this.tokens[i]
      if (t.kind === 'eof') return false
      if (t.text === '(') depth++
      else if (t.text === ')') {
        depth--
        if (depth === 0) return this.tokens[i + 1]?.text === '=>'
      }
    }
    return false
  }

  private parseLambda(): Expr {
    const open = this.expect('(', 'Lambda 参数表')
    const params: Param[] = []
    if (!this.at(')')) {
      do {
        const type = this.parseType()
        const name = this.expectIdent('Lambda 参数名')
        params.push({ type, name, def: null })
      } while (this.eat(','))
    }
    this.expect(')', 'Lambda 参数表少了一个右括号')
    this.expect('=>', 'Lambda 参数表后面需要 =>')
    const body: Expr | Stmt = this.at('{') ? this.parseBlock() : this.parseExpr()
    return { kind: 'lambda', params, body, line: open.line, col: open.col }
  }

  private looksLikeCast(): boolean {
    if (!this.at('(')) return false
    let close = -1
    for (let i = this.pos + 1; i < this.tokens.length; i++) {
      if (this.tokens[i].text === ')') {
        close = i
        break
      }
    }
    if (close < 0 || close === this.pos + 1) return false
    const typeTokens = this.tokens.slice(this.pos + 1, close)
    if (typeTokens.some((t) => ['+', '-', '*', '/', '%', '=', ',', ';', '?', ':', '??'].includes(t.text))) return false
    if (typeTokens.some((t) => t.kind === 'op' && !['.', '<', '>', ',', '[', ']'].includes(t.text))) return false
    const after = this.tokens[close + 1]
    if (after === undefined) return false
    if (after.text === '[' && !typeTokens.some((t) => t.text === '[')) return false
    if (after.kind === 'int' || after.kind === 'float' || after.kind === 'string') return true
    if (['(', '[', '新', '真', '假', '空', '自', '基'].includes(after.text)) return true
    if (after.kind === 'ident') return true
    if (after.text === '-' || after.text === '!') {
      return ['整数', '长整数', '长小数', '浮点数', '文本', '真假', '字节', '有符号字节', '短整数', '无符号短整数', '无符号整数', '无符号长整数', '字符', '十进制'].includes(typeTokens[0]?.text ?? '')    }
    return false
  }

  private parsePrimary(): Expr {
    const t = this.peek()

    if (t.kind === 'int') {
      this.next()
      return { kind: 'int', text: t.text, line: t.line, col: t.col }
    }
    if (t.kind === 'float') {
      this.next()
      return { kind: 'float', text: t.text, line: t.line, col: t.col }
    }
    if (t.kind === 'char') {
      this.next()
      return { kind: 'char', value: t.text.codePointAt(0) ?? 0, line: t.line, col: t.col }
    }
    if (t.kind === 'string') {
      this.next()
      return this.stringExpr(t)
    }
    if (t.text === '真' || t.text === '假') {
      this.next()
      return { kind: 'bool', value: t.text === '真', line: t.line, col: t.col }
    }
    if (t.text === '字符' && this.peek(1).text === '(') {
      this.next()
      return { kind: 'name', name: '字符', line: t.line, col: t.col }
    }
    if (t.text === '空') {
      this.next()
      return { kind: 'null', line: t.line, col: t.col }
    }
    if (t.text === '自') {
      this.next()
      return { kind: 'this', line: t.line, col: t.col }
    }
    if (t.text === '基') {
      this.next()
      return { kind: 'base', line: t.line, col: t.col }
    }
    if (t.text === '值' && t.kind === 'ident' && this.valueDepth > 0) {
      this.next()
      return { kind: 'value', line: t.line, col: t.col }
    }
    if (t.kind === 'ident') {
      this.next()
      return { kind: 'name', name: t.text, line: t.line, col: t.col }
    }
    if (t.text === '(') {
      if (this.looksLikeLambda()) return this.parseLambda()
      if (this.looksLikeCast()) {
        const open = this.next()
        const type = this.parseType()
        this.expect(')', '类型转换少了一个右括号')
        const expr = this.parseUnary()
        return { kind: 'cast', type, expr, line: open.line, col: open.col }
      }
      const open = this.next()
      const inner = this.parseExpr()
      this.expect(')', '括号没有闭合')
      return { kind: 'paren', expr: inner, line: open.line, col: open.col }
    }
    if (t.text === '[') {
      const open = this.next()
      const elems: Expr[] = []
      if (!this.at(']')) {
        do {
          elems.push(this.parseExpr())
        } while (this.eat(','))
      }
      this.expect(']', '数组字面量少了一个右方括号')
      return { kind: 'array', elems, line: open.line, col: open.col }
    }
    if (t.text === '新') {
      const kw = this.next()
      const type = this.parseType()
      this.expect('(', '新 后面需要一对括号，即使不传参数')
      const args = this.parseArgs()
      this.expect(')', '新 的括号没有闭合')
      return { kind: 'new', type, args, line: kw.line, col: kw.col }
    }

    const found = t.kind === 'eof' ? '文件结尾' : `「${t.text}」`
    throw this.err(`这里需要一个值，但读到的是${found}`,
      '值可以是数字、文本、变量名，或者一个函数调用')
  }

  private stringExpr(t: Token): Expr {
    const segs: StringSeg[] = []
    for (const s of t.segments ?? [{ kind: 'text', text: '' } as const]) {
      if (s.kind === 'text') {
        segs.push({ kind: 'text', text: s.text })
      } else {
        const sub = new Parser([...s.tokens, { kind: 'eof', text: '', line: t.line, col: t.col }], this.diags)
        const expr = sub.parseExpr()
        if (!sub.atEof()) {
          throw sub.err('插值里的表达式后面还有多余内容')
        }
        segs.push({ kind: 'expr', expr })
      }
    }
    return { kind: 'string', interpolated: t.interpolated === true, segs, line: t.line, col: t.col }
  }
}

export function parse(src: string): { unit: CompilationUnit; diags: Diagnostic[] } {
  const { tokens, diags } = tokenize(src)
  // 词法有错就不再跑语法分析：否则一个全角括号能引出一串"缺分号"的噪音，
  // 把真正的错误埋掉。
  if (diags.some((d) => d.severity === 'error')) {
    return { unit: { usings: [], stmts: [], decls: [] }, diags }
  }
  const parser = new Parser(tokens, diags)
  let unit: CompilationUnit = { usings: [], stmts: [], decls: [] }
  try {
    unit = parser.parseUnit()
  } catch (e) {
    if (!(e instanceof ParseError)) throw e
  }
  return { unit, diags }
}
