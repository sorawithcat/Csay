// 编译单元加载：处理 引 指令，把被引文件合并成一个编译单元。
// 规则：
//   引 数学;             → 加载同目录下的 数学.csay
//   被引文件只能有类型声明和函数，不能有可执行语句
//   主文件的可执行语句保持在最前，所有函数并入语句区
// 重复引用会去重；同名类型不做冲突检查（教学规模用不上）。

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { parse } from './parser.ts'
import { checkNames, collectNames } from './checker.ts'
import { checkSemantics } from './semantics.ts'
import { inferGenericArgs } from './generic-infer.ts'
import type { CompilationUnit, Decl, Stmt } from './ast.ts'
import type { Diagnostic } from './token.ts'

export interface Loaded {
  unit: CompilationUnit
  /** 主文件的绝对路径 */
  entry: string
  /** 所有参与编译的文件，按加载顺序 */
  files: string[]
  diags: Diagnostic[]
}

function isFunc(s: Stmt): s is Extract<Stmt, { kind: 'localFunc' }> {
  return s.kind === 'localFunc'
}

/** Windows 编辑器保存 UTF-8 时常带 BOM，词法器不该把它当作源字符。 */
function withoutBom(src: string): string {
  return src.charCodeAt(0) === 0xFEFF ? src.slice(1) : src
}

/** 引 的路径相对当前文件；不带扩展名时补 .csay。 */
function resolveImport(from: string, name: string): string {
  const dir = dirname(from)
  if (name.endsWith('.csay')) return resolve(dir, name)
  if (name.includes('/') || name.includes('\\')) return resolve(dir, name + '.csay')
  return resolve(dir, name + '.csay')
}

export function loadProgram(entryPath: string): Loaded {
  return loadProgramInternal(entryPath)
}

/** 与 loadProgram 相同，但入口文件用调用方提供的文本（用于编辑器的未保存缓冲区）。 */
export function loadProgramSource(entryPath: string, source: string): Loaded {
  return loadProgramInternal(entryPath, source)
}

function loadProgramInternal(entryPath: string, entrySource?: string): Loaded {
  const entry = resolve(entryPath)
  const diags: Diagnostic[] = []
  const files: string[] = []
  const seen = new Set<string>()
  const cache = new Map<string, CompilationUnit>()
  const extDecls: Decl[] = []
  const extFuncs: Stmt[] = []

  function loadOne(path: string, isEntry: boolean): CompilationUnit | null {
    if (seen.has(path)) return cache.get(path) ?? null
    seen.add(path)
    files.push(path)

    let src: string
    try {
      src = withoutBom(isEntry && entrySource !== undefined ? entrySource : readFileSync(path, 'utf8'))
    } catch {
      diags.push({
        severity: 'error', line: 1, col: 1, file: isEntry ? undefined : basename(path), filePath: path,
        message: `读不到文件：${path}`,
        hint: '检查 引 后面的名字是否和文件名一致',
      })
      return null
    }

    const { unit, diags: d } = parse(src)
    cache.set(path, unit)
    if (d.length > 0) {      for (const x of d) {
        diags.push({ ...x, file: isEntry ? undefined : basename(path), filePath: path })
      }
      if (d.some((x) => x.severity === 'error')) return null
    }
    inferGenericArgs(unit)

    // 先递归处理依赖，保证被引文件排在被引者前面
    for (const u of unit.usings) {
      const dep = resolveImport(path, u)
      if (!existsSync(dep)) {
        diags.push({
          severity: 'error', line: 1, col: 1, file: basename(path), filePath: path,
          message: `引「${u}」找不到对应文件`,
          hint: `期望的文件：${dep}`,
        })
        continue
      }
      loadOne(dep, false)
    }

    if (!isEntry) {
      const stmts = unit.stmts.filter((s) => !isFunc(s))
      if (stmts.length > 0) {
        diags.push({
          severity: 'error', line: 1, col: 1, file: basename(path), filePath: path,
          message: '被引文件不能有可执行语句',
          hint: '把代码挪进函数里，被引文件只放类型和函数',
        })
      }
    }
    return unit
  }

  const main = loadOne(entry, true)
  if (main === null) {
    return { unit: { usings: [], stmts: [], decls: [] }, entry, files, diags }
  }

  // 名字与成员检查：所有依赖都加载完后，被 引 文件的顶层名和类型也对主文件可见
  {
    const syntaxErr = diags.some((x) => x.severity === 'error')
    if (!syntaxErr) {
      const allNames = new Set<string>()
      const allDecls: Decl[] = []
      const allFuncs: Stmt[] = []
      const allTop: Stmt[] = []
      for (const u of cache.values()) {
        collectNames(u.stmts, allNames)
        for (const ud of u.decls) {
          allDecls.push(ud)
          if (ud.kind === 'class' || ud.kind === 'struct' || ud.kind === 'interface' || ud.kind === 'enum') allNames.add(ud.name)
        }
        allFuncs.push(...u.stmts.filter(isFunc))
        allTop.push(...u.stmts.filter((s) => !isFunc(s)))
      }
      for (const [file, u] of cache) {
        for (const nd of checkNames(u, allNames)) {
          diags.push({ ...nd, file: file === entry ? undefined : basename(file), filePath: file })
        }
      }
      const regionUnit: CompilationUnit = { usings: [], stmts: [...allFuncs, ...allTop], decls: allDecls }
      for (const [file, u] of cache) {
        for (const nd of checkSemantics(u, allDecls, allFuncs, regionUnit)) {
          diags.push({ ...nd, file: file === entry ? undefined : basename(file), filePath: file })
        }
      }
    }
  }

  // files 里除了 entry 都是依赖；按加载顺序取它们的声明与函数
  for (const f of files) {
    if (f === entry) continue
    const dep = cache.get(f)
    if (dep === undefined) continue
    extDecls.push(...dep.decls)
    extFuncs.push(...dep.stmts.filter(isFunc))
  }
  extFuncs.push(...main.stmts.filter(isFunc))

  return {
    unit: {
      usings: [],
      stmts: [...extFuncs, ...main.stmts.filter((s) => !isFunc(s))],
      decls: [...extDecls, ...main.decls],
    },
    entry,
    files,
    diags,
  }
}
