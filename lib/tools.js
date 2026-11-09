import { daemonStatus, installAutostart, removeAutostart, startDaemon, stopDaemon } from './daemon.js'
import { loginOnce, overview, readState, readTail } from './engine.js'
import { startSetupServer } from './setup-server.js'

/**
 * 四个工具：
 * - campus_net_status  看状态
 * - campus_net_login   现在登录一次
 * - campus_net_setup   打开本地设置页（配账号、门户、自启）
 * - campus_net_daemon  守护进程的安装/启停/日志
 *
 * 工具返回给模型的结构化值里不包含密码；日志也做了裁剪。
 */

function text(value) {
  return [{ type: 'text', text: value }]
}

function timeText(iso) {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

const statusSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    online: { type: 'boolean' },
    probe: { type: 'object', properties: { status: { type: 'integer' }, detail: { type: 'string' } }, additionalProperties: true },
    wifi: { type: 'object', properties: { ssid: { type: 'string' }, state: { type: 'string' } }, additionalProperties: true },
    daemon: { type: 'object', properties: { running: { type: 'boolean' }, pid: { type: 'integer' }, autostart: { type: 'boolean' } }, additionalProperties: true },
    state: { type: 'object', additionalProperties: true },
    message: { type: 'string' },
  },
  additionalProperties: true,
}

function statusText(value) {
  const daemon = value.daemon || {}
  const lines = [
    '校园网：' + (value.online ? '在线' : '离线') + '（' + (value.probe?.detail || '未探测') + '）',
    'Wi-Fi：' + (value.wifi?.ssid ? value.wifi.ssid + ' · ' + (value.wifi.state || '') : '未连接'),
    '守护：' + (daemon.running ? '运行中（PID ' + daemon.pid + '）' : '未运行') + (daemon.autostart ? '，已设开机自启' : ''),
    '当前账号：' + (value.state?.currentUsername || '未记录'),
    '最近动作：' + (value.state?.lastAction || '-') + ' · ' + timeText(value.state?.lastActionAt),
  ]
  if (value.state?.lastError) lines.push('最近错误：' + value.state.lastError)
  if (!daemon.running) lines.push('提示：守护没跑时，只有本工具或设置页手动登录；要让它在 DSH 关闭后也自动重连，执行 campus_net_daemon { action: "install" }。')
  return text(lines.join('\n'))
}

const loginSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    username: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
}

const setupSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    url: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
}

const daemonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    running: { type: 'boolean' },
    pid: { type: 'integer' },
    autostart: { type: 'boolean' },
    logs: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
}

export function buildCampusTools() {
  return [
    {
      name: 'campus_net_status',
      description:
        'Show campus network status: online/offline, Wi-Fi SSID, auto-login daemon state, last action and last error. ' +
        'Use quick: true to skip the live probe and read the cached state only. 中文：查看校园网是否在线、连的哪个 Wi-Fi、守护进程是否在跑、最近一次登录结果。',
      parameters: {
        type: 'object',
        properties: {
          quick: { type: 'boolean', description: 'Read cached state only, skip the live probe. 只用缓存状态，不现场探测（更快）。' },
        },
      },
      output: { schema: statusSchema, render: (_args, value) => statusText(value) },
      execute: async (args) => {
        const daemon = await daemonStatus()
        if (args && args.quick) {
          const state = readState()
          return {
            ok: true,
            online: Boolean(state.lastOnline),
            probe: { status: 0, detail: '缓存状态' },
            wifi: { ssid: state.wifiSsid || '', state: '' },
            daemon,
            state,
            message: 'cached',
          }
        }
        const info = await overview()
        return {
          ok: true,
          online: info.online,
          probe: { status: info.probe.status, detail: info.probe.detail },
          wifi: { ssid: info.wifi.ssid, state: info.wifi.state },
          daemon,
          state: info.state,
          message: info.online ? 'online' : 'offline',
        }
      },
    },
    {
      name: 'campus_net_login',
      description:
        'Log in to the campus portal right now using the saved credentials (tries the saved Wi-Fi first). ' +
        'Never retries a wrong password, so it will not lock the account. 中文：立刻用已保存的账号密码登录校园网，会先尝试连接校园 Wi-Fi；密码错误不会重试，避免锁号。',
      parameters: { type: 'object', properties: {} },
      output: { schema: loginSchema, render: (_args, value) => text(value.ok ? '登录成功' + (value.username ? '：' + value.username : '') + '。' : '登录失败：' + (value.message || '未知错误')) },
      execute: async () => loginOnce(),
    },
    {
      name: 'campus_net_setup',
      description:
        'Open the local settings page (127.0.0.1, token-protected) to set the account, portal, Wi-Fi SSID, interval and autostart. ' +
        'The page exists only while the plugin runs. 中文：打开本机设置页（只监听 127.0.0.1、带临时 token），用来填账号密码、门户、Wi-Fi 和自启；插件停止后页面失效。',
      parameters: { type: 'object', properties: {} },
      output: { schema: setupSchema, render: (_args, value) => text(value.ok ? '设置页已打开：' + value.url + '\n在这个页面里填账号密码、改门户、开自启。链接含临时 token，不要发给别人；DSH 重启后需重新打开。' : '打开失败：' + value.message) },
      execute: async () => {
        try {
          const server = startSetupServer()
          const info = await server.ready
          return { ok: true, url: info.url, message: 'settings page ready' }
        } catch (error) {
          return { ok: false, url: '', message: error && error.message ? error.message : String(error) }
        }
      },
    },
    {
      name: 'campus_net_daemon',
      description:
        'Manage the background auto-login daemon: status / start / stop / install (autostart + start) / uninstall (remove autostart + stop) / logs. ' +
        'The daemon is a separate process and keeps working after DSH closes; install is what makes it survive reboot. ' +
        '中文：管理后台自动登录守护：status/start/stop/install（开机自启并启动）/uninstall（取消自启并停止）/logs。守护是独立进程，DSH 关闭后仍工作，install 才会开机自启。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop', 'install', 'uninstall', 'logs'], description: 'Action to perform. 要执行的操作。' },
          lines: { type: 'integer', description: 'For logs: how many lines to return (default 40, max 200). 查日志时返回多少行。' },
        },
        required: ['action'],
      },
      output: { schema: daemonSchema, render: (_args, value) => text(value.message + (value.logs && value.logs.length ? '\n\n最近日志：\n' + value.logs.join('\n') : '')) },
      execute: async (args) => {
        const action = args && args.action
        if (action === 'status') {
          const status = await daemonStatus()
          return {
            ok: true,
            running: status.running,
            pid: status.pid,
            autostart: status.autostart,
            message:
              '守护' + (status.running ? '运行中（PID ' + status.pid + '）' : '未运行') +
              (status.autostart ? '，已设开机自启' : '，未设开机自启') +
              '。最近状态：' + (status.state.lastAction || '无') + ' · ' + timeText(status.state.lastActionAt),
          }
        }
        if (action === 'start') {
          const result = await startDaemon()
          return { ...result, running: result.ok, message: result.message }
        }
        if (action === 'stop') {
          const result = await stopDaemon()
          return { ...result, running: !result.ok, message: result.message }
        }
        if (action === 'install') {
          const autostart = await installAutostart()
          if (!autostart.ok) return { ok: false, message: autostart.message }
          const started = await startDaemon()
          const status = await daemonStatus()
          return {
            ok: started.ok,
            running: status.running,
            pid: status.pid,
            autostart: status.autostart,
            message: '已设置开机自启；' + started.message + '。之后 DSH 关着也会自动重连。',
          }
        }
        if (action === 'uninstall') {
          const removed = await removeAutostart()
          const stopped = await stopDaemon()
          const status = await daemonStatus()
          return {
            ok: removed.ok && stopped.ok,
            running: status.running,
            autostart: status.autostart,
            message: (removed.ok ? '已取消开机自启；' : removed.message + '；') + stopped.message,
          }
        }
        if (action === 'logs') {
          const lines = Math.min(200, Math.max(1, Number(args.lines) || 40))
          return { ok: true, message: '最近 ' + lines + ' 行日志：', logs: readTail(lines) }
        }
        return { ok: false, message: '未知操作：' + String(action) }
      },
    },
  ]
}
