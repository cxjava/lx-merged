// 根据测试报告挑选、精简、合并音源 -> dist/lx-merged.js + lx-merged.debug.js + REPORT.md
// 用法: node scripts/build.js <源目录> <report.json> <输出js>
// 参数见 scripts/config.js（环境变量覆盖）
//
// 只维护一套：同一个文件同时兼容 落雪桌面版 / 落雪移动版 / Cymusic / 歌一刀(KMusic) 等 LX 兼容 APP
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
const UNTESTED = TESTED.filter(p => !(report.songs && report.songs[p]))
if (UNTESTED.length) console.log('⚠️ 以下平台没有测试歌曲，按声明保留: ' + UNTESTED.join(','))
for (const r of report.results) {
  const onlyUntested = !r.valid && r.inited !== false && (r.platforms || []).some(p => UNTESTED.includes(p))
  if (!r.valid && !onlyUntested) reason.set(r.file, '测试无效')
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
const order = {}
const dedupNote = []
for (const p of TESTED) {
  const cands = UNTESTED.includes(p)
    ? pool.filter(r => (r.platforms || []).includes(p)).sort((a, b) => b.passed.length - a.passed.length)
    : pool.filter(r => score(r, p) < Infinity).sort((a, b) => score(a, p) - score(b, p))
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
const STATIC_SOURCES = TESTED.filter(p => order[p].length > 0)

// ---------- 3. 生成合集 ----------
const modules = picked.map(r => {
  const code = fs.readFileSync(path.join(srcDir, r.file), 'utf8')
  return `  {\n    name: ${JSON.stringify(r.name || r.file)},\n    load: function (globalThis, window, self, lx) {\n${code}\n    }\n  }`
}).join(',\n')

const date = new Date().toISOString().slice(0, 10)

function render(debug) {
  const config = {
    TIMEOUT_MS: cfg.TIMEOUT_MS,
    HEDGE_MS: cfg.HEDGE_MS,
    RACE_CONCURRENCY: Math.max(1, cfg.RACE_CONCURRENCY),
    DEFAULT_QUALITY: cfg.DEFAULT_QUALITY,
    REMEMBER_LAST: cfg.REMEMBER_LAST,
    DEBUG: debug,
  }
  return `/*!
 * @name ${debug ? '聚合音源合集-调试版' : '聚合音源合集'}
 * @description ${picked.length}个源 并发${config.RACE_CONCURRENCY} 默认${cfg.DEFAULT_QUALITY}
 * @version v${date.replace(/-/g, '.')}
 * @author lx-merged
 */
;(function () {
  // 只用各 APP 都有的能力：Promise / setTimeout / clearTimeout / lx.*
  // （Cymusic、落雪移动版没有 fetch/URL/atob 等；所有对象都可能被冻结）
  var CONFIG = ${JSON.stringify(config)}
  var ORDER = ${JSON.stringify(ORDER)}
  var STATIC_SOURCES = ${JSON.stringify(STATIC_SOURCES)}
  var VALID_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
  var VALID_QUALITYS = ['128k', '320k', 'flac', 'flac24bit']
  var realG = globalThis
  var realLx = realG.lx
  var E = realLx.EVENT_NAMES || { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
  var hasTimer = typeof setTimeout === 'function'
  var subs = []
  var lastOk = {}
  var declared = {}

  function log() {
    if (!CONFIG.DEBUG) return
    var a = Array.prototype.slice.call(arguments)
    a.unshift('[聚合 ' + new Date().toISOString().slice(11, 23) + ']')
    try { console.log(a.join(' ')) } catch (e) {}
  }
  function warn(msg) { try { console.log('[聚合] ' + msg) } catch (e) {} }
  function later(fn, ms) { return hasTimer ? setTimeout(fn, ms) : null }
  function cancel(t) { if (t != null && hasTimer) try { clearTimeout(t) } catch (e) {} }

  // ---- 子音源的 globalThis：空对象做 Proxy target（真实 lx 只读不可配置，代理它会违反 Proxy 规则）
  var bindCache = typeof Map === 'function' ? new Map() : null
  function readGlobal(k) {
    var v = realG[k]
    if (typeof v === 'function' && !v.prototype && bindCache) {
      var b = bindCache.get(v)
      if (!b) { try { b = v.bind(realG) } catch (e) { b = v } bindCache.set(v, b) }
      return b
    }
    return v
  }
  var GLOBAL_ALIASES = { globalThis: 1, window: 1, self: 1, top: 1, parent: 1, frames: 1 }
  function makeFakeG(fakeLx) {
    if (typeof Proxy !== 'function') {
      var o = Object.create(realG)
      try { Object.defineProperty(o, 'lx', { value: fakeLx }) } catch (e) {}
      return o
    }
    var fakeG = new Proxy({}, {
      get: function (t, k) {
        if (k === 'lx') return fakeLx
        if (typeof k === 'string' && GLOBAL_ALIASES[k]) return fakeG
        return readGlobal(k)
      },
      set: function (t, k, v) { if (k !== 'lx') { try { realG[k] = v } catch (e) {} } return true },
      has: function (t, k) { return k === 'lx' || k in realG },
      deleteProperty: function (t, k) { try { delete realG[k] } catch (e) {} return true }
    })
    return fakeG
  }

  // ---- 统一 lx.request 的返回：不同 APP 行为不一致
  //      落雪桌面版总会尝试 JSON.parse；Cymusic/移动端只有 content-type 含 json 才解析，否则 body 是字符串
  //      这里统一：body 是字符串且像 JSON 就解析，子音源拿到的永远和桌面版一致
  function normBody(b) {
    if (typeof b !== 'string') return b
    var s = b.replace(/^\\uFEFF/, '').trim()
    var c = s.charAt(0)
    if (c !== '{' && c !== '[') return b
    try { return JSON.parse(s) } catch (e) { return b }
  }
  function lxRequest(url, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    options = options || {}
    return realLx.request(url, options, function (err, resp, body) {
      if (!err && resp) {
        var nb = normBody(resp.body !== undefined ? resp.body : body)
        try { resp.body = nb } catch (e) {
          resp = { statusCode: resp.statusCode, statusMessage: resp.statusMessage, headers: resp.headers, bytes: resp.bytes, raw: resp.raw, body: nb }
        }
        body = nb
      }
      if (typeof callback === 'function') return callback.call(this, err, resp, body)
    })
  }

  function makeFakeLx(sub) {
    return {
      EVENT_NAMES: E,
      version: realLx.version,
      env: realLx.env,
      utils: realLx.utils,
      currentScriptInfo: realLx.currentScriptInfo,
      request: lxRequest,
      on: function (ev, fn) {
        if (ev === E.request) { sub.handler = fn; log('注册 handler:', sub.name) }
        return Promise.resolve()
      },
      send: function (ev, data) {
        if (ev === E.inited) {
          sub.sources = (data && data.sources) || {}
          if (!sub.loaded) mergeDeclared(sub.sources)
          log('子音源 inited:', sub.name, Object.keys(sub.sources).join(','))
        }
        return Promise.resolve()   // updateAlert 等一律吞掉
      }
    }
  }
  function mergeDeclared(src) {
    Object.keys(src).forEach(function (k) {
      if (VALID_SOURCES.indexOf(k) < 0 || !src[k]) return
      var d = declared[k] || (declared[k] = { actions: [], qualitys: [] })
      ;(src[k].actions || []).forEach(function (x) { if (d.actions.indexOf(x) < 0) d.actions.push(x) })
      ;(src[k].qualitys || []).forEach(function (x) { if (d.qualitys.indexOf(x) < 0) d.qualitys.push(x) })
    })
  }

  var MODULES = [
${modules}
  ]

  MODULES.forEach(function (m, idx) {
    var sub = { idx: idx, name: m.name, handler: null, sources: null, loaded: false, error: null }
    var fakeLx = makeFakeLx(sub)
    var fakeG = makeFakeG(fakeLx)
    var t0 = Date.now()
    try { m.load.call(fakeG, fakeG, fakeG, fakeG, fakeLx) }
    catch (e) { sub.error = e && e.message || String(e); warn('加载失败 ' + m.name + ': ' + sub.error) }
    sub.loaded = true
    log('加载', m.name, (Date.now() - t0) + 'ms', sub.handler ? 'OK' : '无 handler')
    subs.push(sub)
  })

  function supports(sub, req) {
    if (!sub.handler) return false
    // 已测平台：只用测试通过的音源
    if (ORDER[req.source]) return ORDER[req.source].indexOf(sub.idx) >= 0
    if (!sub.sources) return true
    return !!sub.sources[req.source]
  }
  function isValid(action, r) {
    if (action === 'lyric') return !!r && typeof r === 'object' && typeof r.lyric === 'string'
    return typeof r === 'string' && r.length <= 2048 && /^https?:/i.test(r)
  }
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
      var t0 = Date.now()
      var timer = later(function () { rej(new Error(s.name + ' 超时')) }, CONFIG.TIMEOUT_MS)
      Promise.resolve().then(function () { return s.handler(req) }).then(function (r) {
        cancel(timer)
        if (isValid(req.action, r)) { log('✓', s.name, (Date.now() - t0) + 'ms', String(r).slice(0, 100)); res(r) }
        else rej(new Error(s.name + ' 返回无效: ' + String(r).slice(0, 80)))
      }, function (e) { cancel(timer); rej(new Error(s.name + ': ' + (e && e.message || e))) })
    })
  }
  // 竞速：先同时跑 N 个；之后每隔 HEDGE_MS 没结果就再加一个（不必等前面超时），失败一个立即补一个
  // Cymusic 只给 5 秒，必须尽快把候选都派出去
  function race(list, req) {
    return new Promise(function (resolve, reject) {
      var next = 0, running = 0, done = false, errors = [], hedge = null
      function finish() {
        if (!done && running === 0 && next >= list.length) {
          done = true; cancel(hedge)
          reject(new Error(errors.length ? '全部失败: ' + errors.join(' | ').slice(0, 300) : '没有可用音源'))
        }
      }
      function start(s) {
        running++
        log('→ 尝试', s.name)
        callOne(s, req).then(function (r) {
          running--
          if (done) return
          done = true; cancel(hedge)
          lastOk[req.source] = s.idx
          resolve(r)
        }, function (e) {
          running--
          errors.push(e && e.message)
          if (lastOk[req.source] === s.idx) delete lastOk[req.source]
          log('✗', e && e.message)
          if (!done && next < list.length) start(list[next++])
          finish()
        })
      }
      function tick() {
        if (done || next >= list.length) return
        start(list[next++])
        hedge = later(tick, CONFIG.HEDGE_MS)
      }
      while (running < CONFIG.RACE_CONCURRENCY && next < list.length) start(list[next++])
      if (CONFIG.HEDGE_MS > 0) hedge = later(tick, CONFIG.HEDGE_MS)
      finish()
    })
  }
  function normQuality(t) {
    if (VALID_QUALITYS.indexOf(t) >= 0) return t
    if (!t) return CONFIG.DEFAULT_QUALITY
    if (/hires|master|atmos|24/i.test(t)) return 'flac24bit'
    if (/flac|lossless|sq|ape|wav/i.test(t)) return 'flac'
    if (/320|hq/i.test(t)) return '320k'
    return '128k'
  }

  realLx.on(E.request, function (req) {
    req = req || {}
    var info = req.info || {}
    // 统一请求参数：不同 APP 传的音质/字段不一样（Cymusic 永远 source=tx，音质可能是 flac/320k/128k）
    var r2 = {
      source: req.source,
      action: req.action || 'musicUrl',
      info: {
        type: req.source === 'local' ? info.type : normQuality(info.type),
        musicInfo: info.musicInfo || {}
      }
    }
    for (var k in info) if (!(k in r2.info)) r2.info[k] = info[k]
    var list = candidates(r2)
    log('请求', r2.source, r2.action, r2.info.type, r2.info.musicInfo.name || r2.info.musicInfo.title, '候选:', list.map(function (s) { return s.name }).join(' / '))
    return race(list, r2)
  })

  // ---- 立即（同步）发送 inited：之后子音源的异步报错不会再导致初始化失败
  var sources = {}
  var names = { kw: '酷我音乐', kg: '酷狗音乐', tx: 'QQ音乐', wy: '网易音乐', mg: '咪咕音乐', local: '本地音乐' }
  VALID_SOURCES.forEach(function (k) {
    if (STATIC_SOURCES.indexOf(k) < 0 && !declared[k]) return
    if (k === 'local') {
      var acts = (declared.local && declared.local.actions || []).filter(function (a) { return ['musicUrl', 'lyric', 'pic'].indexOf(a) >= 0 })
      if (acts.length) sources.local = { name: names.local, type: 'music', actions: acts, qualitys: [] }
      return
    }
    sources[k] = { name: names[k], type: 'music', actions: ['musicUrl'], qualitys: VALID_QUALITYS.slice() }
  })
  log('env', realLx.env, 'inited', JSON.stringify(sources))
  if (CONFIG.DEBUG) { try { realG.__lxMerged = { subs: subs, lastOk: lastOk, CONFIG: CONFIG, ORDER: ORDER, sources: sources } } catch (e) {} }
  realLx.send(E.inited, { openDevTools: CONFIG.DEBUG, sources: sources })
})()
`
}
const out = render(false)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out)
fs.writeFileSync(outPath.replace(/\.js$/, '.debug.js'), render(true))

// ---------- 4. 报告 ----------
const pipe = x => String(x == null ? '' : x).replace(/\|/g, '/')
const cell = (r, p) => {
  const t = r.tests && r.tests[p]
  if (!t) return '—'
  if (!t.ok) return '❌'
  const rank = order[p].indexOf(r.file)
  return (rank >= 0 ? `✅#${rank + 1}` : '✅') + ` ${(t.ms / 1000).toFixed(1)}s`
}
const songLine = p => {
  const s = report.songs && report.songs[p]
  const f = report.songFrom && report.songFrom[p]
  if (!s) return `- ${p}: ⚠️ 没有测试歌曲`
  return `- ${p}: ${s.name} - ${s.singer}（${s.songmid}）${f && f.from === 'fixture' ? ' ⚠️ 搜索失败，使用固定歌曲' : ''}` +
    (f && f.errors && f.errors.length ? `\n  - 搜索错误: ${pipe(f.errors.join('; ')).slice(0, 300)}` : '')
}
let md = `# 音源测试报告\n\n` +
  `- 时间: ${report.time}\n- 测试音质: ${report.quality || ''}\n` +
  `- 测试环境: 真实移动端 preload（落雪移动版 / Cymusic 同款），兼容落雪桌面版\n` +
  `- 参数: 单源超时 ${cfg.TIMEOUT_MS}ms / 追加间隔 ${cfg.HEDGE_MS}ms / 并发 ${cfg.RACE_CONCURRENCY} / 默认音质 ${cfg.DEFAULT_QUALITY} / 去混淆 ${cfg.EXCLUDE_OBFUSCATED} / 每平台 ${cfg.TOP_PER_PLATFORM || '不限'} 个 / 去重阈值 ${cfg.DEDUP_THRESHOLD}\n` +
  `- 合并: ${picked.length} 个，文件 ${(out.length / 1024).toFixed(0)} KB\n\n` +
  `## 测试歌曲\n\n` + TESTED.map(songLine).join('\n') + `\n\n` +
  `## 结果\n\n#N = 该平台的优先顺序\n\n| 音源 | 版本 | 大小 | ${TESTED.join(' | ')} | 结果 | 错误 |\n|---|---|---|${TESTED.map(() => '---').join('|')}|---|---|\n`
for (const r of report.results) {
  md += `| ${pipe(r.name || r.file)}${r.obfuscated ? ' 🔒' : ''} | ${pipe(r.version)} | ${((r.size || 0) / 1024).toFixed(0)}K | ${TESTED.map(p => cell(r, p)).join(' | ')} | ${usedFiles.has(r.file) ? '✅ 合并' : reason.get(r.file) || ''} | ${pipe(r.initError || r.error || '').slice(0, 80)} |\n`
}
md += `\n## 各平台顺序\n\n` + TESTED.map(p => `- **${p}**: ${order[p].map(f => picked[idxOf.get(f)].name).join(' → ') || '（无）'}`).join('\n')
if (dedupNote.length) md += `\n\n## 去重\n\n` + dedupNote.map(x => `- ${x}`).join('\n')
fs.writeFileSync(path.join(path.dirname(outPath), 'REPORT.md'), md + '\n')

console.log(`合并 ${picked.length} 个音源 -> ${outPath} (${(out.length / 1024).toFixed(0)} KB)`)
for (const p of TESTED) console.log(`  ${p}: ${order[p].map(f => picked[idxOf.get(f)].name).join(' → ') || '（无）'}`)
