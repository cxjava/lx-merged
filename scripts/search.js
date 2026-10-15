// 各平台官方搜索接口 -> 落雪 musicInfo 格式
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15000) })
  const t = await r.text()
  return JSON.parse(t)
}

const types = [{ type: '128k' }, { type: '320k' }, { type: 'flac' }]
const base = { types, _types: { '128k': {}, '320k': {}, flac: {} }, typeUrl: {} }

const searchers = {
  async kw(kw) {
    const d = await getJSON(`http://search.kuwo.cn/r.s?all=${encodeURIComponent(kw)}&ft=music&rformat=json&encoding=utf8&rn=5&pn=0&vipver=1&client=kt&cluster=0&strategy=2012&mobi=1`)
    const s = d.abslist[0]
    const id = s.MUSICRID.replace('MUSIC_', '')
    return { ...base, source: 'kw', name: s.SONGNAME, singer: s.ARTIST, albumName: s.ALBUM, albumId: s.ALBUMID, songmid: id, id, interval: '04:29' }
  },
  async kg(kw) {
    const d = await getJSON(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=5`)
    const s = d.data.info[0]
    return { ...base, source: 'kg', name: s.songname, singer: s.singername, albumName: s.album_name, albumId: s.album_id, songmid: s.audio_id, id: s.audio_id, hash: s.hash, interval: '04:29',
      _types: { '128k': { hash: s.hash }, '320k': { hash: s['320hash'] }, flac: { hash: s.sqhash } } }
  },
  async wy(kw) {
    const d = await getJSON(`https://music.163.com/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=5`, { Referer: 'https://music.163.com/' })
    const s = d.result.songs[0]
    return { ...base, source: 'wy', name: s.name, singer: s.artists.map(a => a.name).join('、'), albumName: s.album.name, albumId: s.album.id, songmid: s.id, id: s.id, interval: '04:29' }
  },
  async tx(kw) {
    const d = await getJSON(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(kw)}&format=json&n=5&p=1`, { Referer: 'https://y.qq.com/' })
    const s = d.data.song.list[0]
    return { ...base, source: 'tx', name: s.songname, singer: s.singer.map(a => a.name).join('、'), albumName: s.albumname, albumId: s.albummid, albumMid: s.albummid,
      songmid: s.songmid, songId: s.songid, id: s.songmid, strMediaMid: s.strMediaMid || s.media_mid, interval: '04:29' }
  },
  async mg(kw) {
    const d = await getJSON(`https://pd.musicapp.migu.cn/MIGUM3.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(kw)}&pageNo=1&pageSize=5&searchSwitch=%7B%22song%22%3A1%7D`)
    const s = d.songResultData.result[0]
    return { ...base, source: 'mg', name: s.name, singer: (s.singers || []).map(a => a.name).join('、'), albumName: (s.albums || [])[0]?.name, albumId: (s.albums || [])[0]?.id,
      songmid: s.id, id: s.id, copyrightId: s.copyrightId, contentId: s.contentId, interval: '04:29' }
  },
}

module.exports = { searchers }
