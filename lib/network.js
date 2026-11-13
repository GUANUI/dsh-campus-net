import { spawn } from 'node:child_process'
import { request } from './http.js'

/**
 * 网络层：探测在线状态、连 Wi-Fi。
 *
 * 在线判定与旧脚本一致：只有 HTTP 204 才算在线。
 * 很多校园网关对任何 HTTP 请求都返回 200 的登录页，所以不能用 200 当在线。
 */

function run(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export async function probe(cfg, timeoutMs = 6000) {
  try {
    const response = await request(cfg.onlineProbe, { timeoutMs, followRedirects: 0 })
    const ok = response.status === Number(cfg.onlineStatus)
    return {
      online: ok,
      status: response.status,
      detail: ok ? '在线' : 'HTTP ' + response.status + '（被重定向到认证页或代理拦截）',
    }
  } catch (error) {
    return { online: false, status: 0, detail: '探测失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 读取当前无线连接（仅在 Windows 上有意义）。 */
export async function wifiStatus() {
  if (process.platform !== 'win32') return { supported: false, ssid: '', state: '' }
  const result = await run('netsh', ['wlan', 'show', 'interfaces'])
  const raw = (result.stdout || '') + (result.stderr || '')
  // Windows 11：读取 Wi-Fi 名称需要“位置”权限；没开时 netsh 直接拒绝，但连接命令仍然可用。
  if (/位置权限|location permission/i.test(raw)) {
    return { supported: true, restricted: true, ssid: '', state: '', error: 'location' }
  }
  if (result.code !== 0) return { supported: false, ssid: '', state: '', error: (result.stderr || '').trim() }
  const text = result.stdout.replace(/\r/g, '')
  const ssid = (text.match(/^\s*SSID\s*:\s*(.+)$/m) || [])[1] || ''
  const state = (text.match(/^\s*(?:State|状态)\s*:\s*(.+)$/m) || [])[1] || ''
  return { supported: true, ssid: ssid.trim(), state: state.trim() }
}

export async function connectWifi(ssid, timeoutMs = 15000) {
  if (process.platform !== 'win32') return { ok: false, message: '当前平台不支持自动连 Wi-Fi' }
  const result = await run('netsh', ['wlan', 'connect', 'name=' + ssid], timeoutMs)
  const output = (result.stdout + result.stderr).replace(/\r/g, '').trim()
  const ok = result.code === 0 && !/not found|找不到|没有|失败/i.test(output)
  return { ok, message: output.slice(0, 300) || (ok ? '已请求连接' : '连接失败') }
}

/** 扫描附近可见的无线网络（Windows）。返回去重后的 SSID 列表。 */
export async function scanWifi() {
  if (process.platform !== 'win32') return { supported: false, networks: [] }
  const result = await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], 20000)
  const raw = (result.stdout || '') + (result.stderr || '')
  if (result.code !== 0) {
    if (/位置权限|location permission/i.test(raw)) return { supported: false, reason: 'location', networks: [] }
    return { supported: false, reason: 'error', networks: [], error: raw.trim().slice(0, 300) }
  }
  const text = result.stdout.replace(/\r/g, '')
  const networks = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const head = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/)
    if (head) {
      const ssid = head[1].trim()
      if (!ssid) continue
      if (!networks.has(ssid)) networks.set(ssid, { ssid, signal: 0, auth: '', paid: isPaidSsid(ssid) })
      current = networks.get(ssid)
      continue
    }
    if (!current) continue
    const signal = line.match(/(?:Signal|信号)\s*:\s*(\d+)\s*%/i)
    if (signal) current.signal = Math.max(current.signal, Number(signal[1]))
    const auth = line.match(/(?:Authentication|身份验证)\s*:\s*(.+)$/)
    if (auth && !current.auth) current.auth = auth[1].trim()
  }
  const list = [...networks.values()].sort((a, b) => b.signal - a.signal)
  return { supported: true, networks: list }
}

/** 本机保存过的 Wi-Fi 配置（不需要位置权限）。扫描不可用时给用户做候选。 */
export async function savedWifiProfiles() {
  if (process.platform !== 'win32') return []
  const result = await run('netsh', ['wlan', 'show', 'profiles'], 15000)
  if (result.code !== 0) return []
  const names = []
  for (const line of result.stdout.replace(/\r/g, '').split('\n')) {
    const match = line.match(/^\s*(?:All User Profile|所有用户配置文件)\s*:\s*(.+)$/)
    if (match && match[1].trim()) names.push(match[1].trim())
  }
  return [...new Set(names)]
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询直到 predicate 为真或超时；返回是否等到。 */
export async function waitFor(predicate, timeoutSeconds, intervalMs = 2000) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

/** 把保存过的 cmcc / unicom 改成“手动连接”：校园网连不上时 Windows 不会自己落到这两个网络上。
 *  chinanet 是用户可能自己买来用的，不动它。 */
export async function setPaidProfilesManual(log = () => {}) {
  if (process.platform !== 'win32') return { changed: [], failed: [] }
  const profiles = (await savedWifiProfiles()).filter((name) => /cmcc|unicom/i.test(name))
  const changed = []
  const failed = []
  for (const name of profiles) {
    const result = await run('netsh', ['wlan', 'set', 'profileparameter', 'name=' + name, 'connectionmode=manual'], 15000)
    if (result.code === 0) changed.push(name)
    else failed.push({ name, message: String(result.stdout || result.stderr || '').trim() })
  }
  if (changed.length) log('已把收费网络改为手动连接：' + changed.join('、'))
  return { changed, failed }
}

/** 运营商收费网络：chinanet / cmcc / unicom。绝不自动连接，避免产生费用。 */
const PAID_SSID_PATTERN = /chinanet|cmcc|unicom/i

export function isPaidSsid(ssid) {
  return PAID_SSID_PATTERN.test(String(ssid || ''))
}

/** 依次尝试主 SSID 和备用 SSID，连上任意一个即可。
 *  options.visible 是调用方已经扫描到的 SSID 集合：传了它就只连“确实看得到”的网络，
 *  避免对着不在范围内的 SSID 反复发起连接（Windows 会报“指定的网络无法用于连接”）。 */
export async function ensureWifi(cfg, log = () => {}, options = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, message: '非 Windows，跳过 Wi-Fi 步骤' }
  const current = await wifiStatus()
  const restricted = Boolean(current.restricted)
  if (restricted) log('Windows 位置权限未开，读不到当前 Wi-Fi；直接尝试连接配置的校园网')
  const connected = current.supported && current.ssid && current.state && !/断开|disconnected/i.test(current.state)
  if (connected && isPaidSsid(current.ssid)) {
    log('当前连接的是运营商收费网络 ' + current.ssid + '，不会在它上面自动登录')
  }
  if (connected && !isPaidSsid(current.ssid)) {
    const known = [...(cfg.ssids || []), ...(cfg.fallbackSsids || [])]
    if (!known.length || known.includes(current.ssid)) {
      return { ok: true, ssid: current.ssid, message: '已连接 ' + current.ssid }
    }
  }
  const configured = [...new Set([...(cfg.ssids || []), ...(cfg.fallbackSsids || [])])].filter((ssid) => !isPaidSsid(ssid))
  if (!configured.length) {
    return { ok: false, paid: connected, message: '没有配置免费校园 Wi-Fi（收费网络不会自动连接）' }
  }
  let visible = options.visible instanceof Set ? options.visible : null
  if (!visible) {
    const scan = await scanWifi()
    if (scan.supported) visible = new Set(scan.networks.map((network) => network.ssid))
  }
  const targets = visible ? configured.filter((ssid) => visible.has(ssid)) : configured
  if (!targets.length) {
    return { ok: false, paid: connected, message: '免费校园网不在范围内（扫描没看到 ' + configured.join(' / ') + '）' }
  }
  for (const ssid of targets) {
    log('尝试连接 Wi-Fi：' + ssid)
    const result = await connectWifi(ssid)
    if (!result.ok) {
      log('连接 ' + ssid + ' 失败：' + result.message)
      continue
    }
    if (restricted) {
      await sleep(2000)
      return { ok: true, ssid, message: '已请求连接 ' + ssid + '（读不到状态，靠在线探测确认）' }
    }
    const ok = await waitFor(async () => {
      const status = await wifiStatus()
      return status.supported && status.ssid === ssid && !/断开|disconnected/i.test(status.state || '')
    }, Math.max(5, cfg.connectWaitSeconds))
    if (ok) return { ok: true, ssid, message: '已连接 ' + ssid }
  }
  return { ok: false, paid: connected, message: '没有连上任何免费校园 Wi-Fi' }
}
