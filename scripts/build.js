// 根据测试报告挑选、精简、合并音源
// 用法: node scripts/build.js <源目录> <report.json> <输出js>
// 参数见 scripts/config.js（环境变量覆盖）
const fs = require('fs')
const path = require('path')
const cfg = require('./config')

const [, , srcDir = 'sources', reportPath = 'dist/report.json', outPath = 'dist/lx-merged.js'] = process.argv
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const TESTED = ['kw', 'kg', 'tx', 'wy', 'mg']

function cmpVer(a = '', b = '') {
  const pa = String(a).match(/\d+/g) || [], pb = String(b).match(/\d+/g) || []
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (+pa[i] || 0) - (+pb[i] || 0)
    if (d) return d
  }
  return 0
}
function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const A = new Set(a), B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// ---------- 1. 过滤：无效 / 混淆 / 旧版本 ----------
const reason = new Map() // file -> 未合并原因
let pool = []
for (const r of report.results) {
  if (!r.valid) reason.set(r.file, '测试无效')
  else if (cfg.EXCLUDE_OBFUSCATED && r.obfuscated) reason.set(r.file, '混淆')
  else pool.push(r)
}
const byName = new Map()
for (const r of pool) {
  const key = (r.name || r.file).trim()
  const old = byName.get(key)
  if (!old || cmpVer(r.version, old.version) > 0) {
    if (old) reason.set(old.file, '旧版本')
    byName.set(key, r)
  } else reason.set(r.file, '旧版本')
}
pool = [...byName.values()]

// ---------- 2. 每个平台排名 + 去重 + 取前 N ----------
const score = (r, p) => {
  const t = r.tests && r.tests[p]
  if (!t || !t.ok) return Infinity
  return (t.reachable === false ? 100000 : 0) + (t.ms || 0)
}
const order = {}     // 平台 -> [音源 file]
const dedupNote = [] // 去重记录
for (const p of TESTED) {
  const cands = pool.filter(r => score(r, p) < Infinity).sort((a, b) => score(a, p) - score(b, p))
  const chosen = []
  for (const c of cands) {
    if (cfg.TOP_PER_PLATFORM > 0 && chosen.length >= cfg.TOP_PER_PLATFORM) break
    const dup = cfg.DEDUP_THRESHOLD < 1 && chosen.find(x => jaccard(x.hosts || [], c.hosts || []) >= cfg.DEDUP_THRESHOLD)
    if (dup) { dedupNote.push(`${p}: ${c.name || c.file} 与 ${dup.name || dup.file} 接口重复`); continue }
    chosen.push(c)
  }
  order[p] = chosen.map(r => r.file)
}
const usedFiles = new Set(Object.values(order).flat())
const picked = pool.filter(r => usedFiles.has(r.file))
  .sort((a, b) => b.passed.length - a.passed.length || a.file.localeCompare(b.file))
for (const r of pool) if (!usedFiles.has(r.file)) reason.set(r.file, '精简（排名靠后或接口重复）')

const idxOf = new Map(picked.map((r, i) => [r.file, i]))
const ORDER = Object.fromEntries(TESTED.map(p => [p, order[p].map(f => idxOf.get(f))]))

// ---------- 3. 生成合集 ----------
const modules = picked.map(r => {
  const code = fs.readFileSync(path.join(srcDir, r.file), 'utf8')
  const block = TESTED.filter(p => !order[p].includes(r.file))
  return `  {\n    name: ${JSON.stringify(r.name || r.file)},\n    block: ${JSON.stringify(block)},\n    load: function (globalThis, window, self, lx) {\n${code}\n    }\n  }`
}).join(',\n')

const date = new Date().toISOString().slice(0, 10)
const out = `/*!
 * @name 聚合音源合集
 * @description ${picked.length} 个音源，并发${cfg.RACE_CONCURRENCY}，超时${cfg.TIMEOUT_MS / 1000}秒，默认${cfg.DEFAULT_QUALITY}（${date}）
 * @version v${date.replace(/-/g, '.')}
 * @author lx-merged
 */
;(function () {
  var CONFIG = ${JSON.stringify({ TIMEOUT_MS: cfg.TIMEOUT_MS, RACE_CONCURRENCY: Math.max(1, cfg.RACE_CONCURRENCY), DEFAULT_QUALITY: cfg.DEFAULT_QUALITY, REMEMBER_LAST: cfg.REMEMBER_LAST })}
  var ORDER = ${JSON.stringify(ORDER)}
  var realG = globalThis
  var realLx = realG.lx
  var E = realLx.EVENT_NAMES
  var subs = []
  var allSources = {}
  var lastOk = {}

  function mergeSources(src) {
    Object.keys(src || {}).forEach(function (k) {
      var s = src[k]
      if (!s) return
      var a = allSources[k] || (allSources[k] = { name: s.name || k, type: s.type || 'music', actions: [], qualitys: [] })
      ;(s.actions || []).forEach(function (x) { if (a.actions.indexOf(x) < 0) a.actions.push(x) })
      ;(s.qualitys || []).forEach(function (x) { if (a.qualitys.indexOf(x) < 0) a.qualitys.push(x) })
    })
  }

  var MODULES = [
${modules}
  ]

  MODULES.forEach(function (m, idx) {
    var sub = { idx: idx, name: m.name, block: m.block, handler: null, sources: null }
    var fakeLx = Object.create(realLx)
    fakeLx.on = function (ev, fn) { if (ev === E.request) sub.handler = fn }
    fakeLx.send = function (ev, data) {
      if (ev === E.inited) {
        var src = {}
        Object.keys((data && data.sources) || {}).forEach(function (k) { if (m.block.indexOf(k) < 0) src[k] = data.sources[k] })
        sub.sources = src
        mergeSources(src)
      } else if (ev !== E.updateAlert) {
        return realLx.send(ev, data)
      }
    }
    var fakeG = typeof Proxy === 'function' ? new Proxy(realG, {
      get: function (t, k) { return k === 'lx' ? fakeLx : Reflect.get(t, k) },
      set: function (t, k, v) { t[k] = v; return true }
    }) : realG
    var swapped = false
    try { realG.lx = fakeLx; swapped = realG.lx === fakeLx } catch (e) {}
    try { m.load.call(fakeG, fakeG, fakeG, fakeG, fakeLx) } catch (e) { console.log('[聚合] 加载失败 ' + m.name + ': ' + (e && e.message)) }
    try { if (swapped) realG.lx = realLx } catch (e) {}
    subs.push(sub)
  })

  function supports(sub, req) {
    if (!sub.handler || sub.block.indexOf(req.source) >= 0) return false
    if (!sub.sources) return true
    var s = sub.sources[req.source]
    return !!s && (!s.actions || s.actions.indexOf(req.action) >= 0)
  }
  function isValid(action, r) {
    if (r == null || r === '') return false
    if (action === 'musicUrl') return typeof r === 'string' && /^https?:\\/\\//i.test(r)
    return true
  }
  // 候选顺序：上次成功的 > 测试排名 > 其余
  function candidates(req) {
    var list = []
    var push = function (i) { var s = subs[i]; if (s && list.indexOf(s) < 0 && supports(s, req)) list.push(s) }
    if (CONFIG.REMEMBER_LAST && lastOk[req.source] != null) push(lastOk[req.source])
    ;(ORDER[req.source] || []).forEach(push)
    subs.forEach(function (s) { push(s.idx) })
    return list
  }
  function callOne(s, req) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error(s.name + ' 超时')) }, CONFIG.TIMEOUT_MS)
      Promise.resolve().then(function () { return s.handler(req) }).then(function (r) {
        clearTimeout(t)
        if (isValid(req.action, r)) res(r); else rej(new Error(s.name + ' 返回无效'))
      }, function (e) { clearTimeout(t); rej(e) })
    })
  }
  // 并发竞速：同时跑 N 个，谁先成功用谁；失败一个就补下一个
  function race(list, req) {
    return new Promise(function (resolve, reject) {
      var next = 0, running = 0, done = false, lastErr = null
      function launch() {
        while (!done && running < CONFIG.RACE_CONCURRENCY && next < list.length) {
          (function (s) {
            running++
            callOne(s, req).then(function (r) {
              if (done) return
              done = true
              lastOk[req.source] = s.idx
              resolve(r)
            }, function (e) {
              running--
              lastErr = e
              if (lastOk[req.source] === s.idx) delete lastOk[req.source]
              console.log('[聚合] ' + (e && e.message))
              if (!done) { if (next >= list.length && running === 0) { done = true; reject(lastErr || new Error('所有音源均失败')) } else launch() }
            })
          })(list[next++])
        }
        if (!done && running === 0 && next >= list.length) { done = true; reject(lastErr || new Error('没有可用音源')) }
      }
      launch()
    })
  }

  realLx.on(E.request, function (req) {
    if (req && req.info && !req.info.type) req.info.type = CONFIG.DEFAULT_QUALITY
    return race(candidates(req), req)
  })

  setTimeout(function () {
    Object.keys(allSources).forEach(function (k) {
      var q = allSources[k].qualitys
      if (q.indexOf(CONFIG.DEFAULT_QUALITY) < 0) q.unshift(CONFIG.DEFAULT_QUALITY)
    })
    realLx.send(E.inited, { openDevTools: false, sources: allSources })
  }, 0)
})()
`
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out)

// ---------- 4. 报告 ----------
const cell = (r, p) => {
  const t = r.tests && r.tests[p]
  if (!t) return '—'
  if (!t.ok) return '❌'
  const rank = order[p].indexOf(r.file)
  return (rank >= 0 ? `✅#${rank + 1}` : '✅') + ` ${(t.ms / 1000).toFixed(1)}s`
}
let md = `# 音源测试报告\n\n` +
  `- 时间: ${report.time}\n- 测试歌曲: ${report.keyword}（${report.quality || ''}）\n` +
  `- 参数: 超时 ${cfg.TIMEOUT_MS}ms / 并发 ${cfg.RACE_CONCURRENCY} / 默认音质 ${cfg.DEFAULT_QUALITY} / 去混淆 ${cfg.EXCLUDE_OBFUSCATED} / 每平台 ${cfg.TOP_PER_PLATFORM || '不限'} 个 / 去重阈值 ${cfg.DEDUP_THRESHOLD}\n` +
  `- 合并: ${picked.length} 个，文件 ${(out.length / 1024).toFixed(0)} KB\n\n` +
  `#N = 该平台的优先顺序\n\n| 音源 | 版本 | 大小 | ${TESTED.join(' | ')} | 结果 |\n|---|---|---|${TESTED.map(() => '---').join('|')}|---|\n`
for (const r of report.results) {
  md += `| ${r.name || r.file}${r.obfuscated ? ' 🔒' : ''} | ${r.version || ''} | ${((r.size || 0) / 1024).toFixed(0)}K | ${TESTED.map(p => cell(r, p)).join(' | ')} | ${usedFiles.has(r.file) ? '✅ 合并' : reason.get(r.file) || ''} |\n`
}
md += `\n## 各平台顺序\n\n` + TESTED.map(p => `- **${p}**: ${order[p].map(f => picked[idxOf.get(f)].name).join(' → ') || '（无）'}`).join('\n')
if (dedupNote.length) md += `\n\n## 去重\n\n` + dedupNote.map(x => `- ${x}`).join('\n')
fs.writeFileSync(path.join(path.dirname(outPath), 'REPORT.md'), md + '\n')

console.log(`合并 ${picked.length} 个音源 -> ${outPath} (${(out.length / 1024).toFixed(0)} KB)`)
for (const p of TESTED) console.log(`  ${p}: ${order[p].map(f => picked[idxOf.get(f)].name).join(' → ')}`)
