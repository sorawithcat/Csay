// 把 stage0 的 C 运行时导出成自举编译器可包含的头文件。
//   node tools/导出运行时.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_C } from '../src/runtime.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, 'selfhost')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'csay_runtime.h'), '/* 由 tools/导出运行时.mjs 生成，勿手改 */\n' + RUNTIME_C + '\n', 'utf8')
console.log('已导出 selfhost/csay_runtime.h')
