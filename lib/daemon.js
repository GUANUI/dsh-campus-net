import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME, HEARTBEAT_PATH, PAUSE_PATH, PID_PATH, STOP_PATH, ensureHome } from './paths.js'
import { loadConfig } from './config.js'
import { logLine, portInUse, readState, writeState } from './engine.js'

/**
 * 守护进程的安装与自愈。
 *
 * 这台机器上的三层保险（缺一层都可能出现“开机后没自动连”）：
 *   1. 计划任务  DSH CampusNet Watchdog —— 登录时拉起看门狗（uninstall 时删除）
 *   2. 启动文件夹 dsh-campus-net.vbs   —— 第二重入口，联想搬不走
 *   3. 看门狗自己 —— 每 20 秒看心跳，守护死了就拉起，计划任务被删了就重建
 * 另外守护每 60 秒反向检查看门狗（见 bin/campus-netd.js），插件加载时也自检一次。
 */

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const DAEMON_CMD = path.join(HOME, 'daemon.cmd')
export const DAEMON_VBS = path.join(HOME, 'daemon.vbs')
export const WATCHDOG_VBS = path.join(HOME, 'watchdog.vbs')
export const MAKETASK_PS1 = path.join(HOME, 'make-task.ps1')

export const TASK_NAME = 'DSH CampusNet Watchdog'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DSHCampusNet'
const HEARTBEAT_FRESH_MS = 90 * 1000

export function isWindows() {
  return process.platform === 'win32'
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exists(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function cleanPowerShellError(raw) {
  const text = String(raw || '')
  const lines = text.split(/\r?\n/).filter(Boolean)
  const out = []
  for (const line of lines) {
    const match = line.match(/<S S="Error">([\s\S]*?)<\/S>/)
    if (match) out.push(match[1].replace(/_x000D_/g, ''))
  }
  if (out.length) return out.join(' ').trim()
  return text.trim().split(/\r?\n/).slice(0, 3).join(' ').trim()
}

function runPowerShell(script, extraEnv = {}, timeoutMs = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
  try {
    const stdout = execFileSync('powershell.exe', args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    })
    return { ok: true, stdout: String(stdout || ''), stderr: '' }
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : ''
    const stderr = error && error.stderr ? String(error.stderr) : ''
    return { ok: false, stdout, stderr: cleanPowerShellError(stderr || (error && error.message) || '') }
  }
}

/* ------------------------------------------------------------------ *
 * 启动脚本（daemon.cmd / daemon.vbs / watchdog.vbs / make-task.ps1）
 * ------------------------------------------------------------------ */

function daemonCmdScript() {
  return [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    'set DSH_CAMPUS_NET_HOME=' + HOME,
    '"' + process.execPath + '" "' + path.join(ROOT, 'bin', 'campus-netd.js') + '" --home "' + HOME + '"',
    '',
  ].join('\r\n')
}

function daemonVbsScript() {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "cmd.exe /c ""' + DAEMON_CMD + '""", 0, False',
    '',
  ].join('\r\n')
}

function watchdogVbsScript() {
  const lines = [
    'Option Explicit',
    'Dim fso, sh, wmi, procs, p, selfPath, hb, st, pauseFlag, rc, fresh, count',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'selfPath = WScript.ScriptFullName',
    'hb = "' + HEARTBEAT_PATH + '"',
    'st = "' + path.join(HOME, 'state.json') + '"',
    'pauseFlag = "' + PAUSE_PATH + '"',
    '',
    "' 单实例：计划任务和启动文件夹可能同时拉起，只留一个。",
    'count = 0',
    'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    'Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = \'wscript.exe\'")',
    'For Each p In procs',
    '  If Not IsNull(p.CommandLine) Then',
    '    If InStr(LCase(p.CommandLine), LCase(selfPath)) > 0 Then count = count + 1',
    '  End If',
    'Next',
    'If count > 1 Then WScript.Quit',
    '',
    'Do While True',
    '  fso.OpenTextFile(hb, 2, True).WriteLine Now',
    '  If fso.FileExists(pauseFlag) Then',
    '    WScript.Sleep 20000',
    '  Else',
    '    fresh = False',
    '    If fso.FileExists(st) Then',
    '      If DateDiff("s", fso.GetFile(st).DateLastModified, Now) < 30 Then fresh = True',
    '    End If',
    '    If fresh Then',
    '      WScript.Sleep 20000',
    '    Else',
    '      sh.Run "cmd.exe /c ""' + DAEMON_CMD + '""", 0, False',
    '      WScript.Sleep 10000',
    '    End If',
    "    ' 计划任务被删或禁用时自己重建（用户主动暂停时不重建）。",
    '    rc = sh.Run("schtasks.exe /query /tn ""' + TASK_NAME + '""", 0, True)',
    '    If rc <> 0 And fso.FileExists("' + MAKETASK_PS1 + '") Then',
    '      sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + MAKETASK_PS1 + '""", 0, True',
    '    End If',
    '  End If',
    'Loop',
    '',
  ]
  return lines.join('\r\n')
}

export function taskScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$name = '" + TASK_NAME.replace(/'/g, "''") + "'",
    "$watchdog = '" + WATCHDOG_VBS.replace(/'/g, "''") + "'",
    '$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    'if ($existing) {',
    '  Write-Output ("EXISTS|" + $existing.State)',
    '} else {',
    "  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + $watchdog + '\"')",
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn',
    '  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -DisallowStartIfOnBatteries:$false -StopIfGoingOnBatteries:$false -MultipleInstances IgnoreNew',
    "  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'DSH campus network autologin watchdog' -Force | Out-Null",
    '  $state = (Get-ScheduledTask -TaskName $name).State',
    '  Write-Output ("CREATED|" + $state)',
    '}',
    '$task = Get-ScheduledTask -TaskName $name',
    "if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $name }",
    '',
  ].join('\r\n')
}

/** 写四个脚本；幂等，每次启动都刷新，保证脚本内容和插件版本一致。 */
export function writeLaunchers() {
  ensureHome()
  fs.writeFileSync(DAEMON_CMD, daemonCmdScript(), 'utf8')
  fs.writeFileSync(DAEMON_VBS, daemonVbsScript(), 'utf8')
  fs.writeFileSync(WATCHDOG_VBS, watchdogVbsScript(), 'utf8')
  // PowerShell 5.1 没有 BOM 会按 ANSI 读，中文注释会乱码，所以写 BOM。
  fs.writeFileSync(MAKETASK_PS1, '\ufeff' + taskScript(), 'utf8')
  return { ok: true, files: [DAEMON_CMD, DAEMON_VBS, WATCHDOG_VBS, MAKETASK_PS1] }
}

/* ------------------------------------------------------------------ *
 * 看门狗状态 / 守护进程启停
 * ------------------------------------------------------------------ */

export function isPaused() {
  return exists(PAUSE_PATH)
}

export function heartbeatAt() {
  try {
    return fs.statSync(HEARTBEAT_PATH).mtime
  } catch {
    return null
  }
}

export function watchdogAlive() {
  const at = heartbeatAt()
  return Boolean(at && Date.now() - at.getTime() < HEARTBEAT_FRESH_MS)
}

function wmiStart(commandLine) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$cmd = ' + psQuote(commandLine),
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    'if ($r.ReturnValue -ne 0) { Write-Output ("ERR|" + $r.ReturnValue) } else { Write-Output ("OK|" + $r.ProcessId) }',
  ].join('\n')
  return runPowerShell(script)
}

/** 结束指定 PID：WMI 启动的进程不在 DSH 的作业对象里，只能走 taskkill。 */
function killProcess(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function readPidFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PID_PATH, 'utf8'))
    const pid = Number(raw.pid)
    return Number.isFinite(pid) ? pid : 0
  } catch {
    return 0
  }
}

export async function startDaemon() {
  const cfg = loadConfig()

  if (!isWindows()) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'campus-netd.js'), '--home', HOME], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DSH_CAMPUS_NET_HOME: HOME },
    })
    child.unref()
    await sleep(1500)
    writeState({ running: true, pid: child.pid, startedAt: new Date().toISOString(), lastError: '' })
    return { ok: true, message: '守护进程已启动（PID ' + child.pid + '）。' }
  }

  if (await portInUse(cfg.lockPort)) {
    const pid = (await readPidFile()) || Number(readState().pid) || 0
    const watchdog = watchdogAlive() ? '，看门狗在守护' : '，看门狗未运行'
    return { ok: true, message: '守护已在运行（PID ' + (pid || '未知') + '）' + watchdog }
  }

  fs.rmSync(PAUSE_PATH, { force: true })
  fs.rmSync(STOP_PATH, { force: true })
  writeLaunchers()

  const launched = wmiStart('wscript.exe "' + WATCHDOG_VBS + '"')
  if (!launched.ok) {
    writeState({ lastError: '看门狗启动失败：' + launched.stderr })
    return { ok: false, message: '启动失败：' + launched.stderr }
  }

  let running = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000)
    if (await portInUse(cfg.lockPort)) {
      running = true
      break
    }
  }
  if (!running) {
    // 看门狗没把守护拉起来时，再兜底直接起一次 daemon.cmd。
    wmiStart('cmd.exe /c "' + DAEMON_CMD + '"')
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000)
      if (await portInUse(cfg.lockPort)) {
        running = true
        break
      }
    }
  }

  if (!running) {
    writeState({ lastError: '守护进程没有起来' })
    return { ok: false, message: '守护没起来，请打开日志 %LOCALAPPDATA%\\dsh-campus-net\\campus-net.log 查看原因。' }
  }

  const pid = (await readPidFile()) || 0
  writeState({ running: true, pid, startedAt: new Date().toISOString(), lastError: '' })
  const watchdog = await ensureWatchdog()
  logLine('守护进程已启动（PID ' + (pid || '未知') + '）')
  const tail = watchdog.ok ? '，看门狗在守护' : '，但看门狗没起来：' + watchdog.message
  return { ok: true, message: '守护进程已启动（PID ' + (pid || '未知') + '）' + tail }
}

export async function stopDaemon() {
  const cfg = loadConfig()
  if (!(await portInUse(cfg.lockPort))) {
    writeState({ running: false })
    return { ok: true, message: '守护本来就没在运行。' }
  }
  // 先让看门狗别急着拉起，再让守护自己退出；退不掉就按 PID 结束。
  fs.writeFileSync(PAUSE_PATH, new Date().toISOString(), 'utf8')
  fs.writeFileSync(STOP_PATH, new Date().toISOString(), 'utf8')

  let stopped = false
  for (let i = 0; i < 15; i += 1) {
    await sleep(1000)
    if (!(await portInUse(cfg.lockPort))) {
      stopped = true
      break
    }
  }
  if (!stopped) {
    const pid = (await readPidFile()) || Number(readState().pid) || 0
    if (pid) killProcess(pid)
    for (let i = 0; i < 5; i += 1) {
      await sleep(1000)
      if (!(await portInUse(cfg.lockPort))) {
        stopped = true
        break
      }
    }
  }
  fs.rmSync(STOP_PATH, { force: true })
  fs.rmSync(PID_PATH, { force: true })
  writeState({ running: false, stoppedAt: new Date().toISOString() })
  logLine('守护进程已按要求停止')
  if (stopped) return { ok: true, message: '守护进程已停止。看门狗不会自动再拉起它，要用时请再点“启动”。' }
  return { ok: false, message: '停止超时，守护进程可能还在，请在任务管理器里结束 node.exe 后重试。' }
}

/** 看门狗没在跑就把它拉起来（优先计划任务，退而求其次 WMI 起 wscript）。 */
export async function ensureWatchdog() {
  if (!isWindows()) return { ok: false, message: '看门狗仅 Windows 支持。' }
  if (watchdogAlive()) return { ok: true, message: '看门狗在运行。' }
  if (exists(PAUSE_PATH)) return { ok: false, message: '已手动暂停，不自动拉起看门狗。' }

  writeLaunchers()
  const task = await scheduledTaskState()
  if (task === 'Missing') {
    await ensureScheduledTask()
  } else if (task !== 'Running') {
    runPowerShell('Start-ScheduledTask -TaskName ' + psQuote(TASK_NAME))
    await sleep(1500)
  }
  if (!watchdogAlive()) wmiStart('wscript.exe "' + WATCHDOG_VBS + '"')

  for (let i = 0; i < 10; i += 1) {
    await sleep(1000)
    if (watchdogAlive()) return { ok: true, message: '看门狗已重新拉起。' }
  }
  return { ok: false, message: '看门狗没能起来，请手动运行 ' + WATCHDOG_VBS }
}

/* ------------------------------------------------------------------ *
 * 开机自启：启动文件夹 / Run 键 / 计划任务
 * ------------------------------------------------------------------ */

function startupDir() {
  const base = process.env.APPDATA || path.join(HOME, '..')
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

export function startupEntryPath() {
  return path.join(startupDir(), 'dsh-campus-net.vbs')
}

function startupEntryScript() {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "wscript.exe ""' + WATCHDOG_VBS + '""", 0, False',
    '',
  ].join('\r\n')
}

function writeStartupEntry() {
  const file = startupEntryPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, startupEntryScript(), 'utf8')
    return exists(file)
  } catch {
    return false
  }
}

function removeStartupEntry() {
  try {
    fs.rmSync(startupEntryPath(), { force: true })
    return true
  } catch {
    return false
  }
}

export function readRunKey() {
  if (!isWindows()) return ''
  try {
    const out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = String(out).match(/REG_SZ\s+(.+)/)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

function writeRunKey() {
  if (!isWindows()) return false
  try {
    execFileSync('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', 'wscript.exe "' + WATCHDOG_VBS + '"', '/f'], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function deleteRunKey() {
  if (!isWindows()) return false
  try {
    execFileSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true, timeout: 8000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 计划任务状态：Ready / Running / Disabled / Missing / Unavailable。 */
export async function scheduledTaskState() {
  if (!isWindows()) return 'Unavailable'
  try {
    const out = execFileSync('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'LIST'], {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8',
    })
    const match = String(out).match(/Status:\s*(\S+)/i) || String(out).match(/状态:\s*(\S+)/)
    return match ? match[1].trim() : 'Ready'
  } catch {
    return 'Missing'
  }
}

function parseTaskResult(stdout) {
  const text = String(stdout || '')
  const created = text.match(/CREATED\|(\S+)/)
  if (created) return { action: 'CREATED', state: created[1] }
  const exists = text.match(/EXISTS\|(\S+)/)
  if (exists) return { action: 'EXISTS', state: exists[1] }
  return { action: 'UNKNOWN', state: 'Unknown' }
}

/** 用 make-task.ps1 注册计划任务并启动；已存在则只保证在运行。 */
export async function ensureScheduledTask() {
  if (!isWindows()) return { ok: false, message: '计划任务仅 Windows 支持。' }
  writeLaunchers()
  const result = runPowerShell('& ' + psQuote(MAKETASK_PS1), {}, 30000)
  if (!result.ok) return { ok: false, message: '注册计划任务失败：' + result.stderr }
  const parsed = parseTaskResult(result.stdout)
  const state = await scheduledTaskState()
  if (state === 'Missing') return { ok: false, message: '注册计划任务后仍查不到，请检查杀毒软件是否拦截。' }
  const verb = parsed.action === 'CREATED' ? '创建' : '存在'
  return { ok: true, action: parsed.action, state, message: '计划任务已' + verb + '（' + state + '）' }
}

/** 三层自启的体检结果，状态工具和设置页都用它。 */
export async function autostartLayers() {
  const startup = exists(startupEntryPath())
  const runKey = Boolean(readRunKey())
  const task = await scheduledTaskState()
  return {
    startup,
    runKey,
    task,
    watchdog: watchdogAlive(),
    ok: startup || task === 'Ready' || task === 'Running',
  }
}

export async function installAutostart() {
  if (!isWindows()) return { ok: false, message: '开机自启目前只支持 Windows。' }
  fs.rmSync(PAUSE_PATH, { force: true })
  writeLaunchers()
  const startupOk = writeStartupEntry()
  writeRunKey()
  await sleep(500)
  const runKeyOk = Boolean(readRunKey())
  const task = await ensureScheduledTask()
  const layers = await autostartLayers()
  const ok = startupOk || task.ok
  writeState({ autostartInstalled: Boolean(ok) })
  const parts = [
    startupOk ? '启动文件夹 已装' : '启动文件夹 失败',
    runKeyOk ? 'Run 键 已装' : 'Run 键被安全软件拦了（不影响另外两层）',
    task.ok ? '计划任务 已装' : '计划任务 失败（' + task.message + '）',
  ]
  return {
    ok,
    layers,
    message: (ok ? '已开启开机自启：' : '自启没完全成功：') + parts.join('，') + '。下次登录后 10–20 秒内会自动连上。',
  }
}

export async function removeAutostart() {
  if (!isWindows()) return { ok: true, message: '已关闭开机自启。' }
  // 先放暂停标记，避免看门狗在卸载过程中又把它自己拉起来。
  fs.writeFileSync(PAUSE_PATH, new Date().toISOString(), 'utf8')
  removeStartupEntry()
  deleteRunKey()
  runPowerShell('Unregister-ScheduledTask -TaskName ' + psQuote(TASK_NAME) + ' -Confirm:$false -ErrorAction SilentlyContinue')
  const layers = await autostartLayers()
  const ok = !layers.startup && layers.task === 'Missing'
  writeState({ autostartInstalled: false })
  return { ok, layers, message: ok ? '已关闭开机自启（启动文件夹、Run 键、计划任务都已清掉）。' : '部分自启项没清干净，请检查任务计划程序。' }
}

/** 给状态工具和设置页用的守护进程概况。 */
export async function daemonStatus() {
  const cfg = loadConfig()
  const state = readState()
  const running = await portInUse(cfg.lockPort)
  const pid = running ? (await readPidFile()) || Number(state.pid) || 0 : 0
  const layers = await autostartLayers()
  const hb = heartbeatAt()
  return {
    running,
    pid,
    port: cfg.lockPort,
    autostart: layers.startup || layers.task === 'Ready' || layers.task === 'Running',
    watchdog: layers.watchdog,
    heartbeatAt: hb ? hb.toISOString() : '',
    layers,
    state: {
      startedAt: state.startedAt || '',
      lastAction: state.lastAction || '',
      lastActionAt: state.lastActionAt || '',
      lastError: state.lastError || '',
      checks: state.checks || 0,
      logins: state.logins || 0,
    },
  }
}
