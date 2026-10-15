// 生成 GitHub Pages 首页：导入链接 + 测试报告
// 用法: node scripts/make-pages.js <dist目录> <pages基础URL>
const fs = require('fs')
const path = require('path')

const [, , dir = 'dist', base = ''] = process.argv
const baseUrl = base.replace(/\/$/, '')
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const inline = s => esc(s).replace(/&lt;br&gt;/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')

// 极简 markdown -> html（只处理 REPORT.md 用到的：标题、列表、表格、段落）
function md2html(md) {
  const out = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^#{1,6} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n + 1}>${inline(l.slice(n + 1))}</h${n + 1}>`) }
    else if (/^\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
      i--
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      out.push('<table><thead><tr>' + cells(rows[0]).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.slice(2).map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>')
    } else if (/^\s*- /.test(l)) {
      const items = []
      while (i < lines.length && /^\s*- /.test(lines[i])) items.push(lines[i++].replace(/^(\s*)- /, (m, sp) => sp ? '└ ' : ''))
      i--
      out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>')
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`)
  }
  return out.join('\n')
}

const size = f => { try { return (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0) + ' KB' } catch { return '-' } }
const report = fs.existsSync(path.join(dir, 'REPORT.md')) ? fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8') : ''
const upstream = fs.existsSync(path.join(dir, 'upstream.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'upstream.json'), 'utf8')) : {}
const link = f => `${baseUrl}/${f}`

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>聚合音源合集</title>
<style>
body{font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:1100px;margin:2em auto;padding:0 1em;color:#222}
code{background:#f3f3f3;padding:2px 6px;border-radius:4px;word-break:break-all}
.card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:10px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.card b{min-width:90px}.card code{flex:1}
button{padding:4px 12px;cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:13px;overflow-x:auto;display:block}
th,td{border:1px solid #ddd;padding:4px 8px;white-space:nowrap}th{background:#f6f6f6}
</style></head><body>
<h1>聚合音源合集</h1>
<p>在落雪 / 兼容 LX 自定义源的 APP 中导入下面的链接（推荐压缩版）。</p>
<div class="card"><b>压缩版</b><code>${esc(link('lx-merged.min.js'))}</code><span>${size('lx-merged.min.js')}</span><button onclick="cp(this)">复制</button></div>
<div class="card"><b>完整版</b><code>${esc(link('lx-merged.js'))}</code><span>${size('lx-merged.js')}</span><button onclick="cp(this)">复制</button></div>
<div class="card"><b>调试版</b><code>${esc(link('lx-merged.debug.js'))}</code><span>${size('lx-merged.debug.js')}</span><button onclick="cp(this)">复制</button></div>
<p style="color:#666;font-size:13px">调试版：导入后落雪会自动打开开发者工具，Console 里有每个子音源的加载、尝试、成功/失败和耗时日志；也可以输入 <code>__lxMerged</code> 查看运行状态。排查完请换回压缩版。</p>
<p>上游：${Object.entries(upstream).map(([r, t]) => `<a href="https://github.com/${esc(r)}/releases/tag/${esc(t)}">${esc(r)}@${esc(t)}</a>`).join('，') || '-'}
　|　<a href="report.json">report.json</a>　|　<a href="REPORT.md">REPORT.md</a></p>
${md2html(report)}
<script>function cp(b){navigator.clipboard.writeText(b.parentNode.querySelector('code').textContent);b.textContent='已复制';setTimeout(()=>b.textContent='复制',1500)}</script>
</body></html>
`
fs.writeFileSync(path.join(dir, 'index.html'), html)
fs.writeFileSync(path.join(dir, '.nojekyll'), '')
console.log('生成 index.html')
