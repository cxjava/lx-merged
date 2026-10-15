// 模拟落雪 (LX Music) 自定义源运行环境
const vm = require('vm')
const crypto = require('crypto')
const zlib = require('zlib')

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

function lxRequest(url, opts = {}, cb) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000)
  let body = opts.body
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString()
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) }
  } else if (body && typeof body === 'object' && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body)
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }
  fetch(url, { method: (opts.method || 'GET').toUpperCase(), headers: opts.headers, body, signal: ctrl.signal, redirect: 'follow' })
    .then(async r => {
      const buf = Buffer.from(await r.arrayBuffer())
      let b = buf.toString('utf8')
      try { b = JSON.parse(b) } catch {}
      if (opts.binary) b = buf
      clearTimeout(timer)
      cb && cb(null, { statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers), body: b, raw: buf }, b)
    })
    .catch(e => { clearTimeout(timer); cb && cb(e, null, null) })
  return () => ctrl.abort()
}

const utils = {
  buffer: {
    from: (d, enc) => Buffer.from(d, enc),
    bufToString: (b, fmt) => Buffer.from(b).toString(fmt),
  },
  crypto: {
    md5: s => crypto.createHash('md5').update(s).digest('hex'),
    randomBytes: n => crypto.randomBytes(n),
    aesEncrypt: (buf, mode, key, iv) => {
      const c = crypto.createCipheriv(mode, key, iv || null)
      return Buffer.concat([c.update(buf), c.final()])
    },
    rsaEncrypt: (buf, key) => {
      buf = Buffer.concat([Buffer.alloc(128 - buf.length), buf])
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buf)
    },
  },
  zlib: {
    inflate: async b => zlib.inflateSync(b),
    deflate: async b => zlib.deflateSync(b),
  },
}

// 移动版 lx.utils 只有部分实现
const mobileUtils = {
  buffer: {
    from: (d, enc) => {
      if (typeof d === 'string' && enc && !['base64', 'hex', 'utf8', 'utf-8'].includes(enc)) throw new Error('Unsupported encoding: ' + enc)
      return Buffer.from(d, enc)
    },
    bufToString: (b, fmt) => {
      if (fmt && !['base64', 'hex', 'utf8', 'utf-8'].includes(fmt)) throw new Error('Unsupported format: ' + fmt)
      return Buffer.from(b).toString(fmt)
    },
  },
  crypto: {
    md5: utils.crypto.md5,
    randomBytes: utils.crypto.randomBytes,
    rsaEncrypt: utils.crypto.rsaEncrypt,
    aesEncrypt: (buf, mode, key, iv) => {
      if (!['aes-128-cbc', 'aes-128-ecb'].includes(mode)) throw new Error('Unsupported aes mode: ' + mode)
      return utils.crypto.aesEncrypt(buf, mode, key, iv)
    },
  },
  zlib: {
    inflate: () => Promise.reject(new Error('zlib is not implemented on mobile')),
    deflate: () => Promise.reject(new Error('zlib is not implemented on mobile')),
  },
}

/**
 * 在沙箱里加载一个音源脚本，返回 { handler, sources, initError, logs }
 * mode = 'desktop'：模拟 lx-music-desktop（Electron 渲染进程）
 *   - lx 由 contextBridge 注入：只读、不可配置
 *   - user-api.html 有 CSP default-src 'none'：fetch/XHR 被拦截、eval/new Function 被禁止
 *   - 原生函数用错 this 会 Illegal invocation
 * mode = 'mobile'：模拟 lx-music-mobile（轻量 JS 引擎）
 *   - 只有 setTimeout / clearTimeout，无 fetch/URL/atob/btoa/TextEncoder/AbortController/setInterval 等
 *   - lx 冻结，globalThis 已有属性全部只读不可配置，eval/Function 禁止
 *   - lx.utils 部分实现（zlib 不可用，aes 仅 128 cbc/ecb）
 * 两种模式下：inited 之前的任何未捕获错误都视为初始化失败
 */
function loadSource(code, { waitInit = 5000, mode = 'desktop' } = {}) {
  const mobile = mode === 'mobile'
  return new Promise((resolve) => {
    const logs = []
    const state = { handler: null, sources: null }
    let isInited = false
    const lx = {
      version: '2.0.0',
      env: mobile ? 'mobile' : 'desktop',
      currentScriptInfo: { name: 'test', description: '', version: '', author: '', homepage: '', rawScript: code },
      EVENT_NAMES,
      request: lxRequest,
      on: (ev, fn) => {
        if (ev !== EVENT_NAMES.request) return Promise.reject(new Error('The event is not supported: ' + ev))
        state.handler = fn
        return Promise.resolve()
      },
      send: (ev, data) => new Promise((resolve, reject) => {
        if (ev === EVENT_NAMES.inited) {
          if (isInited) return reject(new Error('Script is inited'))
          isInited = true
          state.sources = (data && data.sources) || {}
          resolve(); done()
        } else if (ev === EVENT_NAMES.updateAlert) resolve()
        else reject(new Error('Unknown event name: ' + ev))
      }),
      utils: mobile ? mobileUtils : utils,
    }
    const onError = (msg) => {
      if (isInited) return
      isInited = true
      state.initError = String(msg)
      logs.push('INIT_ERROR: ' + msg)
      done()
    }
    const onRejection = (reason) => onError(reason && reason.message || reason)
    process.on('unhandledRejection', onRejection)
    const log = (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })())).join(' '))
    const fakeConsole = { log, info: log, warn: log, error: log, debug: log, group: log, groupEnd: () => {}, time: () => {}, timeEnd: () => {}, table: log, trace: log }

    const blockedFetch = () => Promise.reject(new TypeError("Failed to fetch (Refused to connect: Content Security Policy default-src 'none')"))
    function BlockedXHR() { throw new Error("XMLHttpRequest blocked by Content Security Policy default-src 'none'") }
    const ctx = mobile
      ? { console: fakeConsole, setTimeout, clearTimeout }
      : { console: fakeConsole, setTimeout, clearTimeout, setInterval, clearInterval,
          fetch: blockedFetch, XMLHttpRequest: BlockedXHR,
          URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, AbortController }
    // eval / new Function 被禁止（桌面 CSP，移动端 preload 主动禁用）
    vm.createContext(ctx, { codeGeneration: { strings: false, wasm: false } })
    const G = vm.runInContext('globalThis', ctx)
    Object.defineProperty(G, 'lx', { value: Object.freeze(lx), writable: false, configurable: false, enumerable: true })
    if (!mobile) {
      vm.runInContext('var window = globalThis, self = globalThis', ctx)
      for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'atob', 'btoa']) {
        const fn = ctx[k]
        G[k] = function (...a) {
          if (this !== undefined && this !== G && this !== ctx && this !== globalThis) throw new TypeError("Failed to execute '" + k + "' on 'Window': Illegal invocation")
          return fn.apply(globalThis, a)
        }
      }
    } else {
      // 照搬移动版 preload：深度冻结 lx，globalThis 上已有属性全部只读不可配置
      vm.runInContext(`(() => {
        const freezeObject = (obj) => { if (typeof obj != 'object' || obj === null) return; Object.freeze(obj); for (const v of Object.values(obj)) freezeObject(v) }
        try { freezeObject(globalThis.lx) } catch (e) {}
        const excludes = [Function.prototype.toString, Function.prototype.toLocaleString, Object.prototype.toString]
        const freezeObjectProperty = (obj, seen = new Set()) => {
          if (obj == null) return
          if (typeof obj !== 'object' && typeof obj !== 'function') return
          if (seen.has(obj)) return
          seen.add(obj)
          for (const [name, { ...config }] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
            if (!excludes.includes(config.value)) {
              if (config.writable) config.writable = false
              if (config.configurable) config.configurable = false
              try { Object.defineProperty(obj, name, config) } catch (e) {}
            }
            freezeObjectProperty(config.value, seen)
          }
        }
        freezeObjectProperty(globalThis)
      })()`, ctx)
    }
    let finished = false
    function done() {
      if (finished) return
      finished = true
      setTimeout(() => process.off('unhandledRejection', onRejection), 3000)
      resolve({ handler: state.handler, sources: state.sources, initError: state.initError, logs })
    }
    try {
      vm.runInContext(code, ctx, { timeout: 10000 })
    } catch (e) {
      logs.push('LOAD_ERROR: ' + (e && e.stack || e))
      onError(e && e.message || e)
    }
    setTimeout(done, waitInit)
  })
}

module.exports = { loadSource, lxRequest }
