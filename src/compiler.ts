// C 编译器探测与调用。
// 优先用能开优化的 clang / gcc（-O2），都没有时退回随仓库携带的 TCC。
// 可用环境变量 CSAY_CC 指定任意 C 编译器。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface CCompiler {
  /** 展示用名字 */
  name: string
  /** 可执行文件路径 */
  path: string
  /** 是否支持 -O2 */
  optimized: boolean
  /** 编译命令的额外参数（不含源文件与输出） */
  flags: string[]
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLED_TCC = join(ROOT, 'tools', 'tcc', 'tcc.exe')
/** zig 自带 clang 前端和 libc，解压即用，不需要装 LLVM */
const BUNDLED_ZIG = join(ROOT, 'tools', 'zig', 'zig.exe')

function locate(cmd: string): string | null {
  // 直接给了路径
  if (cmd.includes('/') || cmd.includes('\\')) {
    return existsSync(cmd) ? cmd : null
  }
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(which, [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)[0]
    return first ?? null
  } catch {
    return null
  }
}

/** 常见但不在 PATH 里的安装位置 */
const FALLBACK_PATHS: Record<string, string[]> = {
  clang: [
    'C:\\Program Files\\LLVM\\bin\\clang.exe',
    'C:\\Program Files (x86)\\LLVM\\bin\\clang.exe',
    '/usr/bin/clang',
    '/usr/local/bin/clang',
  ],
  gcc: ['/usr/bin/gcc', '/usr/local/bin/gcc'],
}

function findWithPaths(cmd: string): string | null {
  const direct = locate(cmd)
  if (direct !== null) return direct
  for (const p of FALLBACK_PATHS[cmd] ?? []) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 选编译器。
 *   fast = true  → 直接用手边的 TCC，编译最快（约 0.05s），产物不优化
 *   fast = false → 优先能开 -O2 的：系统 clang → gcc → 自带 zig(clang) → TCC
 */
export function findCompiler(preferred?: string, fast = false): CCompiler {
  const envCC = preferred ?? process.env.CSAY_CC

  if (envCC !== undefined && envCC.length > 0) {
    const p = findWithPaths(envCC)
    if (p === null) {
      throw new Error(`CSAY_CC 指定的编译器找不到：${envCC}`)
    }
    const isTcc = /tcc/i.test(p)
    return {
      name: isTcc ? 'tcc' : 'custom',
      path: p,
      optimized: !isTcc,
      flags: isTcc ? [] : ['-O2', ...(process.platform === 'win32' ? [] : ['-lm'])],
    }
  }

  if (fast) {
    return { name: 'tcc', path: BUNDLED_TCC, optimized: false, flags: [] }
  }

  const clang = findWithPaths('clang')
  if (clang !== null) {
    return {
      name: 'clang',
      path: clang,
      optimized: true,
      flags: ['-O2', ...(process.platform === 'win32' ? [] : ['-lm'])],
    }
  }

  const gcc = findWithPaths('gcc')
  if (gcc !== null) {
    return {
      name: 'gcc',
      path: gcc,
      optimized: true,
      flags: ['-O2', ...(process.platform === 'win32' ? [] : ['-lm'])],
    }
  }

  // 自带 zig：它里面就是 clang，命令形式是 `zig cc`
  if (existsSync(BUNDLED_ZIG)) {
    return {
      name: 'zig cc (clang 18)',
      path: BUNDLED_ZIG,
      optimized: true,
      flags: ['cc', '-O2', ...(process.platform === 'win32' ? [] : ['-lm'])],
    }
  }

  return { name: 'tcc', path: BUNDLED_TCC, optimized: false, flags: [] }
}

export function compile(cc: CCompiler, srcPath: string, exePath: string, cwd: string): void {
  const args = [...cc.flags, '-o', exePath, srcPath]
  execFileSync(cc.path, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}
