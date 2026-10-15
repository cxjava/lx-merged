// 测试合并后的文件：桌面版、移动版两种模拟环境，各平台请求两次（第二次应命中"上次成功的音源"）
// 桌面版至少一个平台成功才算通过，否则退出码 1，阻止发布；移动版只告警
const fs = require('fs')
const { loadSource } = require('./lx-env')
const { findSong } = require('./search')
const cfg = require('./config')

;(async () => {
  const file = process.argv[2] || 'dist/lx-merged.js'
  const code = fs.readFileSync(file, 'utf8')
  const songs = {}
  for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) songs[p] = (await findSong(p, process.env.TEST_KEYWORD || '晴天 周杰伦')).song
  const okBy = {}
  for (const mode of ['desktop', 'mobile']) {
    const { handler, sources, initError, logs } = await loadSource(code, { mode })
    const loadErrors = logs.filter(l => /加载失败|LOAD_ERROR|INIT_ERROR/.test(l))
    console.log(`\n[${mode === 'mobile' ? '移动版' : '桌面版'}] ${file}  ${(code.length / 1024).toFixed(0)}KB  平台: ${Object.keys(sources || {}).join(',')}`)
    if (loadErrors.length) console.log('  ' + loadErrors.join('\n  ').slice(0, 1000))
    if (initError || !handler || !sources) { console.log('  ❌ 初始化失败: ' + (initError || '无 handler/sources')); okBy[mode] = 0; continue }
    let ok = 0
    for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) {
      if (!sources[p]) { console.log(`  — ${p}: 未声明`); continue }
      const times = []
      let url = null, err = null
      for (let i = 0; i < 2; i++) {
        const t0 = Date.now()
        try { url = await handler({ source: p, action: 'musicUrl', info: { type: cfg.DEFAULT_QUALITY, musicInfo: songs[p] } }); times.push(Date.now() - t0) }
        catch (e) { err = e; times.push('失败') }
      }
      if (url) { ok++; console.log(`  ✅ ${p} [${times.map(t => typeof t === 'number' ? (t / 1000).toFixed(1) + 's' : t).join(' / ')}] ${String(url).slice(0, 70)}`) }
      else console.log(`  ❌ ${p}: ${String(err && err.message).slice(0, 200)}`)
    }
    okBy[mode] = ok
  }
  if (!okBy.mobile) console.log('\n⚠️ 移动版没有任何平台成功')
  process.exit(okBy.desktop > 0 ? 0 : 1)
})()
