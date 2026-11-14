import crypto from 'node:crypto'
import { requestJson } from './http.js'

/**
 * 门户适配层。
 *
 * 通用 “POST JSON + reply_code” 流程：reply_code === 0 表示成功；
 * 门户地址、接口路径、字段名和成功码都由用户在设置页配置。
 * 深澜 / Dr.COM 这类完全不同的协议不在本插件的承诺范围内。
 */

function bases(cfg) {
  const list = [{ url: cfg.portal, hostHeader: undefined }]
  const fallback = cfg.portalIpFallback || {}
  if (fallback.ip) {
    list.push({
      url: 'http://' + String(fallback.ip).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      hostHeader: fallback.host || undefined,
    })
  }
  return list
}

function replyDetail(data) {
  const results = data && typeof data === 'object' ? data.results : null
  return results && typeof results === 'object' && !Array.isArray(results) ? results : {}
}

function replyMessage(data) {
  const detail = replyDetail(data)
  return String(detail.io_reply_msg || (data && data.reply_msg) || '')
}

function replyCode(data) {
  if (!data || typeof data !== 'object') return null
  const value = data.reply_code
  if (value === undefined || value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

async function call(cfg, pathKey, payload, timeoutMs) {
  let lastError = null
  for (const base of bases(cfg)) {
    const url = base.url + cfg.paths[pathKey]
    try {
      const { status, data, text } = await requestJson(url, {
        method: payload === undefined ? 'GET' : 'POST',
        body: payload === undefined ? undefined : JSON.stringify(payload),
        timeoutMs: timeoutMs || 8000,
        hostHeader: base.hostHeader,
      })
      if (data === null) {
        return {
          status,
          data: { reply_code: -1, reply_msg: '非 JSON 响应（HTTP ' + status + '）：' + String(text || '').slice(0, 120) },
        }
      }
      return { status, data }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('门户不可达')
}

function loginPayload(cfg, username, password, challenge) {
  const fields = cfg.fields || {}
  const payload = {}
  payload[fields.domain || 'domain'] = cfg.domain
  payload[fields.username || 'username'] = username
  payload[fields.password || 'password'] = password
  if (challenge) payload.challenge = challenge
  return payload
}

export async function portalSession(cfg) {
  try {
    const { data } = await call(cfg, 'session', undefined, 6000)
    if (replyCode(data) === Number(cfg.successCode)) {
      const results = data && data.results
      const rows = results && Array.isArray(results.rows) ? results.rows : []
      return { reachable: true, rows }
    }
    return { reachable: true, rows: [] }
  } catch {
    return { reachable: false, rows: [] }
  }
}

export async function portalLogin(cfg, username, password) {
  const payload = loginPayload(cfg, username, password)
  const { data } = await call(cfg, 'login', payload, 12000)
  return data
}

export async function portalChapLogin(cfg, username, password) {
  const { data: challengeData } = await call(cfg, 'challenge', undefined, 8000)
  const raw = challengeData && typeof challengeData === 'object' ? challengeData.results : ''
  const challenge = typeof raw === 'string' ? raw.trim() : ''
  if (!challenge || challenge.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(challenge)) {
    return { reply_code: -1, reply_msg: '取不到 challenge，无法走 CHAP' }
  }
  const ident = crypto.randomInt(0, 256)
  const digest = crypto
    .createHash('md5')
    .update(Buffer.concat([Buffer.from([ident]), Buffer.from(password, 'utf8'), Buffer.from(challenge, 'hex')]))
    .digest('hex')
  const { data } = await call(
    cfg,
    'login',
    loginPayload(cfg, username, String(ident.toString(16)).padStart(2, '0') + digest, challenge),
    12000,
  )
  return data
}

export async function portalLogout(cfg) {
  try {
    const payload = {}
    payload[cfg.fields?.domain || 'domain'] = cfg.domain
    await call(cfg, 'logout', payload, 5000)
    return true
  } catch {
    return false
  }
}

export function accountCandidates(cfg, credUsername, remembered) {
  const names = []
  const push = (name) => {
    const value = String(name || '').trim()
    if (value && !names.includes(value)) names.push(value)
  }
  if (remembered) push(remembered)
  if (credUsername) push(credUsername)
  for (const name of cfg.usernames || []) push(name)
  return names
}

/**
 * 按候选账号依次登录。
 * 只有门户明确说“账号不存在”才换下一个；密码错误绝不重试，避免把账号试锁。
 */
export async function tryLogin(cfg, accounts, password, remembered) {
  let lastUser = ''
  let lastMessage = ''
  const successCode = Number(cfg.successCode)
  for (const name of accounts) {
    let data = await safeCall(portalLogin, cfg, name, password)

    if (replyCode(data) !== successCode && cfg.auth !== 'json') {
      data = await safeCall(portalChapLogin, cfg, name, password)
    }

    const message = replyMessage(data)
    if (replyCode(data) === successCode) {
      return { ok: true, username: name, message: '' }
    }

    if (['E013', 'E002', 'E028'].includes(message.slice(0, 4))) {
      // 账号在手机等设备上在线：下线本机会话后重登一次
      await portalLogout(cfg)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      data = await safeCall(portalLogin, cfg, name, password)
      if (replyCode(data) === successCode) {
        return { ok: true, username: name, message: '已下线其他设备并重新登录' }
      }
    }

    lastUser = name
    lastMessage = replyMessage(data) || 'reply_code=' + replyCode(data)
    const detail = replyDetail(data)
    const unknownUser =
      [12, 27].includes(Number(detail.io_reply_code)) || ['E012', 'E027'].includes(lastMessage.slice(0, 4))
    if (!unknownUser) break
  }
  return { ok: false, username: lastUser, message: lastMessage || '认证失败' }
}

async function safeCall(fn, ...args) {
  try {
    return await fn(...args)
  } catch (error) {
    return { reply_code: -1, reply_msg: '请求异常：' + (error && error.message ? error.message : String(error)) }
  }
}
