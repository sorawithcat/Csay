// Csay 编辑器：跨文件重命名。只替换 tokenizer 认定的标识符，不碰注释和字符串。
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { findReferences } from './符号索引.mjs'

function inside(root, file) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function applyRefs(source, name, next, refs) {
  const lines = source.split('\n')
  const sorted = refs.slice().sort((a, b) => b.line - a.line || b.col - a.col)
  let count = 0
  for (const ref of sorted) {
    const idx = ref.col - 1
    const line = lines[ref.line - 1]
    if (line === undefined || line.slice(idx, idx + name.length) !== name) continue
    lines[ref.line - 1] = line.slice(0, idx) + next + line.slice(idx + name.length)
    count++
  }
  return { text: lines.join('\n'), count }
}

export function renameSymbol(entry, source, line, col, next, workspace) {
  const found = findReferences(entry, source, line, col, workspace)
  if (!found.definition) return { error: '没有找到「' + (found.name || '当前名字') + '」的定义' }
  const name = found.name
  if (!name || name === next) return { error: '新名字和旧名字相同' }
  const root = workspace ? resolve(workspace) : resolve(entry, '..')
  const groups = new Map()
  for (const ref of found.refs) {
    const file = resolve(ref.file)
    if (!file.endsWith('.csay')) continue
    if (!inside(root, file)) continue
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(ref)
  }
  if (groups.size === 0) return { error: '没有找到可重命名的位置' }
  const changed = []
  const writes = []
  let entryContent = source
  let total = 0
  for (const [file, refs] of groups) {
    const before = file === resolve(entry) ? source : readFileSync(file, 'utf8')
    const result = applyRefs(before, name, next, refs)
    if (result.count === 0) continue
    changed.push({ file, count: result.count })
    writes.push([file, result.text])
    total += result.count
    if (file === resolve(entry)) entryContent = result.text
  }
  if (total === 0) return { error: '名字位置已经变化，请重新查找引用' }
  for (const [file, text] of writes) writeFileSync(file, text, 'utf8')
  return { ok: true, count: total, entryContent, changed }
}
