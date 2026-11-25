// 诊断信息的终端渲染。教学语言的核心体验之一：报错必须能让初学者看懂。

import type { Diagnostic } from './token.ts'

/** 终端里把全角字符按 2 列宽对齐，否则波浪线会错位 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    // 全角区、汉字、全角标点按 2 列
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

export function formatDiagnostic(d: Diagnostic, source: string): string {
  const lines = source.split(/\r\n?|\n/)
  const srcLine = lines[d.line - 1] ?? ''
  const gutter = String(d.line)
  const pad = ' '.repeat(gutter.length)
  const prefix = pad + ' | '

  const before = srcLine.slice(0, Math.max(0, d.col - 1))
  const startCol = displayWidth(before)
  // 全角字符占 2 列，波浪线也要标 2 个，否则视觉上偏左
  const target = [...srcLine.slice(d.col - 1)][0] ?? ' '
  const underline = ' '.repeat(startCol) + '^'.repeat(displayWidth(target) >= 2 ? 2 : 1)

  const label = d.severity === 'error' ? '错误' : '提示'
  const where = d.file === undefined ? '' : `${d.file}：`
  const head = `${label}：${where}第 ${d.line} 行，第 ${d.col} 列 — ${d.message}`

  let out = head + '\n'
  out += `${gutter} | ${srcLine}\n`
  out += `${prefix}${underline}\n`
  if (d.hint) {
    out += `${prefix}建议：${d.hint}\n`
  }
  return out
}

export function formatAll(diags: Diagnostic[], source: string): string {
  if (diags.length === 0) return ''
  const errors = diags.filter((d) => d.severity === 'error').length
  const warns = diags.length - errors
  const body = diags.map((d) => formatDiagnostic(d, source)).join('\n')
  const summary = errors > 0
    ? `共 ${errors} 个错误${warns > 0 ? `，${warns} 个提示` : ''}。`
    : `共 ${warns} 个提示，没有错误。`
  return body + '\n' + summary
}
