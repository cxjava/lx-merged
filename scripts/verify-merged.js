// 验证合并后的文件（真实移动端 preload，不做 JSON 预处理 = Cymusic 原样行为）
// 1) 落雪方式：各平台完整 musicInfo，320k
// 2) Cymusic 方式：source=tx、最少字段、音质 flac→320k→128k 逐个降级、每次 5 秒上限
// 落雪方式至少一个平台成功、且 Cymusic 方式成功，才算通过（否则退出码 1，阻止发布）
const fs = require('fs')
const { loadSource } = require('./lx-env')
const { findSong } = require('./search')
const cfg = require('./config')

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超过 ${ms}ms`)), ms))])

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
  process.exit(lxOk > 0 && cyOk ? 0 : 1)
})()
