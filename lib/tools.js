import { loadConfig } from './config.js'
import { daemonStatus, ensureWatchdog, ensureScheduledTask, installAutostart, removeAutostart, startDaemon, stopDaemon, autostartLayers } from './daemon.js'
import { loginOnce, overview } from './engine.js'
import { openInBrowser } from './onboarding.js'
import { startSetupServer } from './setup-server.js'

/**
 * 四个工具：查状态 / 立即登录 / 打开设置页 / 守护进程与自启。
 * 工具定义的形状按 DSH 插件宿主的要求：parameters 是 JSON Schema，
 * output.render 把结果渲染成给模型看的一段文本。
 */

function text(value) {
  return [{ type: 'text', text: String(value == null ? '' : value) }]
}

function yes(value) {
  return value ? '是' : '否'
}

function renderStatus(value = {}) {
  const state = value.state || {}
  const wifi = value.wifi || {}
  const probe = value.probe || {}
  const daemon = value.daemon || {}
  const layers = daemon.layers || {}
  const lines = []
  lines.push(value.online ? '校园网：在线' + (probe.status ? '（HTTP ' + probe.status + '）' : '') : '校园网：离线' + (probe.detail ? ' · ' + probe.detail : ''))
  lines.push('Wi-Fi：' + (wifi.ssid ? wifi.ssid + (wifi.state ? ' · ' + wifi.state : '') : wifi.restricted ? '无法读取（Windows 位置权限未开）' : '未连接'))
  if (state.currentUsername) lines.push('登录账号：' + state.currentUsername)
  if (state.lastAction) lines.push('最近动作：' + state.lastAction + (state.lastActionAt ? ' · ' + state.lastActionAt : ''))
  lines.push('守护进程：' + (daemon.running ? '运行中' + (daemon.pid ? '（PID ' + daemon.pid + '）' : '') : '未运行'))
  lines.push('看门狗：' + (daemon.watchdog ? '在守护' : '未运行'))
  lines.push(
    '开机自启：计划任务 ' + (layers.task || '未知') + ' · 启动文件夹 ' + yes(layers.startup) + ' · Run 键 ' + yes(layers.runKey),
  )
  if (state.lastError) lines.push('最近错误：' + state.lastError)
  if (!daemon.running && !daemon.autostart) lines.push('提示：现在没有守护，开机也不会自动连。执行 campus_net_daemon { "action": "install" } 开启。')
  return text(lines.join('\n'))
}

export function buildCampusTools() {
  const status = {
    name: 'campus_net_status',
    description: '查看校园网状态：是否在线、当前 Wi-Fi、登录账号、守护进程与三层开机自启是否正常。排查“没自动连”时先调它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          online: { type: 'boolean' },
          probe: { type: 'object', additionalProperties: true },
          wifi: { type: 'object', additionalProperties: true },
          state: { type: 'object', additionalProperties: true },
          daemon: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      render: (_args, value) => renderStatus(value),
    },
    async execute() {
      const info = await overview()
      const daemon = await daemonStatus()
      return { ...info, daemon }
    },
  }

  const login = {
    name: 'campus_net_login',
    description: '立刻用已保存的账号密码登录校园网（会先连上配置的校园 Wi-Fi）。密码错误不会重试，避免锁号。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, username: { type: 'string' }, message: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_args, value = {}) =>
        text(value.ok ? '登录成功' + (value.username ? '（' + value.username + '）' : '') : '登录失败：' + (value.message || '未知原因')),
    },
    async execute() {
      return loginOnce()
    },
  }

  const setup = {
    name: 'campus_net_setup',
    description: '打开本机设置页（只监听 127.0.0.1，带临时 token）：填账号密码、选校园 Wi-Fi、改检查间隔与自启。第一次用校园网插件时先调它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, url: { type: 'string' }, message: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_args, value = {}) => {
        if (!value.ok) return text('设置页没打开：' + (value.message || '未知原因'))
        return text(
          [
            '设置页已打开：' + value.url,
            '五步：① 选校园 Wi-Fi ② 填账号密码 ③ 确认门户地址 ④ 保存 ⑤ 开启开机自启',
            '页面只在本机可访问，关掉插件后链接失效。',
          ].join('\n'),
        )
      },
    },
    async execute() {
      const server = startSetupServer()
      const info = await server.ready
      openInBrowser(info.url)
      return { ok: true, url: info.url, message: '设置页已打开' }
    },
  }

  const daemon = {
    name: 'campus_net_daemon',
    description:
      '守护进程与开机自启：status 查状态、start 启动、stop 停止、install 开启开机自启（计划任务+启动文件夹+Run 键三层）、uninstall 关闭并停止、repair 一键体检并修复（开机没自动连时用这个）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'install', 'uninstall', 'repair'],
          description: 'status=查状态，start=启动守护，stop=停止守护，install=开启开机自启，uninstall=关闭自启并停止，repair=体检并修复。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value = {}) => {
        const action = (args && args.action) || 'status'
        if (action === 'status') return renderStatus({ daemon: value, state: (value && value.state) || {} })
        const lines = [value.message || '完成']
        const layers = value.layers
        if (layers) {
          lines.push(
            '计划任务：' + (layers.task || '未知') + ' · 启动文件夹：' + yes(layers.startup) + ' · Run 键：' + yes(layers.runKey) + ' · 看门狗：' + (layers.watchdog ? '在跑' : '没跑'),
          )
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args = {}) {
      const action = String(args.action || 'status')
      if (action === 'status') return daemonStatus()
      if (action === 'start') {
        const result = await startDaemon()
        return { ...result, layers: await autostartLayers() }
      }
      if (action === 'stop') {
        const result = await stopDaemon()
        return { ...result, layers: await autostartLayers() }
      }
      if (action === 'install') {
        const result = await installAutostart()
        if (result.ok && !(await daemonStatus()).running) {
          const started = await startDaemon()
          result.message = result.message + ' ' + started.message
        }
        return result
      }
      if (action === 'uninstall') {
        const removed = await removeAutostart()
        const stopped = await stopDaemon()
        return { ok: removed.ok, message: removed.message + ' ' + stopped.message, layers: await autostartLayers() }
      }
      if (action === 'repair') return repair()
      throw new Error('未知操作：' + action + '（可选 status / start / stop / install / uninstall / repair）')
    },
  }

  return [status, login, setup, daemon]
}

/** 一键体检：补齐自启三层、拉起守护、拉起看门狗，最后回报现状。 */
async function repair() {
  const steps = []
  const installed = await installAutostart()
  steps.push(installed.message)
  let status = await daemonStatus()
  if (!status.running) {
    const started = await startDaemon()
    steps.push(started.message)
    status = await daemonStatus()
  }
  if (!status.watchdog) {
    const kick = await ensureWatchdog()
    steps.push(kick.message)
  }
  await ensureScheduledTask()
  status = await daemonStatus()
  steps.push(
    '现状：守护' + (status.running ? '运行中（PID ' + status.pid + '）' : '未运行') + '，看门狗' + (status.watchdog ? '在跑' : '没跑') + '。下次登录后 10–20 秒内应能自动连上。',
  )
  if (!status.running) steps.push('如果还是连不上，打开日志：%LOCALAPPDATA%\\dsh-campus-net\\campus-net.log')
  return { ok: status.running, message: steps.join('\n'), layers: status.layers }
}
