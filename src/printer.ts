// 语法树打印器：把 AST 还原成规范格式源码。
// 用途：用「解析 → 打印 → 再解析」的往返比对验证解析器正确性。
// 表达式括号依赖 paren 节点（解析时保留了所有显式括号），因此无需再做优先级加括号。

import type {
  CompilationUnit, Decl, Member, Stmt, Expr, TypeRef, Param, Accessor, StringSeg, CaseClause,
} from './ast.ts'

const IND = '    '

function ind(n: number): string {
  return IND.repeat(n)
}

function typeRef(t: TypeRef): string {
  if (t.kind === 'array') return typeRef(t.elem) + '[]'
  if (t.typeArgs.length > 0) return `${t.name}<${t.typeArgs.map(typeRef).join(', ')}>`
  return t.name
}

function stringLit(segs: StringSeg[], interpolated: boolean): string {
  const body = segs.map((s) => {
    if (s.kind === 'expr') return `{${expr(s.expr)}}`
    return s.text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
  }).join('')
  return (interpolated ? '$"' : '"') + body + '"'
}

export function expr(e: Expr): string {
  switch (e.kind) {
    case 'int': return e.text
    case 'float': return e.text
    case 'string': return stringLit(e.segs, e.interpolated)
    case 'bool': return e.value ? '真' : '假'
    case 'null': return '空'
    case 'name': return e.name
    case 'this': return '自'
    case 'base': return '基'
    case 'value': return '值'
    case 'binary': return `${expr(e.left)} ${e.op} ${expr(e.right)}`
    case 'unary': return `${e.op}${expr(e.operand)}`
    case 'postfix': return `${expr(e.operand)}${e.op}`
    case 'assign': return `${expr(e.target)} ${e.op} ${expr(e.value)}`
    case 'cond': return `${expr(e.cond)} ? ${expr(e.then)} : ${expr(e.else)}`
    case 'call': return `${expr(e.callee)}(${e.args.map(expr).join(', ')})`
    case 'member': return `${expr(e.target)}.${e.name}`
    case 'index': return `${expr(e.target)}[${expr(e.index)}]`
    case 'new': return `新 ${typeRef(e.type)}(${e.args.map(expr).join(', ')})`
    case 'array': return `[${e.elems.map(expr).join(', ')}]`
    case 'paren': return `(${expr(e.expr)})`
    case 'lambda': {
      const body = e.body.kind === 'block' ? blockInline(e.body) : expr(e.body)
      return `(${params(e.params)}) => ${body}`
    }
  }
}

function params(list: Param[]): string {
  return list.map((p) => {
    const base = `${typeRef(p.type)} ${p.name}`
    return p.def === null ? base : `${base} = ${expr(p.def)}`
  }).join(', ')
}

function modifiers(list: string[]): string {
  return list.length > 0 ? list.join(' ') + ' ' : ''
}

function accessors(list: Accessor[]): string {
  const parts = list.map((a) => `${a.kind === 'get' ? '取' : '写'} ${blockInline(a.body)}`)
  return parts.join(' ')
}

/** 访问器体与方法体都尽量单行输出，保持打印结果紧凑 */
function blockInline(b: Stmt): string {
  if (b.kind === 'block') {
    if (b.stmts.length === 0) return '{ }'
    return '{ ' + b.stmts.map((s) => stmtInline(s)).join(' ') + ' }'
  }
  return '{ ' + stmtInline(b) + ' }'
}

function stmtInline(s: Stmt): string {
  switch (s.kind) {
    case 'return': return s.value === null ? '返回;' : `返回 ${expr(s.value)};`
    case 'break': return '跳出;'
    case 'continue': return '跳过;'
    case 'throw': return `抛出 ${expr(s.value)};`
    case 'expr': return `${expr(s.expr)};`
    case 'var': return `${typeRef(s.type)} ${s.name}${s.init === null ? '' : ' = ' + expr(s.init)};`
    case 'empty': return ';'
    case 'localFunc': return `${typeRef(s.ret)} ${s.name}(${params(s.params)}) ${blockInline(s.body)}`
    default: return stmt(s, 0).replace(/\n\s*/g, ' ')
  }
}

export function stmt(s: Stmt, depth: number): string {
  const p = ind(depth)
  switch (s.kind) {
    case 'block': {
      if (s.stmts.length === 0) return p + '{ }'
      return p + '{\n' + s.stmts.map((x) => stmt(x, depth + 1)).join('\n') + '\n' + p + '}'
    }
    case 'var':
      return `${p}${typeRef(s.type)} ${s.name}${s.init === null ? '' : ' = ' + expr(s.init)};`
    case 'expr':
      return `${p}${expr(s.expr)};`
    case 'return':
      return s.value === null ? `${p}返回;` : `${p}返回 ${expr(s.value)};`
    case 'break':
      return `${p}跳出;`
    case 'continue':
      return `${p}跳过;`
    case 'throw':
      return `${p}抛出 ${expr(s.value)};`
    case 'empty':
      return `${p};`
    case 'localFunc':
      return `${p}${typeRef(s.ret)} ${s.name}(${params(s.params)}) ${blockBody(s.body, depth)}`
    case 'if': {
      let out = `${p}若 (${expr(s.cond)}) ${blockBody(s.then, depth)}`
      let els = s.els
      while (els !== null) {
        if (els.kind === 'if') {
          out += ` 否则若 (${expr(els.cond)}) ${blockBody(els.then, depth)}`
          els = els.els
        } else {
          out += ` 否则 ${blockBody(els, depth)}`
          els = null
        }
      }
      return out
    }
    case 'while':
      return `${p}只要 (${expr(s.cond)}) ${blockBody(s.body, depth)}`
    case 'dowhile':
      return `${p}做 ${blockBody(s.body, depth)} 只要 (${expr(s.cond)});`
    case 'for': {
      const init = s.init === null ? '' : stmtInline(s.init).replace(/;$/, '')
      const cond = s.cond === null ? '' : expr(s.cond)
      const step = s.step.map(expr).join(', ')
      return `${p}对于 (${init}; ${cond}; ${step}) ${blockBody(s.body, depth)}`
    }
    case 'foreach': {
      const t = s.elemType === null ? '' : typeRef(s.elemType) + ' '
      return `${p}遍历 (${t}${s.name} 在 ${expr(s.iter)}) ${blockBody(s.body, depth)}`
    }
    case 'switch': {
      const lines = [p + `择 (${expr(s.subject)}) {`]
      for (const c of s.clauses) {
        lines.push(...clause(c, depth + 1))
      }
      lines.push(p + '}')
      return lines.join('\n')
    }
    case 'try': {
      let out = `${p}试 ${blockBody(s.body, depth)}`
      for (const c of s.catches) {
        out += ` 捕获 (${typeRef(c.type)} ${c.name}) ${blockBody(c.body, depth)}`
      }
      if (s.fin !== null) out += ` 最终 ${blockBody(s.fin, depth)}`
      return out
    }
    case 'region':
      return `${p}区域 ${blockBody(s.body, depth)}`
    case 'using':
      return `${p}使用 (${expr(s.target)}) ${blockBody(s.body, depth)}`
  }
}

function clause(c: CaseClause, depth: number): string[] {
  const p = ind(depth)
  const head = c.label === null ? `${p}默认:` : `${p}情形 ${expr(c.label)}:`
  if (c.stmts.length === 0) return [head]
  return [head, ...c.stmts.map((s) => stmt(s, depth + 1))]
}

/** 控制语句的体：块直接跟在关键字后，单语句也补成块，保证打印结果可再解析 */
function blockBody(s: Stmt, depth: number): string {
  if (s.kind === 'block') return stmt(s, depth).replace(/^\s+/, '')
  return '{\n' + stmt(s, depth + 1) + '\n' + ind(depth) + '}'
}

function member(m: Member, depth: number): string {
  const p = ind(depth)
  switch (m.kind) {
    case 'field':
      return `${p}${modifiers(m.modifiers)}${typeRef(m.type)} ${m.name}${m.init === null ? '' : ' = ' + expr(m.init)};`
    case 'method':
      return `${p}${modifiers(m.modifiers)}${typeRef(m.ret)} ${m.name}(${params(m.params)}) ${m.body === null ? ';' : blockBody(m.body, depth)}`
    case 'ctor': {
      const base = m.baseArgs === null ? '' : ` : 基(${m.baseArgs.map(expr).join(', ')})`
      return `${p}${modifiers(m.modifiers)}${m.name}(${params(m.params)})${base} ${blockBody(m.body, depth)}`
    }
    case 'prop':
      return `${p}${modifiers(m.modifiers)}${typeRef(m.type)} ${m.name} { ${accessors(m.accessors)} }`
    case 'ifaceMethod':
      return `${p}${typeRef(m.ret)} ${m.name}(${params(m.params)});`
    case 'ifaceProp': {
      const parts: string[] = []
      if (m.hasGet) parts.push('取;')
      if (m.hasSet) parts.push('写;')
      return `${p}${typeRef(m.type)} ${m.name} { ${parts.join(' ')} }`
    }
  }
}

export function decl(d: Decl, depth: number): string {
  const p = ind(depth)
  switch (d.kind) {
    case 'class':
    case 'struct':
    case 'interface': {
      const kw = d.kind === 'class' ? '类' : d.kind === 'struct' ? '结构' : '接口'
      const tparams = d.typeParams === undefined || d.typeParams.length === 0 ? '' : `<${d.typeParams.join(', ')}>`
      const bases = d.bases.length > 0 ? ' : ' + d.bases.map(typeRef).join(', ') : ''
      if (d.members.length === 0) {
        return `${p}${modifiers(d.modifiers)}${kw} ${d.name}${tparams}${bases} { }`
      }
      const body = d.members.map((m) => member(m, depth + 1)).join('\n')
      return `${p}${modifiers(d.modifiers)}${kw} ${d.name}${tparams}${bases} {\n${body}\n${p}}`
    }
    case 'enum': {
      const items = d.items.map((i) => (i.value === null ? i.name : `${i.name} = ${expr(i.value)}`))
      return `${p}${modifiers(d.modifiers)}枚举 ${d.name} { ${items.join(', ')} }`
    }
    case 'delegate':
      return `${p}${modifiers(d.modifiers)}委托 ${d.name}(${params(d.params)}): ${typeRef(d.ret)};`
    case 'namespace': {
      const body = d.decls.map((x) => decl(x, depth + 1)).join('\n\n')
      return `${p}空间 ${d.name} {\n${body}\n${p}}`
    }
  }
}

export function printUnit(u: CompilationUnit): string {
  const parts: string[] = []
  if (u.usings.length > 0) {
    parts.push(u.usings.map((x) => `引 ${x};`).join('\n'))
  }
  if (u.stmts.length > 0) {
    parts.push(u.stmts.map((s) => stmt(s, 0)).join('\n'))
  }
  if (u.decls.length > 0) {
    parts.push(u.decls.map((d) => decl(d, 0)).join('\n\n'))
  }
  return parts.join('\n\n') + '\n'
}
