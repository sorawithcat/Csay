// Csay 独立编辑器：本地 HTTP 服务 + 浏览器页面。
//   node tools/editor.mjs [文件.csay | 文件夹] [--no-open]
// 工作区文件树、多标签、新建/删除文件与文件夹、实时诊断、一键编译运行。零依赖，只用 node 内置模块。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, renameSync, copyFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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
import { renderDocsPage } from './docs.mjs'
import { findDefinition, findReferences } from './符号索引.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILD = join(ROOT, 'build')
const DIST = join(ROOT, 'dist')
const PROJECT_FILE = '项目.csayproj'
const DEFAULT_PORT = 8124

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
  const diags = parsed.diags.map((d) => ({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '' }))
  // 语法干净时才做名字检查，否则满屏噪音
  if (!diags.some((d) => d.severity === 'error')) {
    for (const d of checkNames(parsed.unit)) {
      diags.push({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '' })
    }
  }
  return diags
}

function buildAndRun(file, bodyContent, fast = false) {
  if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true })
  const stem = basename(file, '.csay')
  const cPath = join(BUILD, stem + '.c')
  const exePath = join(BUILD, stem + '.exe')
  const stampPath = join(BUILD, stem + '.stamp')

  const loaded = loadProgram(file)
  const diags = loaded.diags.map((d) => ({ severity: d.severity, line: d.line, col: d.col, message: d.message, hint: d.hint ?? '', file: d.file ?? '' }))
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
    spawn('cmd.exe', ['/c', 'start', 'Csay 运行', exePath], { cwd: BUILD, detached: true, stdio: 'ignore' }).unref()
    return { ok: true, diags, output: '(交互程序已在新窗口启动，请在新窗口中操作)', interactive: true }
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
  let entry = '主.csay'
  if (!existsSync(join(dir, entry))) {
    try {
      const first = readdirSync(dir).find((f) => f.endsWith('.csay'))
      if (first) entry = first
    } catch {}
  }
  const name = basename(dir) || 'Csay 项目'
  return { name, entry, output: name, version: '0.1.0' }
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
      },
    }
  } catch (e) {
    return { path, exists: true, project: fallback, error: '项目文件不是合法 JSON：' + String(e.message ?? e) }
  }
}

function normalizeProject(dir, input) {
  const fallback = defaultProject(dir)
  const name = cleanName(input?.name) || fallback.name
  const entry = String(input?.entry || fallback.entry).replace(/\\/g, '/')
  const output = cleanName(input?.output) || name
  const version = String(input?.version || fallback.version).replace(/[^0-9A-Za-z._-]/g, '') || '0.1.0'
  const entryPath = resolve(dir, entry)
  const rel = relative(dir, entryPath)
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('入口文件必须位于项目目录内')
  if (extname(entryPath) !== '.csay') throw new Error('入口文件必须是 .csay')
  if (!existsSync(entryPath)) throw new Error('入口文件不存在：' + entry)
  return { name, entry: rel.replace(/\\/g, '/'), output, version }
}

function packageProject(dir, input) {
  const project = normalizeProject(dir, input)
  const info = loadProjectInfo(dir)
  const entry = resolve(dir, project.entry)
  if (!existsSync(entry)) throw new Error('入口文件不存在：' + project.entry)
  const loaded = loadProgram(entry)
  const errors = loaded.diags.filter((d) => d.severity === 'error')
  if (errors.length) {
    const first = errors[0]
    throw new Error(`编译失败：第 ${first.line} 行，第 ${first.col} 列 — ${first.message}`)
  }
  const cc = findCompiler(undefined, true)
  const stage = join(BUILD, 'package', project.output)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const cPath = join(BUILD, 'package', project.output + '.c')
  const exePath = join(stage, project.output + '.exe')
  writeFileSync(cPath, generate(loaded.unit, basename(entry)).code, 'utf8')
  compile(cc, cPath, exePath, BUILD)

  const sourceDir = join(stage, '源码')
  for (const f of loaded.files) {
    const rel = relative(dir, f)
    if (!rel || rel.startsWith('..') || rel.includes(':')) continue
    const target = join(sourceDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(f, target)
  }
  if (info.exists) copyFileSync(info.path, join(stage, basename(info.path)))
  writeFileSync(join(stage, 'README.txt'), [
    project.name,
    '版本：' + project.version,
    '入口：' + project.entry,
    '',
    '运行：双击 ' + project.output + '.exe',
    '源码在 源码/ 目录。',
    '',
  ].join('\r\n'), 'utf8')

  mkdirSync(DIST, { recursive: true })
  const zipPath = join(DIST, `${project.output}-${project.version}.zip`)
  rmSync(zipPath, { force: true })
  const ps = `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })
  return { ok: true, zip: zipPath, exe: exePath, project, output: '已打包：' + zipPath }
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
    return json(res, 200, { file: f, name: basename(f), dir: dirname(f), content: readFileSync(f, 'utf8') })
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

  if (req.method === 'POST' && url.pathname === '/api/check') {
    const body = JSON.parse(await readBody(req))
    return json(res, 200, { diags: analyzeText(String(body.text ?? ''), String(body.file ?? FILE ?? '')) })
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

