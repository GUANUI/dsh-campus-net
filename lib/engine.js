import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { LOG_PATH, PID_PATH, STATE_PATH, STOP_PATH, ensureHome } from './paths.js'
import { loadConfig } from './config.js'
import { loadCred } from './creds.js'
import { accountCandidates, portalSession, tryLogin } from './portal.js'
import { ensureWifi, probe, sleep, waitFor, wifiStatus } from './network.js'

const MAX_LOG_BYTES = 512 * 1024

export function logLine(message) {
  const line = '[' + new Date().toISOString() + '] ' + message
  try {
    ensureHome()
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1')
    }
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8')
  } catch {
    // 日志失败不影响认证
  }
  return line
}

export function readTail(lines = 40) {
  try {
    if (!fs.existsSync(LOG_PATH)) return []
    const content = fs.readFileSync(LOG_PATH, 'utf8')
    return content.replace(/\r/g, '').split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

export function writeState(patch) {
  ensureHome()
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() }
  const tmp = STATE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, STATE_PATH)
  return next
}

/** 探测端口是否被占用：被占用说明已有守护在跑。 */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 引擎：一次 check（探测→连 Wi-Fi→登录→复验）加一个循环。
 * 插件进程里和独立守护进程里跑的是同一份逻辑。
 */
export function createEngine(options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  let stopped = false
  let timer = null
  let running = false

  function emit(type, payload) {
    try {
      onEvent({ type, at: new Date().toISOString(), ...payload })
    } catch {
      // 监听方异常不能拖垮循环
    }
  }

  async function checkOnce() {
    const cfg = loadConfig()
    const startedAt = Date.now()
    const online = await probe(cfg)
    const wifi = await wifiStatus()
    let action = 'none'
    let message = online.detail

    if (online.online) {
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: true,
        lastError: '',
        wifiSsid: wifi.ssid || '',
        lastCheckMs: Date.now() - startedAt,
      })
      emit('online', { message })
      return { online: true, action, message, wifi, checks: readState().checks }
    }

    if (!cfg.autoConnectWhenOffline) {
      writeState({ lastCheck: new Date().toISOString(), lastOnline: false, lastError: online.detail })
      emit('offline', { message })
      return { online: false, action, message, wifi }
    }

    const wifiResult = await ensureWifi(cfg, (line) => logLine(line))
    if (!wifiResult.ok && !wifiResult.skipped) {
      action = 'wifi'
      message = wifiResult.message
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: false,
        lastError: message,
        lastAction: action,
        lastActionAt: new Date().toISOString(),
      })
      emit('wifi-failed', { message })
      return { online: false, action, message, wifi }
    }

    const cred = await loadCred()
    if (!cred) {
      action = 'no-cred'
      message = '没有保存账号密码，请先在设置页配置'
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: false,
        lastError: message,
        lastAction: action,
        lastActionAt: new Date().toISOString(),
      })
      emit('no-cred', { message })
      return { online: false, action, message, wifi }
    }

    const previous = readState()
    const accounts = accountCandidates(cfg, cred.username, previous.currentUsername)
    const login = await tryLogin(cfg, accounts, cred.password, previous.currentUsername)
    action = login.ok ? 'login' : 'login-failed'
    if (login.ok) {
      const verified = await waitFor(async () => (await probe(cfg, 4000)).online, Math.max(4, cfg.verifyWaitSeconds))
      const after = readState()
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: verified,
        lastError: verified ? '' : '登录接口返回成功，但复验仍不在线',
        lastAction: 'login',
        lastActionAt: new Date().toISOString(),
        currentUsername: login.username,
        checks: Number(after.checks || 0) + 1,
        logins: Number(after.logins || 0) + 1,
        wifiSsid: wifi.ssid || '',
      })
      message = verified ? '登录成功（' + login.username + '）' : '登录返回成功但复验失败'
      logLine(message + (login.message ? '：' + login.message : ''))
      emit(verified ? 'login' : 'login-unverified', { message, username: login.username })
      return { online: verified, action, message, username: login.username, wifi }
    }

    const after = readState()
    message = login.message || '认证失败'
    writeState({
      lastCheck: new Date().toISOString(),
      lastOnline: false,
      lastError: message,
      lastAction: action,
      lastActionAt: new Date().toISOString(),
      checks: Number(after.checks || 0) + 1,
      lastUsername: login.username || '',
    })
    logLine('认证失败：' + message)
    emit('login-failed', { message, username: login.username })
    return { online: false, action, message, username: login.username, wifi }
  }

  async function loop() {
    if (running) return
    running = true
    logLine('校园网守护启动（pid ' + process.pid + '）')
    writeState({ running: true, pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() })
    let failures = 0
    while (!stopped) {
      if (fs.existsSync(STOP_PATH)) {
        logLine('收到停止标记，守护退出')
        break
      }
      let cfg = loadConfig()
      let result
      try {
        result = await checkOnce()
        failures = result.online || result.action === 'none' ? 0 : failures + 1
      } catch (error) {
        failures += 1
        logLine('检查异常：' + (error && error.message ? error.message : String(error)))
        emit('error', { message: String(error && error.message ? error.message : error) })
      }
      const interval = Math.max(5, loadConfig().intervalSeconds)
      const backoff = Math.min(300, interval * Math.pow(2, Math.min(failures, 5)))
      const waitMs = (result && result.online ? interval : failures > 1 ? backoff : interval) * 1000
      timer = setTimeout(() => {}, waitMs)
      await sleep(waitMs)
    }
    running = false
    writeState({ running: false, stoppedAt: new Date().toISOString() })
    logLine('校园网守护停止')
  }

  function start() {
    stopped = false
    try {
      fs.rmSync(STOP_PATH, { force: true })
    } catch {
      // 忽略
    }
    loop()
    return { started: true }
  }

  function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
    return { stopped: true }
  }

  return {
    start,
    stop,
    checkOnce,
    isRunning: () => running,
  }
}

/** 供工具调用的一次性登录（不起循环）。 */
export async function loginOnce() {
  const cfg = loadConfig()
  const cred = await loadCred()
  if (!cred) return { ok: false, message: '没有保存账号密码，请先在设置页配置' }
  const wifi = await ensureWifi(cfg, (line) => logLine(line))
  if (!wifi.ok && !wifi.skipped) return { ok: false, message: wifi.message }
  const state = readState()
  const accounts = accountCandidates(cfg, cred.username, state.currentUsername)
  const result = await tryLogin(cfg, accounts, cred.password, state.currentUsername)
  if (result.ok) {
    writeState({ currentUsername: result.username, lastLoginAt: new Date().toISOString(), lastOnline: true, lastError: '' })
    logLine('手动登录成功：' + result.username)
    return { ok: true, username: result.username, message: '登录成功' }
  }
  writeState({ lastError: result.message })
  logLine('手动登录失败：' + result.message)
  return { ok: false, message: result.message }
}

export async function overview() {
  const cfg = loadConfig()
  const state = readState()
  const online = await probe(cfg, 4000)
  const wifi = await wifiStatus()
  const session = online.online ? { reachable: true, rows: [] } : await portalSession(cfg)
  return {
    online: online.online,
    probe: online,
    wifi,
    state,
    portalReachable: session.reachable,
    config: {
      preset: cfg.preset,
      portal: cfg.portal,
      ssids: cfg.ssids,
      intervalSeconds: cfg.intervalSeconds,
      auth: cfg.auth,
      usernames: cfg.usernames,
    },
  }
}
