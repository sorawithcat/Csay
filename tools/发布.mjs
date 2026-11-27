// 发布前自动检查：版本、运行时头文件、可重复 C 代码和全量语言测试。
// 不生成安装包，打包仍由发布流程单独决定。
//   node tools/发布.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' })

try {
  run([fileURLToPath(new URL('./发布校验.mjs', import.meta.url))])
  run([fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--test', 'tests'])
  console.log('发布前检查通过')
} catch {
  console.error('发布前检查失败')
  process.exitCode = 1
}
