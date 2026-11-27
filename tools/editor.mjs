// Csay 独立编辑器：本地 HTTP 服务 + 浏览器页面。
//   node tools/editor.mjs [文件.csay | 文件夹] [--no-open]
// 工作区文件树、多标签、新建/删除文件与文件夹、实时诊断、一键编译运行。零依赖，只用 node 内置模块。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, renameSync, copyFileSync, cpSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { resolve, basename, join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const contentHash = (str) => createHash('sha1').update(String(str), 'utf8').digest('hex').slice(0, 16)
import http from 'node:http'
import { createHash } from 'node:crypto'
import { parse } from '../src/parser.ts'
import { generate } from '../src/codegen.ts'
import { loadProgram, loadProgramSource } from '../src/loader.ts'
import { findCompiler, compile } from '../src/compiler.ts'
import { checkNames } from '../src/checker.ts'
import { checkSemantics } from '../src/semantics.ts'
import { printUnit } from '../src/printer.ts'
import { renderDocsPage } from './docs.mjs'
import { verifyPackage } from './包校验.mjs'
import { findDefinition, findReferences, loadProgramSources, setIndexCache } from './符号索引.mjs'
import { renameSymbol as renameWorkspaceSymbol } from './改名.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILD = join(ROOT, 'build')
const DIST = join(ROOT, 'dist')
const PROJECT_FILE = '项目.csayproj'
const DEFAULT_PORT = 8124

setIndexCache(join(BUILD, '符号索引.bin'))

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const startArg = args.find((a) => !a.startsWith('--'))

let FILE = null
let WORKSPACE = ROOT

if (startArg) {
  const START = resolve(startArg)
  if (existsSync(START) && statSync(START).isDirectory()) {
    WORKSPACE = START
  } else {
    if (extname(START) !== '.csay') {
      console.log('只能编辑 .csay 文件：' + START)
      process.exit(1)
    }
    if (!existsSync(dirname(START))) {
      console.log('目录不存在：' + dirname(START))
      process.exit(1)
    }
    if (!existsSync(START)) {
      console.log('文件不存在：' + START)
      process.exit(1)
    }
    FILE = START
    WORKSPACE = dirname(FILE)
  }
}

if (!existsSync(WORKSPACE)) {
  console.log('目录不存在：' + WORKSPACE)
  process.exit(1)
}

function analyzeText(text, file) {
  if (file) {
    try {
      return loadProgramSource(file, text).diags
    } catch {
      // 文件路径或 引 依赖异常时退回单文件检查，保证编辑器不会因此卡死。
    }
  }
  const parsed = parse(text)
  const diags = parsed.diags.map((d) => ({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '', filePath: d.filePath ?? '' }))
  // 语法干净时才做名字检查，否则满屏噪音
  if (!diags.some((d) => d.severity === 'error')) {
    for (const d of checkNames(parsed.unit)) {
      diags.push({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '', filePath: d.filePath ?? '' })
    }
    for (const d of checkSemantics(parsed.unit)) {
      diags.push({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '', filePath: d.filePath ?? '' })
    }
  }
  return diags
}

function startConsoleWindow(exePath) {
  if (!existsSync(exePath)) return false
  mkdirSync(BUILD, { recursive: true })
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', exePath], {
      cwd: BUILD,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function openInteractiveWindow(exePath) {
  if (!existsSync(exePath)) return false
  if (process.platform === 'win32') {
    const wt = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe')
    if (existsSync(wt)) {
      try {
        const child = spawn(wt, ['-d', BUILD, exePath], { cwd: BUILD, detached: true, stdio: 'ignore' })
        child.on('error', () => startConsoleWindow(exePath))
        child.unref()
        return true
      } catch {}
    }
  }
  return startConsoleWindow(exePath)
}

function buildAndRun(file, bodyContent, fast = false) {
  if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true })
  const stem = basename(file, '.csay')
  const cPath = join(BUILD, stem + '.c')
  const exePath = join(BUILD, stem + '.exe')
  const stampPath = join(BUILD, stem + '.stamp')

  const loaded = loadProgram(file)
  const diags = loaded.diags.map((d) => ({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '', filePath: d.filePath ?? '' }))
  if (diags.some((d) => d.severity === 'error')) {
    return { ok: false, diags, output: '' }
  }

  let cc
  try {
    cc = findCompiler(undefined, fast)
  } catch (e) {
    return { ok: false, diags, output: '', error: String(e.message ?? e) }
  }
  // 增量判断用内容哈希而不是时间戳：毫秒级连续保存时时间戳可能糊在一起
  let depsHash = ''
  for (const f of loaded.files) {
    if (existsSync(f)) depsHash += contentHash(readFileSync(f, 'utf8'))
  }
  const stamp = [cc.name, cc.flags.join(' '), contentHash(bodyContent), depsHash].join('|')

  const upToDate = existsSync(exePath) && existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp

  if (!upToDate) {
    let code
    try {
      code = generate(loaded.unit, basename(file)).code
    } catch (e) {
      return { ok: false, diags, output: '', error: '代码生成失败：' + String(e.message ?? e) }
    }
    writeFileSync(cPath, code, 'utf8')
    try {
      compile(cc, cPath, exePath, BUILD)
      writeFileSync(stampPath, stamp, 'utf8')
    } catch (e) {
      const err = e
      return { ok: false, diags, output: '', error: '编译失败（' + cc.name + '）：\n' + (err.stderr ?? err.message ?? e) }
    }
  }

  // 交互程序：捕获输出会卡住 stdin，改在独立命令行窗口里跑
  if (String(bodyContent ?? '').includes('输入(') || String(bodyContent ?? '').includes('询问(')) {
    if (!openInteractiveWindow(exePath)) {
      return { ok: false, diags, output: '', error: '无法启动终端窗口，请确认程序文件存在且系统允许打开新窗口' }
    }
    return { ok: true, diags, output: '(交互程序已在终端窗口启动，请在新窗口中操作)', interactive: true }
  }

  try {
    const out = execFileSync(exePath, [], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CSAY_NO_PAUSE: '1' },
    })
    return { ok: true, diags, output: out, compiled: !upToDate }
  } catch (e) {
    const err = e
    return {
      ok: false,
      diags,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
      error: '程序退出码：' + (err.status ?? '未知'),
    }
  }
}


function pickNative(kind, startDir) {
  return new Promise((resolve) => {
    const lines = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.WindowState = "Minimized"',
      '$owner.Show()',
      'if ($env:CSAY_PICK_KIND -eq "folder") {',
      '  $d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '  $d.Description = "选择 Csay 工作区文件夹"',
      '  if ($env:CSAY_PICK_DIR -and (Test-Path $env:CSAY_PICK_DIR)) { $d.SelectedPath = $env:CSAY_PICK_DIR }',
      '  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
      '} else {',
      '  $d = New-Object System.Windows.Forms.OpenFileDialog',
      '  $d.Filter = "Csay 源文件 (*.csay)|*.csay|所有文件 (*.*)|*.*"',
      '  if ($env:CSAY_PICK_DIR -and (Test-Path $env:CSAY_PICK_DIR)) { $d.InitialDirectory = $env:CSAY_PICK_DIR }',
      '  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
      '}',
      '$owner.Close()'
    ]
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', lines.join('; ')], {
      windowsHide: true,
      env: { ...process.env, CSAY_PICK_KIND: kind, CSAY_PICK_DIR: startDir || process.cwd() },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => {
      const path = out.trim()
      resolve({ ok: code === 0 && path.length > 0, path, error: path ? '' : (err.trim() || '已取消') })
    })
  })
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve2) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve2(data))
  })
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'release', '.workbuddy'])

function buildTree(dir, depth = 0) {
  if (depth > 6) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  const files = []
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: full, dir: true, children: buildTree(full, depth + 1) })
    } else if (e.isFile() && (extname(e.name) === '.csay' || extname(e.name) === '.csayproj')) {
      files.push({ name: e.name, path: full, dir: false })
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return [...dirs, ...files]
}

function cleanName(name) {
  const n = String(name ?? '').trim()
  if (!n || n === '.' || n === '..') return ''
  if (/[\\/:*?"<>|]/.test(n)) return ''
  return n
}


function projectFile(dir) {
  try {
    const found = readdirSync(dir).filter((f) => f.endsWith('.csayproj')).sort()[0]
    if (found) return join(dir, found)
  } catch {}
  return join(dir, PROJECT_FILE)
}

function defaultProject(dir) {
  const name = basename(dir) || 'Csay 项目'
  return { name, entry: '', output: name, version: '0.2.0', exclude: [], resources: [], dependencies: [], beforeBuild: '', afterBuild: '', targets: [] }
}

function loadProjectInfo(dir) {
  const path = projectFile(dir)
  const fallback = defaultProject(dir)
  if (!existsSync(path)) return { path, exists: false, project: fallback }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return {
      path,
      exists: true,
      project: {
        name: String(data.name || fallback.name),
        entry: String(data.entry || fallback.entry),
        output: String(data.output || fallback.output),
        version: String(data.version || fallback.version),
        exclude: Array.isArray(data.exclude) ? data.exclude.map((x) => String(x)) : [],
        resources: Array.isArray(data.resources) ? data.resources.map((x) => String(x)) : [],
        dependencies: Array.isArray(data.dependencies) ? data.dependencies.map((x) => String(x)) : [],
        beforeBuild: String(data.beforeBuild ?? ''),
        afterBuild: String(data.afterBuild ?? ''),
        targets: Array.isArray(data.targets)
          ? data.targets.map((t) => ({ name: String(t?.name ?? ''), entry: String(t?.entry ?? ''), output: String(t?.output ?? '') }))
          : [],
      },
    }
  } catch (e) {
    return { path, exists: true, project: fallback, error: '项目文件不是合法 JSON：' + String(e.message ?? e) }
  }
}

function normalizeTarget(dir, raw) {
  const entry = String(raw?.entry || '').replace(/\\/g, '/')
  const output = cleanName(raw?.output)
  if (!entry) throw new Error('多目标缺少入口文件')
  if (!output) throw new Error('多目标缺少输出文件名：' + entry)
  const entryPath = resolve(dir, entry)
  const rel = relative(dir, entryPath)
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('入口文件必须位于项目目录内：' + entry)
  if (extname(entryPath) !== '.csay') throw new Error('入口文件必须是 .csay：' + entry)
  if (!existsSync(entryPath)) throw new Error('入口文件不存在：' + entry)
  return {
    name: cleanName(raw?.name) || output,
    entry: rel.replace(/\\/g, '/'),
    output,
  }
}

function normalizeProject(dir, input) {
  const fallback = defaultProject(dir)
  const name = cleanName(input?.name) || fallback.name
  const version = String(input?.version || fallback.version).replace(/[^0-9A-Za-z._-]/g, '') || '0.2.0'
  const exclude = (Array.isArray(input?.exclude) ? input.exclude : [])
    .map((x) => String(x).trim().replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((x) => x !== '')
  for (const pattern of exclude) {
    if (pattern.startsWith('..') || pattern.includes(':')) throw new Error('排除规则必须是项目目录内的相对路径：' + pattern)
  }
  const resources = (Array.isArray(input?.resources) ? input.resources : [])
    .map((x) => String(x).trim().replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((x) => x !== '')
  for (const rel of resources) {
    if (rel === '.' || rel === 'build' || rel.startsWith('build/')) throw new Error('资源路径不能是 build：' + rel)
    if (rel.startsWith('..') || rel.includes(':')) throw new Error('资源必须位于项目目录内：' + rel)
    if (!existsSync(resolve(dir, rel))) throw new Error('资源不存在：' + rel)
  }
  const dependencies = (Array.isArray(input?.dependencies) ? input.dependencies : [])
    .map((x) => String(x).trim().replace(/\\/g, '/'))
    .filter((x) => x !== '')
  for (const rel of dependencies) {
    const dep = resolve(dir, rel)
    if (dep === dir) throw new Error('项目不能依赖自己')
    if (!existsSync(join(dep, PROJECT_FILE))) throw new Error('依赖项目不存在或没有 ' + PROJECT_FILE + '：' + rel)
  }
  const rawTargets = Array.isArray(input?.targets) ? input.targets : []
  let targets = rawTargets.map((t) => normalizeTarget(dir, t))
  const output = cleanName(input?.output) || name
  if (!targets.length) {
    const entry = String(input?.entry || fallback.entry).replace(/\\/g, '/')
    if (!entry) throw new Error('请选择项目入口文件')
    const entryPath = resolve(dir, entry)
    const rel = relative(dir, entryPath)
    if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('入口文件必须位于项目目录内')
    if (extname(entryPath) !== '.csay') throw new Error('入口文件必须是 .csay')
    if (!existsSync(entryPath)) throw new Error('入口文件不存在：' + entry)
    targets = [{ name: output, entry: rel.replace(/\\/g, '/'), output }]
  }
  const seenName = new Set()
  const seenOutput = new Set()
  for (const target of targets) {
    if (seenName.has(target.name)) throw new Error('多目标名称重复：' + target.name)
    if (seenOutput.has(target.output)) throw new Error('多目标输出文件名重复：' + target.output)
    seenName.add(target.name)
    seenOutput.add(target.output)
  }
  const beforeBuild = String(input?.beforeBuild ?? '').trim()
  const afterBuild = String(input?.afterBuild ?? '').trim()
  return { name, entry: targets[0].entry, output: targets[0].output, version, exclude, resources, dependencies, beforeBuild, afterBuild, targets }
}

function globRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/')
  let out = '^'
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        out += '.*'
        i++
        if (p[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(out + '$')
}

function isExcluded(rel, patterns) {
  return patterns.some((pattern) => globRegExp(pattern).test(rel.replace(/\\/g, '/')))
}

function runProjectHook(command, dir, label) {
  const r = spawnSync(command, { cwd: dir, shell: true, stdio: 'inherit', env: { ...process.env, CSAY_NO_PAUSE: '1' } })
  if (r.error !== undefined) throw new Error(`${label}无法启动：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${label}失败，退出码：${r.status ?? '未知'}`)
}

function dependencyBuildKey(dir, dep) {
  return relative(dir, dep).replace(/\\/g, '/').replace(/\.\./g, 'up').replace(/[^0-9A-Za-z_.-]+/g, '_') || basename(dep)
}

function buildProjectDependencies(dir, dependencies) {
  for (const rel of dependencies) {
    const dep = resolve(dir, rel)
    console.log('依赖项目：' + dep)
    const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), '--project', dep, '--build'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, CSAY_NO_PAUSE: '1', CSAY_BUILD_DIR: join(BUILD, 'deps', dependencyBuildKey(dir, dep)) },
    })
    if (r.error !== undefined) throw new Error('依赖项目无法启动：' + r.error.message)
    if (r.status !== 0) throw new Error('依赖项目失败：' + rel + '（退出码 ' + (r.status ?? '未知') + '）')
  }
}

function packageProject(dir, input) {
  const project = normalizeProject(dir, input)
  if (project.dependencies.length > 0) buildProjectDependencies(dir, project.dependencies)
  if (project.beforeBuild) runProjectHook(project.beforeBuild, dir, '构建前命令')
  const info = loadProjectInfo(dir)
  const targets = project.targets
  const multi = targets.length > 1
  const stage = join(BUILD, 'package', project.output)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const cc = findCompiler(undefined, true)
  const built = []
  for (const target of targets) {
    const entry = resolve(dir, target.entry)
    if (!existsSync(entry)) throw new Error('入口文件不存在：' + target.entry)
    const loaded = loadProgram(entry)
    const errors = loaded.diags.filter((d) => d.severity === 'error')
    if (errors.length) {
      const first = errors[0]
      throw new Error(`编译失败（${target.name}）：第 ${first.line} 行，第 ${first.col} 列 — ${first.message}`)
    }
    const targetStage = multi ? join(stage, target.name) : stage
    mkdirSync(targetStage, { recursive: true })
    for (const rel of project.resources || []) {
      const src = resolve(dir, rel)
      const dest = join(targetStage, rel)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
    }
    const cPath = join(BUILD, 'package', (multi ? target.name + '-' : '') + target.output + '.c')
    const exePath = join(targetStage, target.output + '.exe')
    writeFileSync(cPath, generate(loaded.unit, basename(entry)).code, 'utf8')
    compile(cc, cPath, exePath, BUILD)

    const sourceDir = join(targetStage, '源码')
    for (const f of loaded.files) {
      const rel = relative(dir, f)
      if (!rel || rel.startsWith('..') || rel.includes(':')) continue
      if (isExcluded(rel, project.exclude)) continue
      const dest = join(sourceDir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f, dest)
    }
    writeFileSync(join(targetStage, 'README.txt'), [
      project.name + (multi ? ' · ' + target.name : ''),
      '版本：' + project.version,
      '入口：' + target.entry,
      '',
      '运行：双击 ' + target.output + '.exe',
      '源码在 源码/ 目录。',
      '',
    ].join('\r\n'), 'utf8')
    built.push({ name: target.name, entry: target.entry, output: target.output, exe: exePath })
  }
  if (project.afterBuild) runProjectHook(project.afterBuild, dir, '构建后命令')
  if (info.exists) {
    copyFileSync(info.path, join(stage, basename(info.path)))
  }
  if (multi) {
    writeFileSync(join(stage, 'README.txt'), [
      project.name,
      '版本：' + project.version,
      '',
      '目标：',
      ...built.map((t) => '- ' + t.name + '：' + t.entry + ' → ' + t.output + '.exe'),
      '',
    ].join('\r\n'), 'utf8')
  }

  mkdirSync(DIST, { recursive: true })
  const zipPath = join(DIST, `${project.output}-${project.version}.zip`)
  rmSync(zipPath, { force: true })
  const ps = `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })
  let verified
  try {
    verified = verifyPackage(zipPath, stage)
  } catch (err) {
    rmSync(zipPath, { force: true })
    throw err
  }
  return { ok: true, zip: zipPath, exe: built[0]?.exe, targets: built, project, output: '已打包：' + zipPath + `（校验 ${verified.files} 个文件）` }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname.startsWith('/codemirror/')) {
    const rel = decodeURIComponent(url.pathname.slice('/codemirror/'.length))
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('/')) return json(res, 404, { error: 'not found' })
    const file = join(ROOT, 'tools', 'codemirror', rel)
    if (!existsSync(file)) return json(res, 404, { error: 'not found' })
    const type = rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/editor/')) {
    const rel = decodeURIComponent(url.pathname.slice('/editor/'.length))
    if (!/^[\w.-]+\.(js|css)$/.test(rel)) return json(res, 404, { error: 'not found' })
    const file = join(ROOT, 'tools', 'editor', rel)
    if (!existsSync(file)) return json(res, 404, { error: 'not found' })
    const type = rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
    return
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(readFileSync(join(ROOT, 'tools', 'editor.html'), 'utf8'))
    return
  }

  if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname.startsWith('/docs/'))) {
    const raw = url.pathname === '/docs' ? '' : url.pathname.slice('/docs/'.length)
    let id = ''
    try {
      id = decodeURIComponent(raw)
    } catch {
      id = ''
    }
    const page = renderDocsPage(id)
    if (page === null) {
      res.writeHead(302, { Location: '/docs' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(page)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/load') {
    const requested = url.searchParams.get('file') ?? FILE
    if (!requested) return json(res, 404, { error: '没有打开文件' })
    const f = resolve(requested)
    if (extname(f) !== '.csay') return json(res, 400, { error: '只能打开 .csay 文件' })
    if (!existsSync(f)) return json(res, 404, { error: '文件不存在' })
    return json(res, 200, { file: f, name: basename(f), dir: dirname(f), content: readFileSync(f, 'utf8').replace(/^\uFEFF/, '') })
  }

  if (req.method === 'GET' && url.pathname === '/api/tree') {
    const dir = resolve(url.searchParams.get('dir') || WORKSPACE)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return json(res, 404, { error: '文件夹不存在' })
    return json(res, 200, {
      dir,
      name: basename(dir),
      parent: dirname(dir) === dir ? null : dirname(dir),
      entries: buildTree(dir),
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/save') {
    const body = JSON.parse(await readBody(req))
    const f = resolve(String(body.file ?? ''))
    if (extname(f) !== '.csay') return json(res, 400, { error: '只能保存 .csay 文件' })
    if (!existsSync(dirname(f))) return json(res, 400, { error: '目录不存在' })
    writeFileSync(f, String(body.content ?? ''), 'utf8')
    return json(res, 200, { ok: true, file: f })
  }

  if (req.method === 'POST' && url.pathname === '/api/new') {
    const body = JSON.parse(await readBody(req))
    const dir = resolve(String(body.dir ?? WORKSPACE))
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return json(res, 400, { error: '目标文件夹不存在' })
    const name = cleanName(body.name)
    if (!name) return json(res, 400, { error: '文件名不能为空，也不能包含 \\ / : * ? " < > |' })
    const kind = body.kind === 'dir' ? 'dir' : 'file'
    const target = kind === 'dir' ? join(dir, name) : join(dir, name.endsWith('.csay') ? name : name + '.csay')
    if (existsSync(target)) return json(res, 409, { error: '同名文件或文件夹已存在' })
    try {
      if (kind === 'dir') mkdirSync(target)
      else writeFileSync(target, '// 新文件\n打印("你好");\n', { encoding: 'utf8', flag: 'wx' })
    } catch (e) {
      return json(res, 500, { error: '创建失败：' + String(e.message ?? e) })
    }
    return json(res, 200, { ok: true, path: target, dir: kind === 'dir' })
  }

  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = JSON.parse(await readBody(req))
    const p = resolve(String(body.path ?? ''))
    const root = resolve(String(body.root ?? WORKSPACE))
    if (p === root || p === ROOT || dirname(p) === p) return json(res, 400, { error: '不能删除这个目录' })
    if (!existsSync(p)) return json(res, 404, { error: '文件或文件夹不存在' })
    const isDir = statSync(p).isDirectory()
    if (!isDir && extname(p) !== '.csay') return json(res, 400, { error: '只能删除 .csay 文件或文件夹' })
    try {
      rmSync(p, { recursive: true, force: false })
    } catch (e) {
      return json(res, 500, { error: '删除失败：' + String(e.message ?? e) })
    }
    return json(res, 200, { ok: true })
  }

  if (req.method === 'POST' && url.pathname === '/api/rename') {
    const body = JSON.parse(await readBody(req))
    const p = resolve(String(body.path ?? ''))
    if (p === ROOT || dirname(p) === p) return json(res, 400, { error: '不能重命名这个目录' })
    if (!existsSync(p)) return json(res, 404, { error: '文件或文件夹不存在' })
    const isDir = statSync(p).isDirectory()
    if (!isDir && extname(p) !== '.csay') return json(res, 400, { error: '只能重命名 .csay 文件或文件夹' })
    let name = cleanName(body.name)
    if (!name) return json(res, 400, { error: '名称不能为空，也不能包含 \\ / : * ? " < > |' })
    if (!isDir && !name.endsWith('.csay')) name += '.csay'
    const target = join(dirname(p), name)
    if (target === p) return json(res, 200, { ok: true, path: p })
    if (existsSync(target)) return json(res, 409, { error: '同名文件或文件夹已存在' })
    try {
      renameSync(p, target)
    } catch (e) {
      return json(res, 500, { error: '重命名失败：' + String(e.message ?? e) })
    }
    return json(res, 200, { ok: true, path: target })
  }

  if (req.method === 'POST' && url.pathname === '/api/reveal') {
    const body = JSON.parse(await readBody(req))
    const p = resolve(String(body.path ?? ''))
    if (!existsSync(p)) return json(res, 404, { error: '文件或文件夹不存在' })
    try {
      if (statSync(p).isDirectory()) spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref()
      else spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref()
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) })
    }
    return json(res, 200, { ok: true })
  }

  if (req.method === 'POST' && url.pathname === '/api/pick') {
    const body = JSON.parse(await readBody(req))
    const result = await pickNative(body.kind === 'file' ? 'file' : 'folder', String(body.dir ?? WORKSPACE))
    return json(res, 200, result)
  }

  if (req.method === 'POST' && url.pathname === '/api/rename-symbol') {
    const body = JSON.parse(await readBody(req))
    const f = resolve(String(body.file ?? ''))
    if (extname(f) !== '.csay') return json(res, 400, { error: '只能重命名 .csay 文件' })
    const next = String(body.next ?? '')
    if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(next)) {
      return json(res, 400, { error: '名字只能由字母、数字、下划线或汉字组成，且不能以数字开头' })
    }
    try {
      const d = renameWorkspaceSymbol(f, String(body.text ?? ''), Number(body.line), Number(body.col), next, String(body.workspace ?? ''))
      return json(res, d.error ? 400 : 200, d)
    } catch (e) {
      return json(res, 500, { error: '重命名失败：' + String(e.message ?? e) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/sources') {
    const body = JSON.parse(await readBody(req))
    const file = resolve(String(body.file ?? FILE ?? ''))
    const text = String(body.text ?? '')
    try {
      return json(res, 200, { files: loadProgramSources(file, text) })
    } catch (e) {
      return json(res, 200, { files: [], error: String(e.message ?? e) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    const body = JSON.parse(await readBody(req))
    return json(res, 200, { diags: analyzeText(String(body.text ?? ''), String(body.file ?? FILE ?? '')) })
  }

  if (req.method === 'POST' && url.pathname === '/api/format') {
    const body = JSON.parse(await readBody(req))
    const parsed = parse(String(body.text ?? ''))
    const err = parsed.diags.find((d) => d.severity === 'error')
    if (err) return json(res, 200, { ok: false, error: `第 ${err.line} 行，第 ${err.col} 列：${err.message}` })
    const indent = typeof body.indent === 'string' ? body.indent.slice(0, 8) : undefined
    const braceStyle = body.braceStyle === 'next' ? 'next' : 'same'
    const content = printUnit(parsed.unit, { indent, braceStyle }).trimEnd()
    return json(res, 200, { ok: true, content: content + '\n' })
  }

  if (req.method === 'POST' && url.pathname === '/api/definition') {
    const body = JSON.parse(await readBody(req))
    const file = resolve(String(body.file ?? FILE ?? ''))
    const text = String(body.text ?? '')
    try {
      return json(res, 200, findDefinition(file, text, Number(body.line ?? 1), Number(body.col ?? 1)))
    } catch (e) {
      return json(res, 200, { found: false, name: '', definition: null, error: String(e.message ?? e) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/references') {
    const body = JSON.parse(await readBody(req))
    const file = resolve(String(body.file ?? FILE ?? ''))
    const text = String(body.text ?? '')
    try {
      return json(res, 200, findReferences(file, text, Number(body.line ?? 1), Number(body.col ?? 1), resolve(String(body.workspace ?? WORKSPACE))))
    } catch (e) {
      return json(res, 200, { found: false, name: '', refs: [], truncated: false, error: String(e.message ?? e) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/run-snippet') {
    const body = JSON.parse(await readBody(req))
    if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true })
    const f = join(BUILD, '_snippet.csay')
    writeFileSync(f, String(body.code ?? ''), 'utf8')
    const r = buildAndRun(f, String(body.code ?? ''), true)
    return json(res, 200, r)
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = JSON.parse(await readBody(req))
    const f = resolve(String(body.file ?? FILE))
    if (extname(f) !== '.csay') return json(res, 400, { error: '只能运行 .csay 文件' })
    writeFileSync(f, String(body.content ?? ''), 'utf8')
    const r = buildAndRun(f, String(body.content ?? ""))
    return json(res, 200, r)
  }

  if (req.method === 'GET' && url.pathname === '/api/project') {
    const dir = resolve(url.searchParams.get('dir') || WORKSPACE)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return json(res, 404, { error: '项目文件夹不存在' })
    return json(res, 200, loadProjectInfo(dir))
  }

  if (req.method === 'POST' && url.pathname === '/api/project') {
    const body = JSON.parse(await readBody(req))
    const dir = resolve(String(body.dir || WORKSPACE))
    try {
      const project = normalizeProject(dir, body.project)
      const target = body.path ? resolve(String(body.path)) : projectFile(dir)
      if (extname(target) !== '.csayproj') return json(res, 400, { error: '项目文件必须以 .csayproj 结尾' })
      writeFileSync(target, JSON.stringify(project, null, 2) + '\n', 'utf8')
      return json(res, 200, { ok: true, path: target, project })
    } catch (e) {
      return json(res, 400, { error: String(e.message ?? e) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/package') {
    const body = JSON.parse(await readBody(req))
    const dir = resolve(String(body.dir || WORKSPACE))
    try {
      return json(res, 200, packageProject(dir, body.project))
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message ?? e) })
    }
  }

  res.writeHead(404)
  res.end('not found')
})

let listeningPort = DEFAULT_PORT

function onEditorReady() {
  listeningPort = server.address().port
  const query = FILE ? '&file=' + encodeURIComponent(FILE) : ''
  const url = 'http://127.0.0.1:' + listeningPort + '/?v=' + Date.now() + query
  console.log('编辑器已启动：' + url)
  if (FILE) console.log('编辑的文件：' + FILE)
  else console.log('工作区：' + WORKSPACE)
  console.log('关闭本窗口即退出编辑器。')
  if (!noOpen) {
    try {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } catch {}
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listeningPort === DEFAULT_PORT) {
    console.log('端口 ' + DEFAULT_PORT + ' 已被占用，改用空闲端口启动新的编辑器。')
    listeningPort = 0
    server.listen(0, '127.0.0.1', onEditorReady)
    return
  }
  throw err
})

server.listen(DEFAULT_PORT, '127.0.0.1', onEditorReady)

