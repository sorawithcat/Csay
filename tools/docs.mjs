// Csay 文档页：把 docs/手册/*.md 渲染成带分类、编号和可编辑示例的文档。
// 只处理本站用到的 Markdown 子集，不引第三方依赖。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS_DIR = join(ROOT, 'docs', '手册')
const REFERENCE_FILES = ['语言规范.md', 'EBNF与词法-v1.md', '未来计划.md']
const CSS_PATH = join(ROOT, 'tools', 'docs.css')
const JS_PATH = join(ROOT, 'tools', 'docs.js')

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 标题转页面内锚点；中文直接保留，空格和标点折叠成 -。 */
function slugify(title) {
  return String(title)
    .replace(/<[^>]+>/g, '')
    .replace(/^\d+(?:\.\d+)*[.、]?\s*/, '')
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'section'
}

/** 行内语法：`代码`、**加粗**、[链接](地址) */
function inline(text, resolveHref) {
  const codes = []
  let s = String(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  s = escapeHtml(s)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = resolveHref ? resolveHref(href) : href
    return '<a href="' + target + '">' + label + '</a>'
  })
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + escapeHtml(codes[Number(i)]) + '</code>')
  return s
}

function gutterNumbers(count) {
  const out = []
  for (let i = 1; i <= count; i++) out.push(String(i))
  return out.join('\n')
}

/** 可编辑演示：工具栏 + 行号 + 语法高亮层 + 文本框 */
function demoBlock(code, title, number) {
  const body = code.replace(/\n+$/, '')
  const lineCount = Math.max(1, body.split('\n').length)
  const label = title || '示例 ' + number
  return (
    '<div class="demo">' +
    '<div class="demo-head">' +
    '<span class="demo-title">' + escapeHtml(label) + '</span>' +
    '<span class="demo-badge">可编辑</span>' +
    '<span class="runstate"></span>' +
    '<div class="demo-tools">' +
    '<button class="tool copy" type="button" title="复制代码">⧉</button>' +
    '<button class="tool reset" type="button" title="重置代码">↺</button>' +
    '<button class="tool run" type="button" title="运行代码">▶ 运行</button>' +
    '</div></div>' +
    '<div class="editor">' +
    '<div class="gutter" aria-hidden="true">' + gutterNumbers(lineCount) + '</div>' +
    '<div class="codewrap">' +
    '<pre class="hl" aria-hidden="true"></pre>' +
    '<textarea class="code" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" rows="' + lineCount + '">' +
    escapeHtml(body) +
    '</textarea>' +
    '</div>' +
    '</div>' +
    '<div class="output" hidden><div class="output-head">输出</div><pre class="output-body"></pre></div>' +
    '</div>'
  )
}

function staticBlock(code, lang) {
  return '<pre class="code-static' + (lang ? ' lang-' + escapeHtml(lang) : '') + '"><code>' +
    escapeHtml(code.replace(/\n+$/, '')) + '</code></pre>'
}

function splitRow(row) {
  const text = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

function tableBlock(rows, resolveHref) {
  const cells = rows.map(splitRow)
  let head = ''
  let body = cells
  if (cells.length >= 2 && cells[1].every((c) => /^:?-{2,}:?$/.test(c))) {
    head = '<thead><tr>' + cells[0].map((c) => '<th>' + inline(c, resolveHref) + '</th>').join('') + '</tr></thead>'
    body = cells.slice(2)
  }
  const bodyHtml = body.map((row) => '<tr>' + row.map((c) => '<td>' + inline(c, resolveHref) + '</td>').join('') + '</tr>').join('')
  return '<div class="table-wrap"><table>' + head + '<tbody>' + bodyHtml + '</tbody></table></div>'
}

function startsBlock(line) {
  return /^```/.test(line) || /^#{2,4}\s/.test(line) || /^\|/.test(line) ||
    /^>\s?/.test(line) || /^---+\s*$/.test(line) || /^(\s*)([-*]|\d+\.)\s+/.test(line)
}

/**
 * 简易 Markdown → HTML。
 * 标题自动编号（章.节），并收集侧栏用的二级标题。
 */
function renderMarkdown(source, chapterNo, resolveHref, numberHeadings = true) {
  const lines = source.split(/\r?\n/)
  const out = []
  const sections = []
  let demoNo = 0
  let h2No = 0
  let h3No = 0
  let i = 0
  const usedIds = new Map()

  const anchor = (id) => '<a class="anchor" href="#' + id + '" aria-label="本节链接">#</a>'
  const headingId = (title) => {
    const base = slugify(title)
    const n = (usedIds.get(base) ?? 0) + 1
    usedIds.set(base, n)
    return n === 1 ? base : base + '-' + n
  }

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (/^```/.test(line)) {
      const info = line.slice(3).trim()
      const space = info.indexOf(' ')
      const lang = (space < 0 ? info : info.slice(0, space)).toLowerCase()
      const title = space < 0 ? '' : info.slice(space + 1).trim()
      const code = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      const text = code.join('\n')
      if (lang === 'csay') {
        demoNo++
        out.push(demoBlock(text, title, demoNo))
      } else if (lang === 'csay-static') {
        out.push(staticBlock(text, 'csay'))
      } else if (lang === 'text') {
        // 运行结果由演示的输出面板展示，不再重复渲染静态结果块
      } else {
        out.push(staticBlock(text, lang))
      }
      continue
    }

    const heading = line.match(/^(#{2,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2]
      const id = headingId(title)
      if (level === 2) {
        h2No++
        h3No = 0
        const num = numberHeadings ? chapterNo + '.' + h2No : ''
        sections.push({ id, num, title })
        out.push('<h2 id="' + id + '">' + (num ? '<span class="h-no">' + num + '</span>' : '') +
          inline(title, resolveHref) + anchor(id) + '</h2>')
      } else if (level === 3) {
        h3No++
        const num = numberHeadings ? chapterNo + '.' + (h2No || 1) + '.' + h3No : ''
        out.push('<h3 id="' + id + '">' + (num ? '<span class="h-no">' + num + '</span>' : '') +
          inline(title, resolveHref) + anchor(id) + '</h3>')
      } else {
        out.push('<h4 id="' + id + '">' + inline(title, resolveHref) + anchor(id) + '</h4>')
      }
      i++
      continue
    }

    if (/^\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i])
        i++
      }
      out.push(tableBlock(rows, resolveHref))
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push('<div class="note">' + inline(quote.join(' '), resolveHref) + '</div>')
      continue
    }

    if (/^---+\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2])
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
        if (!m) break
        items.push(m[3])
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push('<' + tag + ' class="doc-list">' +
        items.map((item) => '<li>' + inline(item, resolveHref) + '</li>').join('') +
        '</' + tag + '>')
      continue
    }

    const para = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      para.push(lines[i].trim())
      i++
    }
    out.push('<p>' + inline(para.join(''), resolveHref) + '</p>')
  }

  return { html: out.join('\n'), sections }
}

function parseDoc(path, groupFallback, kind) {
  const raw = readFileSync(path, 'utf8')
  const groupMatch = raw.match(/^<!--\s*(?:分类|分组)[:：]\s*(.*?)\s*-->/m)
  const titleMatch = raw.match(/^#\s+(.+)$/m)
  const body = raw
    .replace(/^<!--\s*(?:分类|分组)[:：].*?-->\s*/, '')
    .replace(/^#\s+.*$/m, '')
    .replace(/^\s*\n/, '')
  const file = path.split(/[\\/]/).pop()
  return {
    id: kind === 'tutorial' ? file.replace(/^\d+(?:\.\d+)?[-_]/, '').replace(/\.md$/, '') : file.replace(/\.md$/, ''),
    file,
    title: (titleMatch ? titleMatch[1] : file).trim(),
    group: (groupMatch ? groupMatch[1] : groupFallback).trim(),
    kind,
    body,
  }
}

function loadChapters() {
  let files = []
  try {
    files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const docs = files.map((file) => parseDoc(join(DOCS_DIR, file), '其他', 'tutorial'))
  for (const file of REFERENCE_FILES) {
    const path = join(ROOT, 'docs', file)
    try {
      docs.push(parseDoc(path, '参考', 'reference'))
    } catch {}
  }

  const categories = ['概述', '语言', '类型', '标准库', '工具', '参考', '示例', '更新日志']
  const rank = (doc) => {
    const i = categories.indexOf(doc.group)
    return i < 0 ? categories.length : i
  }
  docs.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file, 'zh'))

  const byFile = new Map()
  for (const doc of docs) byFile.set(doc.file, doc)
  const resolveHref = (href) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return href
    const [rawPath, hash] = href.split('#')
    const base = decodeURIComponent(rawPath).split(/[\\/]/).pop()
    const target = byFile.get(base)
    if (!target) return href
    return '/docs/' + encodeURIComponent(target.id) + (hash ? '#' + hash : '')
  }

  const tutorialOrder = new Map(docs.filter((doc) => doc.kind === 'tutorial').map((doc, i) => [doc, i + 1]))
  return docs.map((doc) => {
    const number = doc.kind === 'tutorial' ? String(tutorialOrder.get(doc)) : ''
    const rendered = renderMarkdown(doc.body, number, resolveHref, doc.kind === 'tutorial')
    return { ...doc, number, html: rendered.html, sections: rendered.sections }
  })
}

function chapterHref(chapter) {
  return '/docs/' + encodeURIComponent(chapter.id)
}

function sectionLink(section) {
  return '<a class="side-sec" data-sec="' + section.id + '" href="#' + section.id + '">' +
    (section.num ? '<span class="sec-no">' + section.num + '</span>' : '') + escapeHtml(section.title) + '</a>'
}

export function renderDocsPage(chapterId) {
  const chapters = loadChapters()
  if (!chapters.length) {
    return '<!doctype html><meta charset="utf-8"><title>Csay 文档</title>' +
      '<body style="font-family:sans-serif;padding:40px"><h1>文档还没有内容</h1>' +
      '<p>请在 <code>docs/手册/</code> 下添加 Markdown 文件。</p></body>'
  }

  let index = 0
  if (chapterId) {
    index = chapters.findIndex((c) => c.id === chapterId)
    if (index < 0) return null
  }
  const chapter = chapters[index]
  const prev = index > 0 ? chapters[index - 1] : null
  const next = index < chapters.length - 1 ? chapters[index + 1] : null
  const docLabel = (c) => c.number ? c.number + '. ' + c.title : c.title

  const side = chapters.map((c, i) => {
    const searchText = escapeHtml(
      c.title + ' ' + c.sections.map((s) => s.title).join(' ') + ' ' + c.body
    )
    let html = '<a class="side-link' + (i === index ? ' on' : '') + '" href="' + chapterHref(c) + '" data-search="' + searchText + '">' +
      (c.number ? '<span class="side-no">' + c.number + '.</span>' : '') + escapeHtml(c.title) + '</a>'
    if (i === index && c.sections.length) {
      html += '<div class="side-sections">' + c.sections.map(sectionLink).join('') + '</div>'
    }
    return html
  }).reduce((acc, html, i) => {
    const prevGroup = i > 0 ? chapters[i - 1].group : null
    if (chapters[i].group !== prevGroup) {
      acc += '<div class="side-group">' + escapeHtml(chapters[i].group) + '</div>'
    }
    return acc + html
  }, '')

  const css = readFileSync(CSS_PATH, 'utf8')
  const js = readFileSync(JS_PATH, 'utf8')

  const pager = '<nav class="pager">' +
    (prev
      ? '<a class="prev" href="' + chapterHref(prev) + '"><span class="dir">← 上一页</span>' +
        escapeHtml(docLabel(prev)) + '</a>'
      : '<span class="empty"></span>') +
    (next
      ? '<a class="next" href="' + chapterHref(next) + '"><span class="dir">下一页 →</span>' +
        escapeHtml(docLabel(next)) + '</a>'
      : '<span class="empty"></span>') +
    '</nav>'

  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(docLabel(chapter)) + ' - Csay 文档</title>\n' +
    '<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
    '<header class="topbar">' +
    '<button class="menu-btn" id="menu-btn" type="button" aria-label="打开目录">☰</button>' +
    '<a class="brand" href="/docs">Csay<span>文档</span></a>' +
    '<div class="top-title">' + escapeHtml(docLabel(chapter)) + '</div>' +
    '<nav class="topnav"><a href="/" target="_blank" rel="noopener">编辑器</a></nav>' +
    '</header>' +
    '<div class="layout">' +
    '<aside class="sidebar" id="sidebar"><div class="side-title">文档目录</div>' +
    '<div class="side-search"><input id="doc-search" type="search" placeholder="搜索页面或小节…" autocomplete="off"></div>' + side + '</aside>' +
    '<div class="side-mask" id="side-mask"></div>' +
    '<main class="doc-main">' +
    '<div class="doc-crumb">Csay 文档 <span>/</span> ' + escapeHtml(chapter.group) + '</div>' +
    '<h1>' + (chapter.number ? '<span class="h1-no">' + chapter.number + '.</span>' : '') + escapeHtml(chapter.title) + '</h1>' +
    '<div class="doc-body">' + chapter.html + '</div>' +
    pager +
    '</main>' +
    '</div>' +
    '<script>\n' + js + '\n</script>\n' +
    '</body>\n</html>'
}
