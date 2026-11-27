// Csay 命令行入口。
//   csay a.csay          编译并运行（源码没改就跳过编译）
//   csay a.csay --build  只编译
//   csay a.csay --check  只做语法、名字、成员、参数和类型检查
//   csay a.csay --rebuild 强制重新编译
//   csay a.csay --format  按规范格式重写源文件
//   csay --project 目录  读取 项目.csayproj 的入口并编译
//   --debug  生成 #line 源码映射，并让 C 编译器带调试信息
//   --tokens  列出词法单元
//   --print   解析后把语法树还原成规范源码

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, cpSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, basename, join, relative, dirname } from 'node:path'
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
const BUILD = process.env.CSAY_BUILD_DIR ? resolve(process.env.CSAY_BUILD_DIR) : join(ROOT, 'build')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string

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

function compileProjectTarget(
  dir: string,
  target: { name: string; entry: string; output: string },
  flags: string[],
): number {
  const path = resolve(dir, target.entry)
  let src: string
  try {
    src = readFileSync(path, 'utf8')
  } catch {
    console.log(`读不到文件：${path}`)
    return 2
  }
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
  const all = loaded.diags
  if (all.length > 0) {
    const sourceFor = (name: string): string => {
      const dep = existsSync(name) ? name : loaded.files.find((f) => basename(f) === name)
      return dep === undefined ? src : readFileSync(dep, 'utf8')
    }
    console.log('')
    console.log(formatAll(all, src, sourceFor))
  } else {
    console.log('检查通过，没有发现问题。')
  }
  if (flags.includes('--print')) {
    console.log('')
    console.log('---- 语法树还原 ----')
    console.log(printUnit(loaded.unit))
  }
  if (flags.includes('--tokens')) {
    const real = lex.tokens.filter((t) => t.kind !== 'eof')
    console.log('')
    console.log(`Token 共 ${real.length} 个：`)
    for (const t of real) console.log(`  ${`${t.line}:${t.col}`.padEnd(7)}${t.kind.padEnd(9)}${describe(t)}`)
  }
  if (all.some((d) => d.severity === 'error')) return 1
  if (flags.includes('--check') || flags.includes('--print') || flags.includes('--tokens')) return 0
  return build(loaded.unit, path, false, flags, loaded.files, target.output, BUILD)
}

function copyProjectResources(dir: string, resources: string[]): boolean {
  for (const rel of resources) {
    const src = resolve(dir, rel)
    const dest = join(BUILD, rel)
    if (!existsSync(src)) {
      console.log(`项目资源不存在：${rel}`)
      return false
    }
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
  return true
}

function runProjectHook(command: string, dir: string, label: string): boolean {
  console.log('')
  console.log(`${label}：${command}`)
  const r = spawnSync(command, { cwd: dir, shell: true, stdio: 'inherit', env: { ...process.env, CSAY_NO_PAUSE: '1' } })
  if (r.error !== undefined) {
    console.log(`${label}无法启动：${r.error.message}`)
    return false
  }
  if (r.status !== 0) {
    console.log(`${label}失败，退出码：${r.status ?? '未知'}`)
    return false
  }
  return true
}

/** 依赖项目先按顺序构建或检查；每个依赖使用独立 build 目录，避免输出名冲突。 */
function runDependencyProjects(dir: string, dependencies: string[], flags: string[]): boolean {
  if (dependencies.length === 0) return true
  const stack = (process.env.CSAY_PROJECT_STACK ?? '').split(';').filter(Boolean).map((x) => resolve(x))
  if (stack.some((x) => x === dir)) {
    console.log(`项目依赖出现循环：${dir}`)
    return false
  }
  const nextStack = [...stack, dir].join(';')
  for (const dep of dependencies) {
    if (dep === dir || stack.some((x) => x === dep)) {
      console.log(`项目依赖出现循环：${dep}`)
      return false
    }
    const key = relative(dir, dep).replace(/\\/g, '/').replace(/\.\./g, 'up').replace(/[^0-9A-Za-z_.-]+/g, '_') || basename(dep)
    const depBuild = join(BUILD, 'deps', key)
    console.log('')
    console.log(`依赖项目：${dep}`)
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--project', dep, ...flags], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, CSAY_NO_PAUSE: '1', CSAY_BUILD_DIR: depBuild, CSAY_PROJECT_STACK: nextStack },
    })
    if (r.error !== undefined) {
      console.log(`依赖项目无法启动：${r.error.message}`)
      return false
    }
    if (r.status !== 0) {
      console.log(`依赖项目失败，退出码：${r.status ?? '未知'}`)
      return false
    }
  }
  return true
}

function main(argv: string[]): number {
  const args = argv.slice(2)
  const flags = args.filter((a) => a.startsWith('--'))
  let file = args.find((a) => !a.startsWith('--'))
  const testMode = flags.includes('--test')
  const projectMode = flags.includes('--project')
  let outputName: string | undefined
  let projectAfterBuild: (() => boolean) | undefined
  let runCwd: string | undefined

  if (flags.includes('--version')) {
    console.log(`Csay ${VERSION}`)
    return 0
  }

  if (file === undefined && !testMode && !projectMode) {
    console.log(`用法：csay <文件.csay> [选项]
       csay --test [目录]
       csay --project [目录]

  （不带选项）  编译并运行
  --version    显示版本号
  --build      只编译成 exe，不运行
  --check      只做语法、名字、成员、参数和类型检查
  --test       运行 tests 目录（或指定目录）里的所有 .csay 测试
  --project    读取项目目录里的 项目.csayproj，先构建依赖项目，再按 entry 或 targets 编译
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
    const projectPath = join(dir, '项目.csayproj')
    if (!existsSync(projectPath)) {
      console.log(`项目目录里没有 项目.csayproj：${dir}`)
      return 2
    }
    let project: { entry?: string; output?: string; resources?: string[]; dependencies?: string[]; beforeBuild?: string; afterBuild?: string; targets?: Array<{ name?: string; entry?: string; output?: string }> }
    try {
      project = JSON.parse(readFileSync(projectPath, 'utf8'))
    } catch {
      console.log(`项目文件不是合法 JSON：${projectPath}`)
      return 2
    }
    const dependencies: string[] = []
    if (project.dependencies !== undefined) {
      if (!Array.isArray(project.dependencies)) {
        console.log('项目字段 dependencies 必须是路径数组')
        return 2
      }
      for (const raw of project.dependencies) {
        const rel = String(raw ?? '').trim().replace(/\\/g, '/')
        if (!rel) continue
        const dep = resolve(dir, rel)
        if (dep === dir) {
          console.log('项目不能依赖自己')
          return 2
        }
        if (!existsSync(join(dep, '项目.csayproj'))) {
          console.log(`依赖项目不存在或没有 项目.csayproj：${rel}`)
          return 2
        }
        dependencies.push(dep)
      }
    }

    const resources: string[] = []
    if (project.resources !== undefined) {
      if (!Array.isArray(project.resources)) {
        console.log('项目字段 resources 必须是路径数组')
        return 2
      }
      for (const raw of project.resources) {
        const rel = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
        if (!rel || rel === '.' || rel === 'build' || rel.startsWith('build/')) {
          console.log(`项目资源路径不合法：${String(raw ?? '')}`)
          return 2
        }
        if (rel.startsWith('..') || rel.includes(':')) {
          console.log(`项目资源必须位于项目目录内：${rel}`)
          return 2
        }
        if (!existsSync(resolve(dir, rel))) {
          console.log(`项目资源不存在：${rel}`)
          return 2
        }
        resources.push(rel)
      }
    }
    const targets: Array<{ name: string; entry: string; output: string }> = []
    const rawTargets = Array.isArray(project.targets) ? project.targets : []
    const entries = rawTargets.length > 0
      ? rawTargets
      : [{ entry: project.entry, output: project.output }]
    for (const raw of entries) {
      const entryName = String(raw.entry ?? '').trim()
      if (!entryName) {
        console.log('项目文件没有设置 entry')
        return 2
      }
      const entry = resolve(dir, entryName)
      const rel = relative(dir, entry)
      if (!rel || rel.startsWith('..') || rel.includes(':')) {
        console.log(`项目入口必须位于项目目录内：${entryName}`)
        return 2
      }
      if (!existsSync(entry)) {
        console.log(`项目入口不存在：${entryName}`)
        return 2
      }
      const outputName = String(raw.output ?? '').trim() || (rawTargets.length === 0 ? basename(dir) : basename(entry, '.csay'))
      if (!outputName) {
        console.log(`项目目标缺少输出名：${entryName}`)
        return 2
      }
      targets.push({ name: String(raw.name ?? '').trim() || outputName, entry: rel.replace(/\\/g, '/'), output: outputName })
    }
    const seen = new Set<string>()
    for (const target of targets) {
      if (seen.has(target.output)) {
        console.log(`项目目标输出名重复：${target.output}`)
        return 2
      }
      seen.add(target.output)
    }
    const copyResources =
      resources.length > 0 &&
      !flags.includes('--check') &&
      !flags.includes('--format') &&
      !flags.includes('--print') &&
      !flags.includes('--tokens')
    const runBuildHooks =
      !flags.includes('--check') &&
      !flags.includes('--format') &&
      !flags.includes('--print') &&
      !flags.includes('--tokens')
    const beforeBuild = typeof project.beforeBuild === 'string' ? project.beforeBuild.trim() : ''
    const afterBuild = typeof project.afterBuild === 'string' ? project.afterBuild.trim() : ''
    const dependencyFlags = flags.includes('--check') ? ['--check'] : ['--build']
    for (const f of ['--fast', '--debug', '--rebuild']) if (flags.includes(f)) dependencyFlags.push(f)
    if (!flags.includes('--format') && !flags.includes('--print') && !flags.includes('--tokens') && !runDependencyProjects(dir, dependencies, dependencyFlags)) return 1
    if (runBuildHooks && beforeBuild !== '' && !runProjectHook(beforeBuild, dir, '构建前命令')) return 1
    if (copyResources && !copyProjectResources(dir, resources)) return 2
    if (targets.length > 1) {
      let failed = false
      for (const target of targets) {
        console.log(`\n项目目标：${target.name}（${target.entry} -> ${target.output}）`)
        if (compileProjectTarget(dir, target, flags) !== 0) failed = true
      }
      if (!failed && runBuildHooks && afterBuild !== '' && !runProjectHook(afterBuild, dir, '构建后命令')) return 1
      return failed ? 1 : 0
    }
    file = resolve(dir, targets[0].entry)
    outputName = targets[0].output
    runCwd = BUILD
    if (runBuildHooks && afterBuild !== '') {
      projectAfterBuild = () => runProjectHook(afterBuild, dir, '构建后命令')
    }
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
    const sourceFor = (name: string): string => {
      const dep = existsSync(name) ? name : loaded.files.find((f) => basename(f) === name)
      return dep === undefined ? src : readFileSync(dep, 'utf8')
    }
    console.log('')
    console.log(formatAll(all, src, sourceFor))
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
  //   csay a.csay --check  检查语法、名字、成员和参数数量
  if (flags.includes('--check')) return 0
  return build(unit, path, !flags.includes('--build'), flags, loaded.files, outputName, runCwd, projectAfterBuild)
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

function runExe(exePath: string, cwd?: string): number {
  console.log('---- 运行输出 ----')
  try {
    // 由 csay 启动的进程不该在结束时停下来等回车，那是给双击准备的
    const out = execFileSync(exePath, [], {
      encoding: 'utf8',
      cwd,
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
  flags: string[], depFiles: string[] = [], outputName?: string, runCwd?: string,
  afterBuild?: () => boolean,
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
    if (afterBuild !== undefined && !afterBuild()) return 1
    if (!run) {
      console.log(`没改动，直接使用已有程序（${cc.name}）`)
      console.log('可执行文件：' + exePath)
      return 0
    }
    console.log(`没改动，直接运行已有程序（${cc.name}）`)
    return runExe(exePath, runCwd)
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

  if (afterBuild !== undefined && !afterBuild()) return 1
  if (run) return runExe(exePath, runCwd)
  return 0
}

process.exit(main(process.argv))
