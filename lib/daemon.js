import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PID_PATH, STOP_PATH, HOME, ensureHome } from './paths.js'
import { loadConfig } from './config.js'
import { portInUse, readState } from './engine.js'
import { sleep } from './network.js'

/**
 * 守护进程管理。
 *
 * 为什么不用普通 spawn：
 * DSH 调起的进程挂在 DSH 的作业对象里，工具调用一结束就被回收。
 * 所以走 WMI Win32_Process.Create（父进程 WmiPrvSE，不在作业内），
 * 由 wscript 隐藏启动一个 .cmd，再由 .cmd 启动 node。
 */

function binPath() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, '..', 'bin', 'campus-netd.js')
}

function startupDir() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

export const AUTOSTART_PATH = path.join(startupDir(), 'dsh-campus-net.vbs')
export const LAUNCHER_CMD = path.join(HOME, 'daemon.cmd')
export const LAUNCHER_VBS = path.join(HOME, 'daemon.vbs')

function quote(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}

function writeLaunchers() {
  ensureHome()
  const script = binPath()
  const exe = process.execPath
  // ELECTRON_RUN_AS_NODE=1 让 Electron 以 Node 模式跑脚本；纯 node 会忽略这个变量。
  const cmd = [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    'set "DSH_CAMPUS_NET_HOME=' + HOME + '"',
    quote(exe) + ' ' + quote(script),
    '',
  ].join('\r\n')
  fs.writeFileSync(LAUNCHER_CMD, cmd, 'utf8')
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run Chr(34) & "' + LAUNCHER_CMD.replace(/"/g, '""') + '" & Chr(34), 0, False',
    '',
  ].join('\r\n')
  fs.writeFileSync(LAUNCHER_VBS, vbs, 'utf8')
  return { cmd: LAUNCHER_CMD, vbs: LAUNCHER_VBS }
}

async function wmiCreate(commandLine) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CN_CMDLINE }',
    'if ($p.ReturnValue -ne 0) { throw "Win32_Process.Create 返回 " + $p.ReturnValue }',
    '[string]$p.ProcessId',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CN_CMDLINE: commandLine } },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || 'WMI 启动失败（exit ' + code + '）'))
    })
  })
}

export async function daemonStatus() {
  const cfg = loadConfig()
  const state = readState()
  const inUse = await portInUse(cfg.lockPort)
  let pid = 0
  try {
    pid = Number(JSON.parse(fs.readFileSync(PID_PATH, 'utf8')).pid) || 0
  } catch {
    pid = Number(state.pid) || 0
  }
  return {
    running: inUse,
    pid: inUse ? pid : 0,
    autostart: fs.existsSync(AUTOSTART_PATH),
    listenPort: cfg.lockPort,
    state,
  }
}

export async function startDaemon() {
  const cfg = loadConfig()
  if (await portInUse(cfg.lockPort)) return { ok: true, already: true, message: '守护已在运行' }
  ensureHome()
  try {
    fs.rmSync(STOP_PATH, { force: true })
  } catch {
    // 忽略
  }
  writeLaunchers()

  if (process.platform === 'win32') {
    // 直接把 node 作为 WMI 子进程启动：不经过 cmd / vbs，少一层弹窗和引号问题。
    // Electron 宿主需要 ELECTRON_RUN_AS_NODE=1，而 WMI 不能设环境变量，只能用 cmd 包一层。
    const parts = [quote(process.execPath), quote(binPath()), '--home', quote(HOME)]
    const commandLine = process.versions.electron
      ? 'cmd.exe /c set ELECTRON_RUN_AS_NODE=1&& ' + parts.join(' ')
      : parts.join(' ')
    const pid = await wmiCreate(commandLine)
    const up = await waitForPort(cfg.lockPort, 20)
    return {
      ok: up,
      pid: Number(pid) || 0,
      message: up ? '守护已启动' : '守护启动命令已发出，但 20 秒内没等到端口监听，请查看日志',
    }
  }

  const child = spawn(process.execPath, [binPath()], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DSH_CAMPUS_NET_HOME: HOME },
  })
  child.unref()
  const up = await waitForPort(cfg.lockPort, 25)
  return { ok: up, pid: child.pid || 0, message: up ? '守护已启动' : '守护启动超时，请查看日志' }
}

async function waitForPort(port, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true
    await sleep(500)
  }
  return false
}

export async function stopDaemon() {
  ensureHome()
  try {
    fs.writeFileSync(STOP_PATH, new Date().toISOString(), 'utf8')
  } catch {
    // 忽略
  }
  const cfg = loadConfig()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (!(await portInUse(cfg.lockPort))) {
      try {
        fs.rmSync(PID_PATH, { force: true })
      } catch {
        // 忽略
      }
      return { ok: true, message: '守护已停止' }
    }
    await sleep(500)
  }
  // 兜底：按 PID 结束（只结束我们记录的进程）
  let pid = 0
  try {
    pid = Number(JSON.parse(fs.readFileSync(PID_PATH, 'utf8')).pid) || 0
  } catch {
    pid = 0
  }
  if (pid > 0 && process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('close', resolve)
      child.on('error', resolve)
    })
  }
  const stopped = !(await portInUse(cfg.lockPort))
  return { ok: stopped, message: stopped ? '守护已停止（强制）' : '守护仍未停止，请手动结束 PID ' + pid }
}

export async function installAutostart() {
  if (process.platform !== 'win32') {
    return { ok: false, message: '当前平台请自行配置开机自启（例如 systemd user unit）' }
  }
  writeLaunchers()
  fs.mkdirSync(path.dirname(AUTOSTART_PATH), { recursive: true })
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run Chr(34) & "' + LAUNCHER_VBS.replace(/"/g, '""') + '" & Chr(34), 0, False',
    '',
  ].join('\r\n')
  fs.writeFileSync(AUTOSTART_PATH, vbs, 'utf8')
  return { ok: true, path: AUTOSTART_PATH, message: '已设置为开机自启' }
}

export async function removeAutostart() {
  try {
    fs.rmSync(AUTOSTART_PATH, { force: true })
    return { ok: true, message: '已取消开机自启' }
  } catch (error) {
    return { ok: false, message: '取消失败：' + error.message }
  }
}
