// 各平台搜索 -> 落雪 musicInfo 格式
// 每个平台有多个搜索接口依次尝试；全部失败则使用固定歌曲（FIXTURES），保证测试一定能进行
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

async function getText(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.text()
}
async function getJSON(url, opts) {
  const t = await getText(url, opts)
  try { return JSON.parse(t) } catch {}
  // 酷我老接口有时返回单引号的"伪 JSON"
  try { return JSON.parse(t.replace(/'/g, '"')) } catch {}
  throw new Error('非 JSON 响应: ' + t.slice(0, 80))
}

const types = [{ type: '128k' }, { type: '320k' }, { type: 'flac' }]
const base = { types, _types: { '128k': {}, '320k': {}, flac: {} }, typeUrl: {}, interval: '04:29' }
const enc = encodeURIComponent

// ---------- 搜索接口（按顺序尝试） ----------
const kwFromAbslist = d => {
  const s = d.abslist[0]
  const id = String(s.MUSICRID || s.DC_TARGETID).replace('MUSIC_', '')
  return { ...base, source: 'kw', name: s.SONGNAME || s.NAME, singer: s.ARTIST, albumName: s.ALBUM, albumId: s.ALBUMID, songmid: id, id }
}
const KW_PARAMS = 'ft=music&rformat=json&encoding=utf8&rn=5&pn=0&vipver=1&client=kt&cluster=0&strategy=2012&mobi=1&show_copyright_off=1'

const ENDPOINTS = {
  kw: [
    kw => getJSON(`http://search.kuwo.cn/r.s?all=${enc(kw)}&${KW_PARAMS}`).then(kwFromAbslist),
    kw => getJSON(`https://search.kuwo.cn/r.s?all=${enc(kw)}&${KW_PARAMS}`).then(kwFromAbslist),
    kw => getJSON(`https://www.kuwo.cn/search/searchMusicBykeyWord?all=${enc(kw)}&${KW_PARAMS}&issubtitle=1`).then(kwFromAbslist),
  ],
  kg: [
    async kw => {
      const d = await getJSON(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${enc(kw)}&page=1&pagesize=5`)
      const s = d.data.info[0]
      return { ...base, source: 'kg', name: s.songname, singer: s.singername, albumName: s.album_name, albumId: s.album_id, songmid: s.audio_id, id: s.audio_id, hash: s.hash,
        _types: { '128k': { hash: s.hash }, '320k': { hash: s['320hash'] }, flac: { hash: s.sqhash } } }
    },
  ],
  tx: [
    async kw => {
      const d = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
        body: JSON.stringify({ comm: { ct: '19', cv: '1859', uin: '0' }, req: { method: 'DoSearchForQQMusicDesktop', module: 'music.search.SearchCgiService', param: { num_per_page: 5, page_num: 1, query: kw, search_type: 0 } } }),
      })
      const s = d.req.data.body.song.list[0]
      return { ...base, source: 'tx', name: s.name, singer: s.singer.map(a => a.name).join('、'), albumName: s.album.name, albumId: s.album.mid, albumMid: s.album.mid,
        songmid: s.mid, songId: s.id, id: s.mid, strMediaMid: s.file.media_mid }
    },
    async kw => {
      const d = await getJSON(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${enc(kw)}&format=json&n=5&p=1`, { headers: { Referer: 'https://y.qq.com/' } })
      const s = d.data.song.list[0]
      return { ...base, source: 'tx', name: s.songname, singer: s.singer.map(a => a.name).join('、'), albumName: s.albumname, albumId: s.albummid, albumMid: s.albummid,
        songmid: s.songmid, songId: s.songid, id: s.songmid, strMediaMid: s.strMediaMid || s.media_mid }
    },
  ],
  wy: [
    async kw => {
      const d = await getJSON(`https://music.163.com/api/search/get?s=${enc(kw)}&type=1&limit=5`, { headers: { Referer: 'https://music.163.com/' } })
      const s = d.result.songs[0]
      return { ...base, source: 'wy', name: s.name, singer: s.artists.map(a => a.name).join('、'), albumName: s.album.name, albumId: s.album.id, songmid: s.id, id: s.id }
    },
  ],
  mg: [
    async kw => {
      const d = await getJSON(`https://pd.musicapp.migu.cn/MIGUM3.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${enc(kw)}&pageNo=1&pageSize=5&searchSwitch=%7B%22song%22%3A1%7D`)
      const s = d.songResultData.result[0]
      return { ...base, source: 'mg', name: s.name, singer: (s.singers || []).map(a => a.name).join('、'), albumName: (s.albums || [])[0]?.name, albumId: (s.albums || [])[0]?.id,
        songmid: s.id, id: s.id, copyrightId: s.copyrightId, contentId: s.contentId }
    },
  ],
}

// ---------- 固定歌曲（搜索全部失败时使用） ----------
const FIXTURES = {
  kw: { ...base, source: 'kw', name: '晴天', singer: '周杰伦', albumName: '叶惠美', albumId: '1293', songmid: '228908', id: '228908' },
  kg: { ...base, source: 'kg', name: '晴天', singer: '周杰伦', albumName: '叶惠美', albumId: '966846', songmid: 20505418, id: 20505418, hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7',
    _types: { '128k': { hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7' }, '320k': { hash: '1b56126a8a03924f1dd066259c095cbc' }, flac: { hash: '0a69169202de95aaf24a9944ccf0730d' } } },
  tx: { ...base, source: 'tx', name: '晴天', singer: '周杰伦', albumName: '叶惠美', albumId: '000MkMni19ClKG', albumMid: '000MkMni19ClKG', songmid: '0039MnYb0qxYhV', songId: 97773, id: '0039MnYb0qxYhV', strMediaMid: '003Qui1q2u1Zho' },
  wy: { ...base, source: 'wy', name: '孤勇者', singer: '陈奕迅', albumName: '孤勇者', albumId: 137142551, songmid: 1901371647, id: 1901371647 },
  mg: { ...base, source: 'mg', name: '晴天', singer: '周杰伦', albumName: '叶惠美', albumId: '8592', songmid: '3790007', id: '3790007', copyrightId: '60054701923', contentId: '600902000006889366' },
}

/** 搜索一首歌：每个接口最多重试 retries 次，全失败用固定歌曲。返回 { song, from, errors } */
async function findSong(p, kw, { retries = 2 } = {}) {
  const errors = []
  for (const [i, ep] of (ENDPOINTS[p] || []).entries()) {
    for (let n = 1; n <= retries; n++) {
      try { return { song: await ep(kw), from: `search#${i + 1}`, errors } }
      catch (e) {
        errors.push(`接口${i + 1} 第${n}次: ${e && e.message}`)
        await new Promise(r => setTimeout(r, 1000 * n))
      }
    }
  }
  if (FIXTURES[p]) return { song: { ...FIXTURES[p] }, from: 'fixture', errors }
  throw new Error(errors.join('; '))
}

// 兼容旧调用：searchers[p](kw) -> song
const searchers = Object.fromEntries(Object.keys(ENDPOINTS).map(p => [p, kw => findSong(p, kw).then(r => r.song)]))

module.exports = { searchers, findSong, FIXTURES }
