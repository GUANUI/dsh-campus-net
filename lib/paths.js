import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 数据目录：
 * - 可用 DSH_CAMPUS_NET_HOME 覆盖（测试与多实例用）
 * - Windows 放在 %LOCALAPPDATA%\dsh-campus-net
 * - macOS / Linux 放在各自的用户配置目录
 */
export function resolveHome() {
  const override = process.env.DSH_CAMPUS_NET_HOME
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-campus-net')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-campus-net')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-campus-net')
}

export const HOME = resolveHome()
export const CONFIG_PATH = path.join(HOME, 'config.json')
export const CRED_PATH = path.join(HOME, 'cred.dat')
export const KEY_PATH = path.join(HOME, 'cred.key')
export const STATE_PATH = path.join(HOME, 'state.json')
export const LOG_PATH = path.join(HOME, 'campus-net.log')
export const PID_PATH = path.join(HOME, 'daemon.pid')
export const STOP_PATH = path.join(HOME, 'stop.flag')
// 用户主动停止守护时留下，看门狗看到它就不再拉起。
export const PAUSE_PATH = path.join(HOME, 'pause.flag')
// 看门狗每轮写一次心跳；守护/插件据此判断看门狗是否还活着。
export const HEARTBEAT_PATH = path.join(HOME, 'watchdog.heartbeat')

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  return HOME
}
