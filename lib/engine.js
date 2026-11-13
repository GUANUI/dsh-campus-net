import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { LOG_PATH, PID_PATH, STATE_PATH, STOP_PATH, ensureHome } from './paths.js'
import { loadConfig } from './config.js'
import { loadCred } from './creds.js'
import { accountCandidates, portalSession, tryLogin } from './portal.js'
import { connectWifi, ensureWifi, isPaidSsid, probe, scanWifi, setPaidProfilesManual, sleep, waitFor, wifiStatus } from './network.js'

const MAX_LOG_BYTES = 512 * 1024
// 在非校园网络上尝试切回校园网的最小间隔：避免每 10 秒重连一次，把用户正在用的网络打断。
const SWITCH_RETRY_MS = 5 * 60 * 1000
// 附近校园网信号低于这个值就不切：连过去大概率也不可用，反而把用户断网。
const MIN_SWITCH_SIGNAL = 40
let lastSwitchAttempt = 0

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

  /** 配置里的免费校园网列表（收费网络永远不在里面）。 */
  function campusTargets(cfg) {
    return [...new Set([...(cfg.ssids || []), ...(cfg.fallbackSsids || [])])].filter((ssid) => !isPaidSsid(ssid))
  }

  /**
   * 连上 Wi-Fi 之后的认证：读凭据 → 登录 → 复验 → 落状态。
   * 断网重连和“从热点/收费网切回校园网”都复用它。
   */
  async function authorize(cfg, wifi) {
    const cred = await loadCred()
    if (!cred) {
      const message = '没有保存账号密码，请先在设置页配置'
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: false,
        lastError: message,
        lastAction: 'no-cred',
        lastActionAt: new Date().toISOString(),
      })
      emit('no-cred', { message })
      return { online: false, action: 'no-cred', message, wifi }
    }

    const previous = readState()
    const accounts = accountCandidates(cfg, cred.username, previous.currentUsername)
    const login = await tryLogin(cfg, accounts, cred.password, previous.currentUsername)
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
      const message = verified ? '登录成功（' + login.username + '）' : '登录返回成功但复验失败'
      logLine(message + (login.message ? '：' + login.message : ''))
      emit(verified ? 'login' : 'login-unverified', { message, username: login.username })
      return { online: verified, action: 'login', message, username: login.username, wifi }
    }

    const after = readState()
    const message = login.message || '认证失败'
    writeState({
      lastCheck: new Date().toISOString(),
      lastOnline: false,
      lastError: message,
      lastAction: 'login-failed',
      lastActionAt: new Date().toISOString(),
      checks: Number(after.checks || 0) + 1,
      lastUsername: login.username || '',
    })
    logLine('认证失败：' + message)
    emit('login-failed', { message, username: login.username })
    return { online: false, action: 'login-failed', message, username: login.username, wifi }
  }

  async function checkOnce() {
    const cfg = loadConfig()
    const startedAt = Date.now()
    const online = await probe(cfg)
    const wifi = await wifiStatus()
    let action = 'none'
    let message = online.detail

    if (online.online) {
      // 连着任何“非校园网”的网络（手机热点、家里路由器、运营商收费网）都算“有网但不是校园网”。
      // 只要扫描确认免费校园网就在附近、信号也够用，就试着切回去；切过去不通就切回原来的网络，
      // 不把用户晾在断网状态。
      const targets = campusTargets(cfg)
      const onCampus = Boolean(wifi.ssid) && targets.includes(wifi.ssid)
      if (cfg.preferCampusOverPaid && wifi.ssid && !onCampus && targets.length) {
        const scan = await scanWifi()
        const visibleNow = scan.supported ? new Set(scan.networks.map((network) => network.ssid)) : null
        const nearby = scan.supported
          ? scan.networks.filter((network) => targets.includes(network.ssid) && Number(network.signal) >= MIN_SWITCH_SIGNAL)
          : []
        if (!nearby.length) {
          writeState({
            lastCheck: new Date().toISOString(),
            lastOnline: true,
            lastError: '',
            wifiSsid: wifi.ssid,
            lastCheckMs: Date.now() - startedAt,
            wifiNote: '附近没有信号够用的免费校园网，保持当前网络',
          })
          emit('online', { message })
          return { online: true, action, message: '附近没有免费校园网，保持 ' + wifi.ssid, wifi }
        }
        if (Date.now() - lastSwitchAttempt >= SWITCH_RETRY_MS) {
          lastSwitchAttempt = Date.now()
          const previousSsid = wifi.ssid
          logLine(
            '当前在 ' + previousSsid + ' 上，附近有 ' +
              nearby.map((network) => network.ssid + ' ' + network.signal + '%').join('、') + '，尝试切回校园网',
          )
          const switched = await ensureWifi(cfg, (line) => logLine(line), { visible: visibleNow })
          if (switched.ok && switched.ssid && !isPaidSsid(switched.ssid)) {
            const afterWifi = await wifiStatus()
            const result = (await probe(cfg, 4000)).online
              ? { online: true, action: 'wifi', message: '已切到 ' + switched.ssid }
              : await authorize(cfg, afterWifi)
            if (result.online) {
              const after = readState()
              writeState({
                lastCheck: new Date().toISOString(),
                lastOnline: true,
                lastError: '',
                wifiSsid: switched.ssid,
                wifiNote: '',
                lastAction: 'wifi',
                lastActionAt: new Date().toISOString(),
                checks: Number(after.checks || 0) + 1,
              })
              message = '已从 ' + previousSsid + ' 切到 ' + switched.ssid + '：' + (result.message || '在线')
              logLine(message)
              emit('switched', { message })
              return { online: true, action: 'wifi', message, wifi: afterWifi }
            }
            // 切过去还是不通：把用户原来的网络接回来，别把人断网。
            logLine('切到 ' + switched.ssid + ' 后仍不通（' + (result.message || '未知') + '），切回 ' + previousSsid)
            await connectWifi(previousSsid)
          }
        }
      }
      writeState({
        lastCheck: new Date().toISOString(),
        lastOnline: true,
        lastError: '',
        wifiNote: '',
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

    // 断网时也先确认免费校园网真的在附近；看不到就安静等，避免盲连失败后 Windows 落到收费网络。
    const scanTargets = campusTargets(cfg)
    let visible = null
    if (scanTargets.length) {
      const scan = await scanWifi()
      if (scan.supported) visible = new Set(scan.networks.map((network) => network.ssid))
      const nearby = scan.supported && scan.networks.some((network) => scanTargets.includes(network.ssid))
      if (scan.supported && !nearby) {
        action = 'wifi'
        message = '免费校园网不在范围内，暂不连接'
        writeState({
          lastCheck: new Date().toISOString(),
          lastOnline: false,
          lastError: '',
          wifiNote: message,
          lastAction: action,
          lastActionAt: new Date().toISOString(),
        })
        emit('wifi-absent', { message })
        return { online: false, action, message, wifi }
      }
    }

    const wifiResult = await ensureWifi(cfg, (line) => logLine(line), { visible })
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

    return authorize(cfg, await wifiStatus())
  }

  async function loop() {
    if (running) return
    running = true
    logLine('校园网守护启动（pid ' + process.pid + '）')
    try {
      await setPaidProfilesManual(logLine)
    } catch {
      // 改不了也不影响登录，只是 Windows 可能自己落到收费网络
    }
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
    profile: { id: cfg.id, name: cfg.name },
    config: {
      preset: cfg.preset,
      portal: cfg.portal,
      ssids: cfg.ssids,
      intervalSeconds: cfg.intervalSeconds,
      auth: cfg.auth,
      usernames: cfg.usernames,
      preferCampusOverPaid: cfg.preferCampusOverPaid,
    },
  }
}
