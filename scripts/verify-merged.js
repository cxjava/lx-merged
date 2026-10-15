// 测试合并后的文件：每个平台请求两次（第二次应命中"上次成功的音源"，更快）
// 至少一个平台能出链接才算通过，否则退出码 1，阻止提交
const fs = require('fs')
const { loadSource } = require('./lx-env')
const { searchers } = require('./search')
const cfg = require('./config')

;(async () => {
  const code = fs.readFileSync(process.argv[2] || 'dist/lx-merged.js', 'utf8')
  const { handler, sources } = await loadSource(code)
  if (!handler || !sources) { console.log('❌ 合集加载失败'); process.exit(1) }
  console.log(`平台: ${Object.keys(sources).join(',')}  大小: ${(code.length / 1024).toFixed(0)}KB  音质: ${cfg.DEFAULT_QUALITY}`)
  let ok = 0
  for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) {
    let info
    try { info = await searchers[p](process.env.TEST_KEYWORD || '晴天 周杰伦') } catch (e) { console.log(`⚠️ ${p}: 搜索失败`); continue }
    const times = []
    let url = null, err = null
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now()
      try { url = await handler({ source: p, action: 'musicUrl', info: { type: cfg.DEFAULT_QUALITY, musicInfo: info } }); times.push(Date.now() - t0) }
      catch (e) { err = e; times.push('失败') }
    }
    if (url) { ok++; console.log(`✅ ${p} [${times.map(t => typeof t === 'number' ? (t / 1000).toFixed(1) + 's' : t).join(' / ')}] ${String(url).slice(0, 70)}`) }
    else console.log(`❌ ${p}: ${err && err.message}`)
  }
  process.exit(ok > 0 ? 0 : 1)
})()
