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
const ENVS = ['desktop', 'mobile']
// 取某音源在某环境下的测试结果（旧报告没有 mobile 字段时，手机沿用桌面）
const envResult = (r, env) => (env === 'mobile' ? (r.mobile || r) : r)
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

// ---------- 2. 每个环境、每个平台：排名 + 去重 + 取前 N ----------
const score = (r, env, p) => {
  const t = envResult(r, env).tests && envResult(r, env).tests[p]
  if (!t || !t.ok) return Infinity
  return (t.reachable === false ? 100000 : 0) + (t.ms || 0)
}
const totalPassed = r => new Set([...(r.passed || []), ...((r.mobile && r.mobile.passed) || [])]).size
const order = { desktop: {}, mobile: {} }   // 环境 -> 平台 -> [音源 file]
const dedupNote = []
for (const env of ENVS) {
  for (const p of TESTED) {
    const cands = UNTESTED.includes(p)
      ? pool.filter(r => envResult(r, env).inited !== false && (envResult(r, env).platforms || []).includes(p)).sort((a, b) => totalPassed(b) - totalPassed(a))
      : pool.filter(r => score(r, env, p) < Infinity).sort((a, b) => score(a, env, p) - score(b, env, p))
    const chosen = []
    for (const c of cands) {
      if (cfg.TOP_PER_PLATFORM > 0 && chosen.length >= cfg.TOP_PER_PLATFORM) break
      const dup = cfg.DEDUP_THRESHOLD < 1 && chosen.find(x => jaccard(x.hosts || [], c.hosts || []) >= cfg.DEDUP_THRESHOLD)
      if (dup) { dedupNote.push(`${env === 'mobile' ? '手机' : '桌面'} ${p}: ${c.name || c.file} 与 ${dup.name || dup.file} 接口重复`); continue }
      chosen.push(c)
    }
    order[env][p] = chosen.map(r => r.file)
  }
}
const usedFiles = new Set(ENVS.flatMap(env => Object.values(order[env]).flat()))
const picked = pool.filter(r => usedFiles.has(r.file))
  .sort((a, b) => totalPassed(b) - totalPassed(a) || a.file.localeCompare(b.file))
for (const r of pool) if (!usedFiles.has(r.file)) reason.set(r.file, '精简（排名靠后或接口重复）')

const idxOf = new Map(picked.map((r, i) => [r.file, i]))
const ORDER = Object.fromEntries(ENVS.map(env => [env, Object.fromEntries(TESTED.map(p => [p, order[env][p].map(f => idxOf.get(f))]))]))

// ---------- 3. 生成合集 ----------
const modules = picked.map(r => {
  const code = fs.readFileSync(path.join(srcDir, r.file), 'utf8')
  // 两个环境都没选它的平台才屏蔽；运行时再按当前环境的 ORDER 过滤
  const block = TESTED.filter(p => ENVS.every(env => !order[env][p].includes(r.file)))
  return `  {\n    name: ${JSON.stringify(r.name || r.file)},\n    block: ${JSON.stringify(block)},\n    load: function (globalThis, window, self, lx) {\n${code}\n    }\n  }`
}).join(',\n')

const date = new Date().toISOString().slice(0, 10)
const VALID_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
// 各环境测试通过的平台（构建时已知），用来在脚本加载时立即声明
const STATIC_SOURCES = Object.fromEntries(ENVS.map(env => [env, TESTED.filter(p => order[env][p].length > 0)]))

function render(debug) {
  const config = {
    TIMEOUT_MS: cfg.TIMEOUT_MS,
    RACE_CONCURRENCY: Math.max(1, cfg.RACE_CONCURRENCY),
    DEFAULT_QUALITY: cfg.DEFAULT_QUALITY,
    REMEMBER_LAST: cfg.REMEMBER_LAST,
    DEBUG: debug,
  }
  return `/*!
 * @name ${debug ? '聚合音源合集-调试版' : '聚合音源合集'}
 * @description ${picked.length}个源 并发${config.RACE_CONCURRENCY} 超时${cfg.TIMEOUT_MS / 1000}s 默认${cfg.DEFAULT_QUALITY}
 * @version v${date.replace(/-/g, '.')}
 * @author lx-merged
 */
;(function () {
  var CONFIG = ${JSON.stringify(config)}
  var ORDER = ${JSON.stringify(ORDER)}
  var STATIC_SOURCES = ${JSON.stringify(STATIC_SOURCES)}
  var VALID_SOURCES = ${JSON.stringify(VALID_SOURCES)}
  var VALID_QUALITYS = ['128k', '320k', 'flac', 'flac24bit']
  var realG = globalThis
  var realLx = realG.lx
  var E = realLx.EVENT_NAMES
  var ENV = realLx.env === 'mobile' ? 'mobile' : 'desktop'
  ORDER = ORDER[ENV]
  STATIC_SOURCES = STATIC_SOURCES[ENV]
  var subs = []
  var lastOk = {}
  var declared = {}   // 子音源同步声明的平台/音质

  function log() {
    if (!CONFIG.DEBUG) return
    var a = Array.prototype.slice.call(arguments)
    a.unshift('[聚合 ' + new Date().toISOString().slice(11, 23) + ']')
    try { console.log.apply(console, a) } catch (e) {}
  }
  function warn() {
    var a = Array.prototype.slice.call(arguments)
    a.unshift('[聚合]')
    try { console.warn.apply(console, a) } catch (e) {}
  }

  // ---- 给子音源用的 globalThis：不能代理 window 本身（lx 是只读不可配置属性，代理会违反 Proxy 规则）
  //      所以用空对象做 target，读写都转发到真实 window；原生方法（setTimeout/fetch 等）绑定回 window 避免 Illegal invocation
  var bindCache = typeof Map === 'function' ? new Map() : null
  function readGlobal(k) {
    var v = realG[k]
    if (typeof v === 'function' && !v.prototype && bindCache) {
      var b = bindCache.get(v)
      if (!b) { b = v.bind(realG); bindCache.set(v, b) }
      return b
    }
    return v
  }
  var GLOBAL_ALIASES = { globalThis: 1, window: 1, self: 1, top: 1, parent: 1, frames: 1 }
  function makeFakeG(fakeLx) {
    if (typeof Proxy !== 'function') {
      var o = Object.create(realG)
      Object.defineProperty(o, 'lx', { value: fakeLx })
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

  function makeFakeLx(sub) {
    return {
      EVENT_NAMES: E,
      version: realLx.version,
      env: realLx.env,
      utils: realLx.utils,
      currentScriptInfo: realLx.currentScriptInfo,
      request: function () { return realLx.request.apply(realLx, arguments) },
      on: function (ev, fn) {
        if (ev === E.request) { sub.handler = fn; log('注册 handler:', sub.name) }
        return Promise.resolve()
      },
      send: function (ev, data) {
        if (ev === E.inited) {
          var src = {}
          var ds = (data && data.sources) || {}
          Object.keys(ds).forEach(function (k) { if (sub.block.indexOf(k) < 0) src[k] = ds[k] })
          sub.sources = src
          if (!sub.loaded) mergeDeclared(src)   // 同步声明的计入；异步的只用于路由
          log('子音源 inited:', sub.name, Object.keys(src).join(','))
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
    var sub = { idx: idx, name: m.name, block: m.block, handler: null, sources: null, loaded: false, error: null }
    var fakeLx = makeFakeLx(sub)
    var fakeG = makeFakeG(fakeLx)
    var t0 = Date.now()
    try { m.load.call(fakeG, fakeG, fakeG, fakeG, fakeLx) }
    catch (e) { sub.error = e && e.message || String(e); warn('加载失败', m.name, sub.error) }
    sub.loaded = true
    log('加载', m.name, (Date.now() - t0) + 'ms', sub.handler ? 'OK' : '无 handler（可能异步注册）')
    subs.push(sub)
  })

  function supports(sub, req) {
    if (!sub.handler || sub.block.indexOf(req.source) >= 0) return false
    // 已测平台：只用当前环境（桌面/手机）测试通过的音源
    if (ORDER[req.source] && ORDER[req.source].indexOf(sub.idx) < 0) return false
    if (!sub.sources) return true
    var s = sub.sources[req.source]
    return !!s && (!s.actions || s.actions.indexOf(req.action) >= 0)
  }
  function isValid(action, r) {
    if (action === 'lyric') return !!r && typeof r === 'object' && typeof r.lyric === 'string'
    return typeof r === 'string' && r.length <= 2048 && /^https?:/i.test(r)
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
      var t0 = Date.now()
      var timer = setTimeout(function () { rej(new Error(s.name + ' 超时')) }, CONFIG.TIMEOUT_MS)
      Promise.resolve().then(function () { return s.handler(req) }).then(function (r) {
        clearTimeout(timer)
        if (isValid(req.action, r)) { log('✓', s.name, (Date.now() - t0) + 'ms', String(r).slice(0, 100)); res(r) }
        else rej(new Error(s.name + ' 返回无效: ' + String(r).slice(0, 80)))
      }, function (e) { clearTimeout(timer); rej(new Error(s.name + ': ' + (e && e.message || e))) })
    })
  }
  // 并发竞速：同时跑 N 个，谁先成功用谁；失败一个就补下一个
  function race(list, req) {
    return new Promise(function (resolve, reject) {
      var next = 0, running = 0, done = false, errors = []
      function finish() {
        if (!done && running === 0 && next >= list.length) {
          done = true
          reject(new Error(errors.length ? '全部失败: ' + errors.join(' | ').slice(0, 300) : '没有可用音源'))
        }
      }
      function launch() {
        while (!done && running < CONFIG.RACE_CONCURRENCY && next < list.length) {
          (function (s) {
            running++
            log('→ 尝试', s.name)
            callOne(s, req).then(function (r) {
              running--
              if (done) return
              done = true
              lastOk[req.source] = s.idx
              resolve(r)
            }, function (e) {
              running--
              errors.push(e && e.message)
              if (lastOk[req.source] === s.idx) delete lastOk[req.source]
              log('✗', e && e.message)
              if (!done) launch()
              finish()
            })
          })(list[next++])
        }
        finish()
      }
      launch()
    })
  }

  realLx.on(E.request, function (req) {
    if (req && req.info && !req.info.type && req.source !== 'local') req.info.type = CONFIG.DEFAULT_QUALITY
    var list = candidates(req)
    log('请求', req.source, req.action, req.info && req.info.type, req.info && req.info.musicInfo && req.info.musicInfo.name, '候选:', list.map(function (s) { return s.name }).join(' / '))
    return race(list, req)
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
    var q = (declared[k] && declared[k].qualitys || []).filter(function (x) { return VALID_QUALITYS.indexOf(x) >= 0 })
    if (!q.length) q = VALID_QUALITYS.slice()
    if (q.indexOf(CONFIG.DEFAULT_QUALITY) < 0) q.unshift(CONFIG.DEFAULT_QUALITY)
    sources[k] = { name: names[k], type: 'music', actions: ['musicUrl'], qualitys: VALID_QUALITYS.filter(function (x) { return q.indexOf(x) >= 0 }) }
  })
  log('环境', ENV, 'inited', JSON.stringify(sources))
  if (CONFIG.DEBUG) realG.__lxMerged = { subs: subs, lastOk: lastOk, CONFIG: CONFIG, ORDER: ORDER, sources: sources }
  realLx.send(E.inited, { openDevTools: CONFIG.DEBUG, sources: sources })
})()
`
}
const out = render(false)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath.replace(/\.js$/, '.debug.js'), render(true))
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out)

// ---------- 4. 报告 ----------
const pipe = x => String(x == null ? '' : x).replace(/\|/g, '/')
const one = (r, env, p) => {
  const t = envResult(r, env).tests && envResult(r, env).tests[p]
  if (!t) return '—'
  if (!t.ok) return '❌'
  const rank = order[env][p].indexOf(r.file)
  return (rank >= 0 ? `✅#${rank + 1}` : '✅') + ` ${(t.ms / 1000).toFixed(1)}s`
}
const cell = (r, p) => `${one(r, 'desktop', p)}<br>📱${one(r, 'mobile', p)}`
const songLine = p => {
  const s = report.songs && report.songs[p]
  const f = report.songFrom && report.songFrom[p]
  if (!s) return `- ${p}: ⚠️ 没有测试歌曲`
  return `- ${p}: ${s.name} - ${s.singer}（${s.songmid}）${f && f.from === 'fixture' ? ' ⚠️ 搜索失败，使用固定歌曲' : ''}` +
    (f && f.errors && f.errors.length ? `\n  - 搜索错误: ${pipe(f.errors.join('; ')).slice(0, 300)}` : '')
}
const errOf = r => {
  const d = r.initError || r.error, m = r.mobile && (r.mobile.initError || r.mobile.error)
  return [d && `桌面: ${d}`, m && `手机: ${m}`].filter(Boolean).map(x => pipe(x).slice(0, 80)).join('<br>')
}
const orderLine = (env, p) => `- **${p}**: ${order[env][p].map(f => picked[idxOf.get(f)].name).join(' → ') || '（无）'}`
let md = `# 音源测试报告\n\n` +
  `- 时间: ${report.time}\n- 测试音质: ${report.quality || ''}\n` +
  `- 参数: 超时 ${cfg.TIMEOUT_MS}ms / 并发 ${cfg.RACE_CONCURRENCY} / 默认音质 ${cfg.DEFAULT_QUALITY} / 去混淆 ${cfg.EXCLUDE_OBFUSCATED} / 每平台 ${cfg.TOP_PER_PLATFORM || '不限'} 个 / 去重阈值 ${cfg.DEDUP_THRESHOLD}\n` +
  `- 合并: ${picked.length} 个，文件 ${(out.length / 1024).toFixed(0)} KB\n\n` +
  `## 测试歌曲\n\n` + TESTED.map(songLine).join('\n') + `\n\n` +
  `## 结果\n\n每格上面是桌面版，📱 是移动版；#N = 该平台的优先顺序\n\n| 音源 | 版本 | 大小 | ${TESTED.join(' | ')} | 结果 | 错误 |\n|---|---|---|${TESTED.map(() => '---').join('|')}|---|---|\n`
for (const r of report.results) {
  md += `| ${pipe(r.name || r.file)}${r.obfuscated ? ' 🔒' : ''} | ${pipe(r.version)} | ${((r.size || 0) / 1024).toFixed(0)}K | ${TESTED.map(p => cell(r, p)).join(' | ')} | ${usedFiles.has(r.file) ? '✅ 合并' : reason.get(r.file) || ''} | ${errOf(r)} |\n`
}
md += `\n## 各平台顺序（桌面版）\n\n` + TESTED.map(p => orderLine('desktop', p)).join('\n')
md += `\n\n## 各平台顺序（移动版）\n\n` + TESTED.map(p => orderLine('mobile', p)).join('\n')
if (dedupNote.length) md += `\n\n## 去重\n\n` + dedupNote.map(x => `- ${x}`).join('\n')
fs.writeFileSync(path.join(path.dirname(outPath), 'REPORT.md'), md + '\n')

console.log(`合并 ${picked.length} 个音源 -> ${outPath} (${(out.length / 1024).toFixed(0)} KB)`)
for (const env of ENVS) for (const p of TESTED) console.log(`  [${env === 'mobile' ? '手机' : '桌面'}] ${p}: ${order[env][p].map(f => picked[idxOf.get(f)].name).join(' → ') || '（无）'}`)
