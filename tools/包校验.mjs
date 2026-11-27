// 校验安装包 zip 的内容与打包目录一致，防止漏文件或混入临时文件。
import { readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '')
}

export function packageFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(normalize(relative(root, full)))
    }
  }
  walk(root)
  return out.sort()
}

export function zipFiles(zipPath) {
  const quoted = zipPath.replace(/'/g, "''")
  const script = `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${quoted}'); $z.Entries | ForEach-Object { if ($_.Name -ne '') { $_.FullName } }; $z.Dispose()`
  const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return text.split(/\r?\n/).map(normalize).filter(Boolean).sort()
}

export function verifyPackage(zipPath, stage) {
  const expected = packageFiles(stage)
  const actual = zipFiles(zipPath)
  const missing = expected.filter((f) => !actual.includes(f))
  const extra = actual.filter((f) => !expected.includes(f))
  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push('缺少：' + missing.join('、'))
    if (extra.length) parts.push('多出：' + extra.join('、'))
    throw new Error('安装包内容校验失败：' + parts.join('；'))
  }
  return { files: expected.length }
}
