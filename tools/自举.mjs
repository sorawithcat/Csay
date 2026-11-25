// Csay 自举构建：stage0（TS）→ stage1（Csay）→ stage2（Csay 编译自身）
//   node tools/自举.mjs
// 成功条件是 stage2 与 stage3 的 C 输出逐字节一致。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILD = join(ROOT, 'build')
const TCC = join(ROOT, 'tools', 'tcc', 'tcc.exe')
const COMPILER = join(ROOT, 'selfhost', '编译器.csay')

const run = (cmd, args, options = {}) => {
  process.stdout.write('> ' + [cmd, ...args].join(' ') + '\n')
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const compileC = (cFile, exeFile) => {
  run(TCC, ['-I', join(ROOT, 'selfhost'), '-o', exeFile, cFile])
}

mkdirSync(BUILD, { recursive: true })
run(process.execPath, [join(ROOT, 'tools', '导出运行时.mjs')])
for (const f of ['编译器1.c', '编译器2.c', '编译器3.c', '编译器1.exe', '编译器2.exe']) {
  const p = join(BUILD, f)
  if (existsSync(p)) rmSync(p)
}

// stage0：现有 TS 编译器编译 Csay 写的第一代编译器
run(process.execPath, [join(ROOT, 'src', 'cli.ts'), COMPILER, '--fast', '--rebuild', '--build'])
const stage0 = join(BUILD, '编译器.exe')

// stage1：Csay 编译器编译自身
const c1 = join(BUILD, '编译器1.c')
run(stage0, [COMPILER, c1])
const exe1 = join(BUILD, '编译器1.exe')
compileC(c1, exe1)

// stage2：第一代自举编译器再编译自身
const c2 = join(BUILD, '编译器2.c')
run(exe1, [COMPILER, c2])
const exe2 = join(BUILD, '编译器2.exe')
compileC(c2, exe2)

// stage3：第二代再编译自身，C 输出必须与 stage2 完全一致
const c3 = join(BUILD, '编译器3.c')
run(exe2, [COMPILER, c3])
if (sha(c2) !== sha(c3)) {
  console.error('\n自举失败：stage2 与 stage3 的 C 输出不一致')
  console.error('  ' + c2)
  console.error('  ' + c3)
  process.exit(1)
}
console.log('\n固定点成立：编译器2.c === 编译器3.c')
console.log('\n自举通过：Csay 编译器用 Csay 编译了自己，并达到 C 输出固定点。')
