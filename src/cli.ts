// Csay 命令行入口。
//   csay a.csay          编译并运行（源码没改就跳过编译）
//   csay a.csay --build  只编译
//   csay a.csay --check  只做语法检查
//   csay a.csay --rebuild 强制重新编译
//   csay a.csay --format  按规范格式重写源文件
//   csay --project 目录  编译目录下的 主.csay 及 引 依赖
//   --debug  生成 #line 源码映射，并让 C 编译器带调试信息
//   --tokens  列出词法单元
//   --print   解析后把语法树还原成规范源码

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize } from './lexer.ts'
import { printUnit } from './printer.ts'
import { loadProgram } from './loader.ts'
import { parse } from './parser.ts'
import { formatAll } from './diag.ts'
import { generate, Unsupported } from './codegen.ts'
import { findCompiler, compile } from './compiler.ts'
import type { CompilationUnit } from './ast.ts'
import type { Token } from './token.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILD = join(ROOT, 'build')

function describe(t: Token): string {
  if (t.kind === 'eof') return '<文件结束>'
  if (t.kind === 'string') {
    const segs = t.segments ?? []
    const body = segs
      .map((s) => (s.kind === 'text' ? s.text : `{${s.tokens.map((x) => x.text).join(' ')}}`))
      .join('')
    return (t.interpolated ? '$"' : '"') + body + '"'
  }
  return t.text
}

function collectTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTests(full, out)
    else if (entry.isFile() && full.endsWith('.csay')) out.push(full)
  }
}

function runTests(target: string): number {
  if (!existsSync(target)) {
    console.log(`找不到测试路径：${target}`)
    return 2
  }
  const tests: string[] = []
  if (statSync(target).isDirectory()) collectTests(target, tests)
  else tests.push(target)
  tests.sort()

  if (tests.length === 0) {
    console.log('没有找到 .csay 测试文件')
    return 1
  }

  const failures: string[] = []
  for (const test of tests) {
    const name = relative(process.cwd(), test) || test
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), test, '--fast', '--rebuild'], {
      encoding: 'utf8',
      env: { ...process.env, CSAY_NO_PAUSE: '1' },
    })
    if (r.status === 0) {
      console.log(`通过  ${name}`)
    } else {
      console.log(`失败  ${name}`)
      failures.push(`--- ${name} ---\n${(r.stdout ?? '') + (r.stderr ?? '')}`)
    }
  }

  console.log('')
  console.log(`测试完成：${tests.length - failures.length} 通过，${failures.length} 失败`)
  if (failures.length > 0) {
    console.log('')
    for (const failure of failures) console.log(failure)
    return 1
  }
  return 0
}

function main(argv: string[]): number {
  const args = argv.slice(2)
  const flags = args.filter((a) => a.startsWith('--'))
  let file = args.find((a) => !a.startsWith('--'))
  const testMode = flags.includes('--test')
  const projectMode = flags.includes('--project')
  let outputName: string | undefined

  if (file === undefined && !testMode && !projectMode) {
    console.log(`用法：csay <文件.csay> [选项]
       csay --test [目录]
       csay --project [目录]

  （不带选项）  编译并运行
  --build      只编译成 exe，不运行
  --check      只做语法检查
  --test       运行 tests 目录（或指定目录）里的所有 .csay 测试
  --project    编译项目目录下的 主.csay 及 引 依赖
  --format     按规范格式重写源文件
  --debug      生成 #line 源码映射，并让 C 编译器带调试信息
  --fast       用 TCC 编译（快 10 倍，不优化）
  --print      把语法树还原成规范源码
  --tokens     列出所有词法单元`)
    return 2
  }

  if (testMode) return runTests(resolve(file ?? 'tests'))

  if (projectMode) {
    const dir = resolve(file ?? '.')
    const entry = join(dir, '主.csay')
    if (!existsSync(entry)) {
      console.log(`项目目录里没有 主.csay：${dir}`)
      return 2
    }
    file = entry
    outputName = basename(dir)
  }

  if (file === undefined) return 2

  const path = resolve(file)
  let src: string
  try {
    src = readFileSync(path, 'utf8')
  } catch {
    console.log(`读不到文件：${path}`)
    return 2
  }

  console.log(`文件：${file}`)

  if (flags.includes('--format')) {
    const formatted = parse(src)
    if (formatted.diags.some((d) => d.severity === 'error')) {
      console.log('')
      console.log(formatAll(formatted.diags, src))
      return 1
    }
    writeFileSync(path, printUnit(formatted.unit).trimEnd() + '\n', 'utf8')
    console.log(`已格式化：${path}`)
    return 0
  }

  const lex = tokenize(src)
  const loaded = loadProgram(path)
  const unit = loaded.unit
  // loadProgram 内部的 parse 已经把词法与语法诊断合并好了，直接用
  const all = loaded.diags

  if (all.length > 0) {
    console.log('')
    console.log(formatAll(all, src))
  } else {
    console.log('检查通过，没有发现问题。')
  }

  if (flags.includes('--print')) {
    console.log('')
    console.log('---- 语法树还原 ----')
    console.log(printUnit(unit))
  }

  if (flags.includes('--tokens')) {
    const real = lex.tokens.filter((t) => t.kind !== 'eof')
    console.log('')
    console.log(`Token 共 ${real.length} 个：`)
    for (const t of real) {
      console.log(`  ${`${t.line}:${t.col}`.padEnd(7)}${t.kind.padEnd(9)}${describe(t)}`)
    }
  }

  if (all.some((d) => d.severity === 'error')) return 1

  // 默认就是「编译并运行」——脚本语言该有的手感：
  //   csay a.csay          编译并运行
  //   csay a.csay --build  只编译
  //   csay a.csay --check  只检查语法
  if (flags.includes('--check')) return 0
  return build(unit, path, !flags.includes('--build'), flags, loaded.files, outputName)
}

/** exe 比所有源文件新，且编译器和编译选项都没变 */
function isUpToDate(exePath: string, stampPath: string, want: string, sources: string[]): boolean {
  if (!existsSync(exePath) || !existsSync(stampPath)) return false
  if (readFileSync(stampPath, 'utf8') !== want) return false
  const exeTime = statSync(exePath).mtimeMs
  for (const s of sources) {
    if (!existsSync(s)) return false
    if (statSync(s).mtimeMs > exeTime) return false
  }
  return true
}

function runExe(exePath: string): number {
  console.log('---- 运行输出 ----')
  try {
    // 由 csay 启动的进程不该在结束时停下来等回车，那是给双击准备的
    const out = execFileSync(exePath, [], {
      encoding: 'utf8',
      env: { ...process.env, CSAY_NO_PAUSE: '1' },
    })
    process.stdout.write(out)
    if (out !== '' && !out.endsWith('\n')) process.stdout.write('\n')
    return 0
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    if (err.stdout) process.stdout.write(err.stdout)
    if (err.stderr) process.stderr.write(err.stderr)
    console.log(`程序退出码：${err.status ?? '未知'}`)
    return 1
  }
}

function build(
  unit: CompilationUnit, file: string, run: boolean,
  flags: string[], depFiles: string[] = [], outputName?: string,
): number {
  if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true })
  const stem = outputName ?? basename(file, '.csay')
  const cPath = join(BUILD, stem + '.c')
  const exePath = join(BUILD, stem + '.exe')
  const stampPath = join(BUILD, stem + '.stamp')

  let cc
  try {
    cc = findCompiler(undefined, flags.includes('--fast'))
  } catch (e) {
    console.log('')
    console.log((e as Error).message)
    return 1
  }

  if (flags.includes('--debug')) {
    cc = { ...cc, flags: [...cc.flags, '-g'] }
  }

  const stamp = `${cc.name}|${cc.flags.join(' ')}`

  // 源码没动、编译器没换，就不重复编译。双击运行时代价是 0.7s，省下来很值。
  if (!flags.includes('--rebuild') && isUpToDate(exePath, stampPath, stamp, [file, ...depFiles])) {
    console.log(`没改动，直接运行已有程序（${cc.name}）`)
    if (!run) {
      console.log('可执行文件：' + exePath)
      return 0
    }
    return runExe(exePath)
  }

  let code: string
  try {
    code = generate(unit, file, flags.includes('--debug')).code
  } catch (e) {
    if (e instanceof Unsupported) {
      console.log('')
      console.log(`暂时不支持：${e.message}`)
      console.log('后端 v1 只覆盖变量、算术、分支、循环、函数、文本与打印。')
      return 1
    }
    throw e
  }

  writeFileSync(cPath, code, 'utf8')

  if (!existsSync(cc.path)) {
    console.log('')
    console.log(`找不到 C 编译器：${cc.path}`)
    console.log('已生成 C 源码，可手动编译：' + cPath)
    return 1
  }

  try {
    compile(cc, cPath, exePath, BUILD)
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    console.log('')
    console.log(`编译 C 失败（${cc.name}）：`)
    console.log(err.stderr ?? err.stdout ?? err.message ?? String(e))
    console.log('生成的 C 源码保留在：' + cPath)
    return 1
  }

  writeFileSync(stampPath, stamp, 'utf8')

  console.log('')
  const optNote = cc.optimized ? '（-O2）' : '（未优化）'
  console.log(`已生成：${exePath}  编译器 ${cc.name}${optNote}`)

  if (run) return runExe(exePath)
  return 0
}

process.exit(main(process.argv))
