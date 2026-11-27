import type { Expr } from './ast.ts'

export interface Arranged {
  args: Expr[]
  error?: string
}

/**
 * 把命名参数按声明顺序排好，并补上省略的默认参数。
 * 没有命名参数时原样返回，保持原有参数数量检查行为。
 */
export function arrangeArguments(
  args: Expr[],
  names: string[],
  defaults: (Expr | null)[],
): Arranged {
  if (!args.some((a) => a.kind === 'named')) return { args }

  const out: (Expr | null)[] = new Array(names.length).fill(null)
  let pos = 0
  let sawNamed = false
  for (const a of args) {
    if (a.kind === 'named') {
      sawNamed = true
      const i = names.indexOf(a.name)
      if (i < 0) return { args, error: `命名参数「${a.name}」不存在` }
      if (out[i] !== null) return { args, error: `命名参数「${a.name}」重复` }
      out[i] = a.value
      continue
    }
    if (sawNamed) return { args, error: '位置参数不能写在命名参数之后' }
    if (pos >= names.length) return { args, error: '参数太多了' }
    out[pos++] = a
  }

  for (let i = 0; i < names.length; i++) {
    if (out[i] !== null) continue
    const def = defaults[i]
    if (def === null || def === undefined) return { args, error: `缺少参数「${names[i]}」` }
    out[i] = def
  }
  return { args: out as Expr[] }
}
