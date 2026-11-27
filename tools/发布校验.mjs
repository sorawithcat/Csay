// 检查版本号、文档、运行时头文件和可重复的 C 代码生成。
//   node tools/发布校验.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { RUNTIME_C } from '../src/runtime.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version)

function fail(msg) {
  console.error('发布校验失败：' + msg)
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 版本号不是 x.y.z：${version}`)

const cli = execFileSync(process.execPath, [join(root, 'src/cli.ts'), '--version'], { encoding: 'utf8' }).trim()
if (cli !== `Csay ${version}`) fail(`--version 输出「${cli}」，应为「Csay ${version}」`)

const changelog = readFileSync(join(root, 'docs/手册/38-更新日志.md'), 'utf8')
if (!changelog.includes(`## ${version}`)) fail(`更新日志没有 ${version} 小节`)

const wantHeader = '/* 由 tools/导出运行时.mjs 生成，勿手改 */\n' + RUNTIME_C + '\n'
const headerPath = join(root, 'selfhost/csay_runtime.h')
if (!existsSync(headerPath) || readFileSync(headerPath, 'utf8') !== wantHeader) {
  fail('selfhost/csay_runtime.h 不是最新导出，请运行 node tools/导出运行时.mjs')
}

const work = join(root, 'build')
mkdirSync(work, { recursive: true })
const sample = '整数 平方(整数 x) { 返回 x * x; }\n打印(平方(7));\n'
const stems = ['_发布校验_a', '_发布校验_b']
try {
  for (const stem of stems) writeFileSync(join(work, stem + '.csay'), sample)
  for (const stem of stems) {
    execFileSync(process.execPath, [join(root, 'src/cli.ts'), '--build', '--fast', join(work, stem + '.csay')], {
      cwd: root, stdio: 'ignore',
    })
  }
  const hash = (stem) => createHash('sha256').update(readFileSync(join(work, stem + '.c'))).digest('hex')
  if (hash(stems[0]) !== hash(stems[1])) fail('两次生成的 C 代码不一致')
  console.log(`发布校验通过：Csay ${version}，C 代码可重复`)
} finally {
  for (const stem of stems) {
    for (const ext of ['.csay', '.c', '.exe', '.stamp']) {
      rmSync(join(work, stem + ext), { force: true })
    }
  }
}
