// 测试用的 lx 运行环境：只有一套，取各 APP 的"最严格公共子集"
//
// 直接运行真实的 preload（scripts/vendor/user-api-preload.js，来自 Cymusic，与落雪移动版一致），
// 宿主侧（原生桥）按 Cymusic 的实现模拟（CyMusicUserApiRuntime.m + lxMusicSourceAdapter.ts）：
//   - 全新 JS 上下文，只有 console；setTimeout/clearTimeout 由 preload 提供
//   - 没有 fetch / URL / atob / btoa / TextEncoder / Buffer / setInterval
//   - lx 深度冻结；globalThis 已有属性全部只读不可配置；eval / new Function 被禁用
//   - lx.utils 部分实现（zlib 不可用，AES 只支持 128 cbc/ecb）
//   - HTTP：只有响应头含 json 才解析 JSON，否则 body 是字符串；GET 不发 body
//   - 发送 inited 之前任何未捕获异常 = 初始化失败
// 能在这里跑通的脚本，在落雪桌面版 / 落雪移动版 / Cymusic / 歌一刀 上都应该能跑
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')

// 真实 APP 的 JS 引擎里，未处理的 Promise 拒绝只会被忽略，不会让进程崩溃
process.on('unhandledRejection', () => {})

const PRELOAD = fs.readFileSync(path.join(__dirname, 'vendor/user-api-preload.js'), 'utf8')

// Cymusic handleHttpRequest 的行为
async function hostHttp(url, options = {}, { normalizeJson = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.min(options.timeout > 0 ? options.timeout : 15000, 60000))
  try {
    const method = String(options.method || 'GET').toUpperCase()
    const headers = { ...(options.headers || {}) }
    const init = { method, headers, signal: ctrl.signal }
    const data = options.body ?? options.data
    if (method !== 'GET' && method !== 'HEAD') {
      if (options.form && typeof options.form === 'object') {
        init.body = new URLSearchParams(Object.entries(options.form).map(([k, v]) => [k, String(v)])).toString()
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      } else if (options.formData != null) init.body = options.formData
      else if (data != null) init.body = typeof data === 'string' ? data : JSON.stringify(data)
    }
    const r = await fetch(url, init)
    const ct = r.headers.get('content-type') || ''
    let body
    if (options.binary) body = Buffer.from(await r.arrayBuffer()).toString('base64')
    else {
      const text = await r.text()
      body = text
      if (ct.includes('json') || (normalizeJson && /^\s*[{[]/.test(text))) { try { body = JSON.parse(text) } catch {} }
    }
    return { statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers), body }
  } finally { clearTimeout(timer) }
}

// 原生工具函数（与 CyMusicUserApiRuntime.m 对应）
const nativeUtils = {
  str2b64: s => Buffer.from(String(s ?? ''), 'utf8').toString('base64'),
  b642buf: b => JSON.stringify([...Buffer.from(String(b ?? ''), 'base64')].map(x => (x > 127 ? x - 256 : x))),
  str2md5: s => { let d = String(s ?? ''); try { d = decodeURIComponent(d) } catch {} return crypto.createHash('md5').update(d, 'utf8').digest('hex') },
  aesEncrypt: (dataB64, keyB64, ivB64, mode) => {
    try {
      const data = Buffer.from(dataB64, 'base64'), key = Buffer.from(keyB64, 'base64')
      if (!data.length || !key.length) return ''
      let c
      if (mode === 'AES/CBC/PKCS7Padding') c = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.from(ivB64 || '', 'base64'))
      else if (mode === 'AES') { c = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null); c.setAutoPadding(false) }
      else return ''
      return Buffer.concat([c.update(data), c.final()]).toString('base64')
    } catch { return '' }
  },
  rsaEncrypt: (dataB64, keyBody) => {
    try {
      let buf = Buffer.from(dataB64, 'base64')
      const key = crypto.createPublicKey({ key: Buffer.from(keyBody.replace(/\s/g, ''), 'base64'), format: 'der', type: 'spki' })
      const size = key.asymmetricKeyDetails.modulusLength / 8
      if (buf.length < size) buf = Buffer.concat([Buffer.alloc(size - buf.length), buf])
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buf).toString('base64')
    } catch { return '' }
  },
}

/**
 * 加载脚本。返回 { handler, sources, initError, logs }
 * handler(req) 走和 APP 一样的路径：__lx_native__('request') -> 脚本 -> nativeCall('response')
 * 所以 musicUrl 返回值的校验（必须是 http 开头且 <= 2048）也和 APP 一致
 */
// normalizeJson: 测试单个子音源时打开 —— 合集外壳会把"像 JSON 的字符串 body"统一解析，这里模拟同样效果
function loadSource(code, { waitInit = 5000, name = 'test', normalizeJson = false } = {}) {
  return new Promise(resolve => {
    const logs = []
    const KEY = 'k' + Math.random().toString(36).slice(2)
    const timers = new Map()
    const pending = new Map()
    let G
    let inited = false, initError, sources = null, finished = false

    const callJS = (action, data) => {
      try { return G.__lx_native__(KEY, action, data === undefined ? null : JSON.stringify(data)) }
      catch (e) { logs.push('Call script error: ' + (e && e.message)); fail(e && e.message) }
    }
    const fail = msg => { if (inited) return; inited = true; initError = String(msg); logs.push('INIT_ERROR: ' + msg); done() }
    const done = () => {
      if (finished) return
      finished = true
      resolve({ handler: sources && !initError ? handler : null, sources, initError, logs })
    }

    const fmt = a => a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })())).join(' ')
    const log = (...a) => logs.push(fmt(a))
    const ctx = { console: { log, info: log, warn: log, error: log } }
    vm.createContext(ctx, { codeGeneration: { strings: false, wasm: false } })
    G = vm.runInContext('globalThis', ctx)
    // 隐藏 Node vm 自带的、真实 APP 里不存在的全局
    for (const k of ['fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'Buffer']) {
      try { delete G[k] } catch {}
    }

    G.__lx_native_call__ = (key, action, dataStr) => {
      if (key !== KEY) return
      const data = dataStr == null ? null : JSON.parse(dataStr)
      switch (action) {
        case 'init':
          if (data.status) { inited = true; sources = (data.info && data.info.sources) || {}; done() }
          else fail(data.errorMessage || 'init failed')
          break
        case 'request':
          hostHttp(data.url, data.options, { normalizeJson }).then(
            response => callJS('response', { requestKey: data.requestKey, error: null, response }),
            err => callJS('response', { requestKey: data.requestKey, error: err && err.message || String(err), response: null }))
          break
        case 'cancelRequest': break
        case 'response': {
          const p = pending.get(data.requestKey)
          if (!p) break
          pending.delete(data.requestKey)
          if (data.status) p.resolve(data.result)
          else p.reject(new Error(data.errorMessage || 'failed'))
          break
        }
        case 'showUpdateAlert': break
      }
    }
    G.__lx_native_call__set_timeout = (id, ms) => { timers.set(id, setTimeout(() => { timers.delete(id); callJS('__set_timeout__', id) }, ms)) }
    G.__lx_native_call__clear_timeout = id => { clearTimeout(timers.get(id)); timers.delete(id) }
    G.__lx_native_call__utils_str2b64 = nativeUtils.str2b64
    G.__lx_native_call__utils_b642buf = nativeUtils.b642buf
    G.__lx_native_call__utils_str2md5 = nativeUtils.str2md5
    G.__lx_native_call__utils_aes_encrypt = nativeUtils.aesEncrypt
    G.__lx_native_call__utils_rsa_encrypt = nativeUtils.rsaEncrypt

    let reqSeq = 0
    function handler(req) {
      return new Promise((res, rej) => {
        const requestKey = 'r' + (++reqSeq)
        pending.set(requestKey, {
          resolve: r => res(r && r.action === 'musicUrl' ? r.data && r.data.url : r && r.data),
          reject: rej,
        })
        callJS('request', { requestKey, data: req })
      })
    }

    try {
      vm.runInContext(PRELOAD, ctx)
      G.lx_setup(KEY, 'id', name, '', '', '', '', code)
    } catch (e) { fail('preload: ' + (e && e.message)) }
    try {
      vm.runInContext(code, ctx, { timeout: 10000 })
    } catch (e) {
      logs.push('LOAD_ERROR: ' + (e && e.message))
      try { callJS('__run_error__') } catch {}
      fail(e && e.message || e)
    }
    setTimeout(done, waitInit)
  })
}

module.exports = { loadSource, hostHttp }
