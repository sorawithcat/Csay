// Csay 词法分析器。规格见 docs/EBNF与词法-v1.md 第 1 节。

import {
  KEYWORDS, FULLWIDTH_MAP, OPERATORS_2, OPERATORS_1,
  type Token, type Diagnostic, type StringSegment,
} from './token.ts'

const HAN = /[\p{Script=Han}]/u
const LETTER = /[A-Za-z_]/
const DIGIT = /[0-9]/

export class Lexer {
  private src: string
  private pos = 0
  private line: number
  private col: number
  private diags: Diagnostic[] = []
  private warnedFullwidthSpace = false

  constructor(src: string, startLine = 1, startCol = 1) {
    // 统一换行，去掉 BOM
    this.src = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
    this.line = startLine
    this.col = startCol
  }

  tokenize(): { tokens: Token[]; diags: Diagnostic[] } {
    const tokens: Token[] = []
    for (;;) {
      const tok = this.next()
      tokens.push(tok)
      if (tok.kind === 'eof') break
    }
    return { tokens, diags: this.diags }
  }

  // ---- 字符推进 ----

  private peek(offset = 0): string {
    if (this.pos + offset >= this.src.length) return ''
    const cp = this.src.codePointAt(this.pos + offset)
    return cp === undefined ? '' : String.fromCodePoint(cp)
  }

  private advance(): string {
    const ch = this.peek()
    if (ch === '') return ''
    this.pos += ch.length
    if (ch === '\n') {
      this.line++
      this.col = 1
    } else {
      this.col++
    }
    return ch
  }

  private at(a: string, b: string): boolean {
    return this.peek() === a && this.peek(a.length) === b
  }

  private error(line: number, col: number, message: string, hint?: string): void {
    this.diags.push({ severity: 'error', line, col, message, hint })
  }

  // ---- 主分派 ----

  private next(): Token {
    this.skipTrivia()
    const line = this.line
    const col = this.col

    if (this.pos >= this.src.length) {
      return { kind: 'eof', text: '', line, col }
    }

    const ch = this.peek()

    // 中文引号：直接当字符串，默认支持 {插值}
    if (ch === '“') return this.readString(line, col, true, '”')

    if (ch === '"') return this.readString(line, col, true)
    if (ch === '$' && this.peek(1) === '"') {
      this.advance() // 吃掉 $
      return this.readString(line, col, true)
    }
    if (ch === '$') {
      this.advance()
      this.error(line, col, '$ 只能作为文本插值前缀使用，例如 $"共 {数量} 个"',
        '如果只是想写美元符号，请放进字符串里："$100"')
      return this.next()
    }

    if (DIGIT.test(ch)) return this.readNumber(line, col)

    if (this.isIdentStart(ch)) return this.readIdent(line, col)

    // 全角符号：按半角返回，等价于直接写半角
    const full = FULLWIDTH_MAP.get(ch)
    if (full !== undefined) {
      this.advance()
      return { kind: 'op', text: full.half, line, col }
    }

    const two = ch + this.peek(1)
    if (two.length === 2 && OPERATORS_2.has(two)) {
      this.advance()
      this.advance()
      return { kind: 'op', text: two, line, col }
    }
    if (OPERATORS_1.has(ch)) {
      this.advance()
      return { kind: 'op', text: ch, line, col }
    }

    this.advance()
    this.error(line, col, `无法识别的字符「${ch}」`,
      '代码里只能用半角标点，中文标点请放进字符串')
    return this.next()
  }

  // ---- 空白与注释 ----

  private skipTrivia(): void {
    for (;;) {
      const ch = this.peek()
      if (ch === ' ' || ch === '\t' || ch === '\n') {
        this.advance()
        continue
      }
      // 全角空格：当空白处理，但提醒一次，避免整屏刷同一个错
      if (ch === '　') {
        if (!this.warnedFullwidthSpace) {
          this.warnedFullwidthSpace = true
          this.diags.push({
            severity: 'warning', line: this.line, col: this.col,
            message: '这里出现了全角空格',
            hint: '全角空格容易被误当成缩进，建议改用半角空格',
          })
        }
        this.advance()
        continue
      }
      if (this.at('/', '/')) {
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance()
        continue
      }
      if (this.at('/', '*')) {
        const line = this.line
        const col = this.col
        this.advance()
        this.advance()
        let closed = false
        while (this.pos < this.src.length) {
          if (this.at('*', '/')) {
            this.advance()
            this.advance()
            closed = true
            break
          }
          this.advance()
        }
        if (!closed) {
          this.error(line, col, '块注释没有闭合',
            '每一处 /* 都要有对应的 */')
        }
        continue
      }
      return
    }
  }

  // ---- 标识符与保留字 ----

  private isIdentStart(ch: string): boolean {
    return HAN.test(ch) || LETTER.test(ch)
  }

  private isIdentPart(ch: string): boolean {
    return HAN.test(ch) || LETTER.test(ch) || DIGIT.test(ch)
  }

  private readIdent(line: number, col: number): Token {
    let text = ''
    while (this.pos < this.src.length && this.isIdentPart(this.peek())) {
      text += this.advance()
    }

    const kind = KEYWORDS.has(text) ? 'keyword' : 'ident'
    return { kind, text, line, col }
  }

  // ---- 数字 ----

  private readNumber(line: number, col: number): Token {
    let text = ''
    while (DIGIT.test(this.peek())) text += this.advance()

    if (this.peek() === '.') {
      if (!DIGIT.test(this.peek(1))) {
        this.advance()
        this.error(line, col, `数字「${text}」后面的小数点缺少数值`,
          '小数要写成 3.14 这样，小数点两边都要有数字')
        return { kind: 'int', text, line, col }
      }
      text += this.advance() // '.'
      while (DIGIT.test(this.peek())) text += this.advance()
      return { kind: 'float', text, line, col }
    }

    return { kind: 'int', text, line, col }
  }

  // ---- 文本 ----

  private readString(line: number, col: number, interpolated: boolean, close = '"'): Token {
    const openLine = line
    const openCol = col
    this.advance() // 开引号

    const segments: StringSegment[] = []
    let buf = ''

    for (;;) {
      if (this.pos >= this.src.length) {
        this.error(openLine, openCol, '文本没有闭合', '每一处开引号都要有对应的闭引号')
        break
      }
      const ch = this.peek()

      if (ch === close) {
        this.advance()
        break
      }
      if (ch === '\n') {
        this.error(this.line, this.col, '文本不能跨行',
          '需要换行请写 \\n，或者用 + 把两段拼起来')
        break
      }
      if (ch === '\\') {
        this.advance()
        const esc = this.advance()
        switch (esc) {
          case 'n': buf += '\n'; break
          case 't': buf += '\t'; break
          case 'r': buf += '\r'; break
          case '"': buf += '"'; break
          case '\\': buf += '\\'; break
          case '{': buf += '{'; break
          case '}': buf += '}'; break
          case '': this.error(this.line, this.col, '文本末尾有孤立的反斜杠'); break
          default:
            this.error(this.line, this.col - 2, `不认识转义「\\${esc}」`,
              '可用的转义只有 \\n \\t \\r \\" \\\\ \\{ \\}')
            buf += esc
        }
        continue
      }
      if (ch === '{') {
        if (buf !== '') {
          segments.push({ kind: 'text', text: buf })
          buf = ''
        }
        const exprLine = this.line
        const exprCol = this.col
        this.advance() // '{'
        segments.push({ kind: 'expr', tokens: this.readInterpolation(exprLine, exprCol) })
        continue
      }

      buf += this.advance()
    }

    if (buf !== '' || segments.length === 0) {
      segments.push({ kind: 'text', text: buf })
    }

    return { kind: 'string', text: '', line: openLine, col: openCol, segments, interpolated }
  }

  /** 读 `{` 之后到配对 `}` 之前的内容，递归词法分析 */
  private readInterpolation(startLine: number, startCol: number): Token[] {
    const start = this.pos
    let depth = 0

    for (;;) {
      if (this.pos >= this.src.length) {
        this.error(startLine, startCol, '插值表达式没有闭合', '补上 }')
        break
      }
      const ch = this.peek()

      if (ch === '\n') {
        this.error(this.line, this.col, '插值表达式不能跨行')
        break
      }
      if (ch === '"') {
        // 插值里允许嵌套普通字符串，如 $"{库存["苹果"]}"。
        // 整段跳过，里面的 } 不参与插值深度计算。
        this.advance()
        for (;;) {
          if (this.pos >= this.src.length || this.peek() === '\n') {
            this.error(this.line, this.col, '插值里的字符串没有闭合', '补上收尾的双引号')
            break
          }
          if (this.peek() === '\\') {
            this.advance()
            if (this.pos < this.src.length) this.advance()
            continue
          }
          if (this.peek() === '"') {
            this.advance()
            break
          }
          this.advance()
        }
        continue
      }
      if (ch === '{') { depth++; this.advance(); continue }
      if (ch === '}') {
        if (depth === 0) break
        depth--
        this.advance()
        continue
      }
      this.advance()
    }

    const sub = this.src.slice(start, this.pos)
    if (this.peek() === '}') this.advance() // 吃掉 }

    const inner = new Lexer(sub, startLine, startCol)
    const r = inner.tokenize()
    this.diags.push(...r.diags)
    return r.tokens.filter((t) => t.kind !== 'eof')
  }
}

export function tokenize(src: string): { tokens: Token[]; diags: Diagnostic[] } {
  return new Lexer(src).tokenize()
}
