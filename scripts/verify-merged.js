// 验证合并后的文件（真实移动端 preload，不做 JSON 预处理 = Cymusic 原样行为）
// 1) 落雪方式：各平台完整 musicInfo，320k
// 2) Cymusic 方式：source=tx、最少字段、音质 flac→320k→128k 逐个降级、每次 5 秒上限
// 落雪方式至少一个平台成功、且 Cymusic 方式成功，才算通过（否则退出码 1，阻止发布）
const fs = require('fs')
const { loadSource } = require('./lx-env')
const { findSong } = require('./search')
const cfg = require('./config')

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超过 ${ms}ms`)), ms))])

// 最小化的裸 lx 环境：request 用 fetch，handler 直接拿到
function loadRaw(code) {
  const crypto = require('crypto')
  let handler = null
  const lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    version: '2.0.0', env: 'desktop', currentScriptInfo: { name: 'test', description: '', version: '1', author: '', homepage: '', rawScript: code },
    utils: { crypto: { md5: s => crypto.createHash('md5').update(s).digest('hex'), randomBytes: n => crypto.randomBytes(n), aesEncrypt: () => { throw new Error('n/a') }, rsaEncrypt: () => { throw new Error('n/a') } }, buffer: { from: (a, e) => Buffer.from(a, e), bufToString: (b, e) => Buffer.from(b).toString(e) } },
    request(url, opts, cb) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 10000)
      const init = { method: (opts && opts.method) || 'GET', headers: opts && opts.headers, signal: ctl.signal }
      if (opts && opts.body) init.body = opts.body
      else if (opts && opts.form) init.body = new URLSearchParams(opts.form)
      else if (opts && opts.json) { init.body = JSON.stringify(opts.json); init.headers = { 'content-type': 'application/json', ...init.headers } }
      fetch(url, init).then(async r => {
        const text = await r.text(); clearTimeout(t)
        let body = text; try { body = JSON.parse(text) } catch (e) {}
        cb(null, { statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers), bytes: text.length, raw: Buffer.from(text), body }, body)
      }).catch(e => { clearTimeout(t); cb(e, null, null) })
      return () => ctl.abort()
    },
    on(ev, fn) { if (ev === 'request') handler = fn; return Promise.resolve() },
    send() { return Promise.resolve() },
  }
  new Function('lx', 'globalThis', 'window', 'self', code).call(globalThis, lx, new Proxy(globalThis, { get: (t, k) => k === 'lx' ? lx : t[k] }), undefined, undefined)
  return { handler }
}

;(async () => {
  const file = process.argv[2] || 'dist/lx-merged.js'
  const code = fs.readFileSync(file, 'utf8')
  const { handler, sources, initError, logs } = await loadSource(code)
  console.log(`\n${file}  ${(code.length / 1024).toFixed(0)}KB  平台: ${Object.keys(sources || {}).join(',')}`)
  const errs = logs.filter(l => /加载失败|LOAD_ERROR|INIT_ERROR|Call script error/.test(l))
  if (errs.length) console.log('  ' + errs.join('\n  ').slice(0, 1000))
  if (initError || !handler) { console.log('  ❌ 初始化失败: ' + (initError || '无 handler')); process.exit(1) }

  const songs = {}
  for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) songs[p] = (await findSong(p, process.env.TEST_KEYWORD || '晴天 周杰伦')).song

  console.log('  [落雪方式]')
  let lxOk = 0
  for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) {
    if (!sources[p]) { console.log(`  — ${p}: 未声明`); continue }
    const t0 = Date.now()
    try {
      const url = await withTimeout(handler({ source: p, action: 'musicUrl', info: { type: cfg.DEFAULT_QUALITY, musicInfo: songs[p] } }), 20000)
      lxOk++; console.log(`  ✅ ${p} ${((Date.now() - t0) / 1000).toFixed(1)}s ${String(url).slice(0, 70)}`)
    } catch (e) { console.log(`  ❌ ${p}: ${String(e && e.message).slice(0, 200)}`) }
  }

  console.log('  [Cymusic 方式] source=tx，每个音质 5 秒')
  const t = songs.tx
  const mi = { id: t.songmid, songmid: t.songmid, title: t.name, name: t.name, singer: t.singer, artist: t.singer, source: 'tx', hash: t.songmid }
  let cyOk = false
  for (const q of ['flac', '320k', '128k']) {
    const t0 = Date.now()
    try {
      const url = await withTimeout(handler({ action: 'musicUrl', source: 'tx', info: { musicInfo: mi, requestContext: {}, type: q } }), 5000)
      cyOk = true; console.log(`  ✅ ${q} ${((Date.now() - t0) / 1000).toFixed(1)}s ${String(url).slice(0, 70)}`); break
    } catch (e) { console.log(`  ❌ ${q}: ${String(e && e.message).slice(0, 150)}`) }
  }
  // QQ 上没有的歌：songmid 无效，只能靠"识别 Cymusic -> 搜酷我 -> kw 子源"
  let cyKwOk = true
  if (cfg.CYMUSIC_KW) {
    console.log('  [Cymusic 方式·QQ 无此歌] songmid 无效，应自动改走酷我')
    const bad = { ...mi, id: '000000000000AA', songmid: '000000000000AA', hash: '000000000000AA' }
    const t0 = Date.now()
    try {
      const url = await withTimeout(handler({ action: 'musicUrl', source: 'tx', info: { musicInfo: bad, requestContext: {}, type: '320k' } }), 5000)
      console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s ${String(url).slice(0, 70)}`)
    } catch (e) { cyKwOk = false; console.log(`  ❌ ${String(e && e.message).slice(0, 200)}`) }
  }
  // search 扩展：LX 官方 preload 会丢弃非 musicUrl/lyric/pic 的结果，所以这里用裸 lx 直接调用 handler
  // 只要求结构正确（线上接口可能不可用，所有平台都失败才算失败）
  console.log('  [search 扩展·直连 handler]')
  const raw = loadRaw(code)
  let searchOk = 0, searchTried = 0
  for (const p of ['kw', 'wy', 'mg', 'tx', 'kg', 'qs', 'qsvip']) {
    searchTried++
    const t0 = Date.now()
    try {
      const r = await withTimeout(raw.handler({ source: p, action: 'search', info: { keyword: '晴天 周杰伦', page: 1, limit: 10 } }), cfg.SEARCH_TIMEOUT_MS + 2000)
      const keys = r.list.map(x => `${x.name}|${x.singer}`)
      if (!r.list.every(x => x.source === p && x.name) || new Set(keys).size !== keys.length) throw new Error('结构或去重异常')
      searchOk++
      console.log(`  ✅ ${p} ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.list.length} 条 来源 ${r.from.map(f => `${f.name}:${f.ok ? f.count : 'x(' + String(f.error).slice(0, 40) + ')'}`).join(',')}`)
    } catch (e) { console.log(`  ❌ ${p}: ${String(e && e.message).slice(0, 200)}`) }
  }
  const searchPass = searchTried === 0 || searchOk > 0
  process.exit(lxOk > 0 && cyOk && cyKwOk && searchPass ? 0 : 1)
})()
