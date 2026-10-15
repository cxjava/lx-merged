// 统一参数：全部可用环境变量覆盖（GitHub Action 启动时传入）
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)))
const num = (v, d) => (v == null || v === '' || isNaN(+v) ? d : +v)

module.exports = {
  // 单个音源多久没返回就换下一个（毫秒）
  TIMEOUT_MS: num(process.env.TIMEOUT_MS, 5000),
  // 是否去掉加密/混淆的 js
  EXCLUDE_OBFUSCATED: bool(process.env.EXCLUDE_OBFUSCATED, true),
  // 默认音质：测试用它；APP 没传音质时也用它
  DEFAULT_QUALITY: process.env.DEFAULT_QUALITY || '320k',
  // 并发竞速：同时请求几个音源（1 = 顺序尝试）
  RACE_CONCURRENCY: num(process.env.RACE_CONCURRENCY, 3),
  // 精简：每个平台最多保留几个音源（0 = 不限制）
  TOP_PER_PLATFORM: num(process.env.TOP_PER_PLATFORM, 4),
  // 去重：两个音源的接口域名相似度 >= 此值视为底层重复（0~1，1 = 不去重）
  DEDUP_THRESHOLD: num(process.env.DEDUP_THRESHOLD, 0.6),
  // 是否记住每个平台上次成功的音源，下次优先
  REMEMBER_LAST: bool(process.env.REMEMBER_LAST, true),
}

// 判断是否混淆
module.exports.isObfuscated = function (code, file = '') {
  if (/protected|obfusc/i.test(file)) return true
  const count = re => (code.match(re) || []).length
  if (count(/_0x[0-9a-f]{4,}/g) > 50) return true
  if (count(/\(\w,\w,\w\)=>\{let \w="",?/g) > 5) return true
  if (count(/[-+*]\s*0x[0-9a-f]{3,}/gi) > 200) return true
  return false
}

// 提取接口域名（用于判断底层是否重复）
const IGNORE_HOSTS = /(^|\.)(t\.me|github\.com|github\.io|githubusercontent\.com|gitee\.com|toside\.cn|w3\.org|jsdelivr\.net|qq\.com|163\.com|126\.net|kuwo\.cn|kugou\.com|migu\.cn)$/i
module.exports.apiHosts = function (code) {
  const set = new Set()
  for (const m of code.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const h = m[1].toLowerCase()
    if (!IGNORE_HOSTS.test(h)) set.add(h)
  }
  return [...set]
}
