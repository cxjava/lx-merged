// 测试每个音源：搜索歌曲 -> 让音源取播放链接 -> 检查链接可访问
// 只有一套测试环境：真实移动端 preload（见 lx-env.js），能过的在桌面版也能用
// QQ 用 Cymusic 的调用方式（source=tx，musicInfo 只有 songmid/name/singer），保证 Cymusic 能播
// 用法: node scripts/test-sources.js <源目录> [报告输出路径]
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { findSong } = require('./search')
const cfg = require('./config')

const PLATFORMS = ['kw', 'kg', 'tx', 'wy', 'mg']
const KEYWORD = process.env.TEST_KEYWORD || '晴天 周杰伦'
const PER_FILE_TIMEOUT = 120000
const CONCURRENCY = 4

function parseMeta(code) {
  const head = code.slice(0, 3000)
  const get = k => (head.match(new RegExp('@' + k + '\\s+(.+)')) || [])[1]?.trim()
  return { name: get('name'), version: get('version'), author: get('author'), description: get('description') }
}

// ---------- 子进程：在某个模式下测试单个文件 ----------
async function runOne(file, songsFile) {
  const { loadSource } = require('./lx-env')
  const songs = JSON.parse(fs.readFileSync(songsFile, 'utf8'))
  const code = fs.readFileSync(file, 'utf8')
  const { handler, sources, initError, logs } = await loadSource(code, { normalizeJson: true })
  const result = { loaded: !!handler, inited: !!sources && !initError, initError, platforms: Object.keys(sources || {}), tests: {}, logs: logs.slice(0, 20) }
  if (!handler || initError) return result
  await Promise.all(PLATFORMS.map(async p => {
    if (sources && !sources[p]) return
    if (!songs[p]) { result.tests[p] = { ok: false, error: '没有测试歌曲，跳过' }; return }
    const t0 = Date.now()
    try {
      const url = await Promise.race([
        Promise.resolve(handler({ source: p, action: 'musicUrl', info: { type: cfg.DEFAULT_QUALITY, musicInfo: songs[p] } })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
      ])
      if (typeof url !== 'string' || url.length > 2048 || !/^https?:/i.test(url)) throw new Error('返回无效: ' + String(url).slice(0, 100))
      let reachable = null
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(10000), redirect: 'follow' })
        reachable = r.status < 400
      } catch { reachable = false }
      result.tests[p] = { ok: true, reachable, ms: Date.now() - t0, url: url.slice(0, 120) }
    } catch (e) {
      result.tests[p] = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 200) }
    }
  }))
  return result
}

if (process.argv[2] === '--child') {
  runOne(process.argv[3], process.argv[4])
    .then(r => { process.stdout.write('\n@@RESULT@@' + JSON.stringify(r)); process.exit(0) })
    .catch(e => { process.stdout.write('\n@@RESULT@@' + JSON.stringify({ loaded: false, error: String(e) })); process.exit(0) })
  return
}

// ---------- 主进程 ----------
function child(file, songsFile) {
  return new Promise(resolve => {
    execFile(process.execPath, [__filename, '--child', file, songsFile], { timeout: PER_FILE_TIMEOUT, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const i = stdout ? stdout.lastIndexOf('@@RESULT@@') : -1
      if (i >= 0) { try { return resolve(JSON.parse(stdout.slice(i + 10))) } catch {} }
      resolve({ loaded: false, error: err ? String(err.message).slice(0, 200) : '无输出', tests: {} })
    })
  })
}
const passedOf = r => Object.entries(r.tests || {}).filter(([, t]) => t.ok).map(([p]) => p)

async function main() {
  const dir = path.resolve(process.argv[2] || 'sources')
  const out = path.resolve(process.argv[3] || 'report.json')
  const files = []
  ;(function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.js')) files.push(p)
    }
  })(dir)
  files.sort()

  console.log(`搜索关键词: ${KEYWORD}  测试音质: ${cfg.DEFAULT_QUALITY}`)
  const songs = {}
  const songFrom = {}
  for (const p of PLATFORMS) {
    const r = await findSong(p, KEYWORD)
    songs[p] = r.song
    songFrom[p] = { from: r.from, errors: r.errors }
    const tag = r.from === 'fixture' ? '⚠️ 搜索失败，使用固定歌曲' : r.from
    console.log(`  [搜索] ${p}: ${r.song.name} - ${r.song.singer} (${r.song.songmid}) [${tag}]`)
    for (const e of r.errors) console.log(`         ${e}`)
  }
  // QQ：按 Cymusic 的方式只给最少字段
  if (songs.tx) {
    const t = songs.tx
    songs.tx = { id: t.songmid, songmid: t.songmid, title: t.name, name: t.name, singer: t.singer, artist: t.singer, source: 'tx', hash: t.songmid }
  }
  const songsFile = path.join(require('os').tmpdir(), 'lx-test-songs.json')
  fs.writeFileSync(songsFile, JSON.stringify(songs))

  const report = []
  let idx = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < files.length) {
      const f = files[idx++]
      const r = await child(f, songsFile)
      const code = fs.readFileSync(f, 'utf8')
      const meta = { ...parseMeta(code), size: code.length, obfuscated: cfg.isObfuscated(code, f), hosts: cfg.apiHosts(code) }
      const passed = passedOf(r)
      const entry = { file: path.relative(dir, f), ...meta, ...r, passed, valid: passed.length > 0 }
      report.push(entry)
      const err = r.initError || r.error
      console.log(`${entry.valid ? '✅' : '❌'}${meta.obfuscated ? '[混淆]' : ''} ${entry.file}  通过:[${passed.join(',')}]` + (err ? '  错误: ' + String(err).slice(0, 80) : ''))
    }
  }))
  report.sort((a, b) => a.file.localeCompare(b.file))
  fs.writeFileSync(out, JSON.stringify({ keyword: KEYWORD, quality: cfg.DEFAULT_QUALITY, time: new Date().toISOString(), songs, songFrom, results: report }, null, 2))
  console.log(`\n有效 ${report.filter(r => r.valid).length}/${report.length}，报告: ${out}`)
}
main()
