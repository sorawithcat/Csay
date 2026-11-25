// 把 Csay 的语法高亮装进编辑器。
// 自动发现 VS Code / Cursor / VS Code Insiders，装到所有存在的那个。
// 只复制到扩展目录，不改注册表；卸载就是删掉目标目录。
//   node editors/install.mjs

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = join(here, 'vscode')
const home = homedir()

const candidates = [
  { name: 'VS Code', root: join(home, '.vscode') },
  { name: 'Cursor', root: join(home, '.cursor') },
  { name: 'VS Code Insiders', root: join(home, '.vscode-insiders') },
  { name: 'Windsurf', root: join(home, '.windsurf') },
]

const found = candidates.filter((c) => existsSync(c.root))

if (found.length === 0) {
  console.log('没有找到 VS Code / Cursor / Windsurf 的配置目录。')
  console.log('如果确实装了，请先启动一次编辑器，让它生成扩展目录。')
  process.exit(1)
}

if (!existsSync(src)) {
  console.log('找不到扩展源目录：' + src)
  process.exit(1)
}

// 目录名必须是 <发布者>.<名字>-<版本>，否则编辑器扫描时会直接跳过
const EXT_DIR = 'csay.csay-1.0.0'

for (const ed of found) {
  const dest = join(ed.root, 'extensions', EXT_DIR)
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  cpSync(src, dest, { recursive: true })
  console.log(`已安装到 ${ed.name}：${dest}`)
}

console.log('')
console.log('重启编辑器后，打开 .csay 文件就有语法高亮和代码片段。')
console.log('试一试：新建 a.csay，输入 lei 然后按 Tab。')
console.log('')
console.log('卸载：直接删掉上面那个 csay-1.0.0 目录即可。')
