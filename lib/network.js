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
  if (result.code !== 0) return { supported: false, ssid: '', state: '', error: result.stderr.trim() }
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

/** 依次尝试主 SSID 和备用 SSID，连上任意一个即可。 */
export async function ensureWifi(cfg, log = () => {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, message: '非 Windows，跳过 Wi-Fi 步骤' }
  const current = await wifiStatus()
  if (current.supported && current.ssid && current.state && !/断开|disconnected/i.test(current.state)) {
    const known = [...(cfg.ssids || []), ...(cfg.fallbackSsids || [])]
    if (!known.length || known.includes(current.ssid)) {
      return { ok: true, ssid: current.ssid, message: '已连接 ' + current.ssid }
    }
  }
  const targets = [...new Set([...(cfg.ssids || []), ...(cfg.fallbackSsids || [])])]
  for (const ssid of targets) {
    log('尝试连接 Wi-Fi：' + ssid)
    const result = await connectWifi(ssid)
    if (!result.ok) {
      log('连接 ' + ssid + ' 失败：' + result.message)
      continue
    }
    const connected = await waitFor(async () => {
      const status = await wifiStatus()
      return status.supported && status.ssid === ssid && !/断开|disconnected/i.test(status.state || '')
    }, Math.max(5, cfg.connectWaitSeconds))
    if (connected) return { ok: true, ssid, message: '已连接 ' + ssid }
  }
  return { ok: false, message: '没有连上任何已知校园 Wi-Fi' }
}
