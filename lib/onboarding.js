import { spawn } from 'node:child_process'
import { loadConfig } from './config.js'
import { readState, writeState } from './engine.js'
import { startSetupServer } from './setup-server.js'

/**
 * 首次使用的引导“弹窗”。
 *
 * DSH 插件宿主没有“安装完成后弹窗”的钩子，插件也不能直接画宿主的 UI，
 * 所以这里用最接近的方式：插件第一次加载时，自动在默认浏览器里打开设置页
 * （页面顶部就是五步操作指引）。只弹一次，之后可在设置里关掉。
 */

export function openInBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  child.unref()
  return true
}

export async function maybeOnboard({ force = false } = {}) {
  try {
    const cfg = loadConfig()
    if (!force && cfg.autoOpenGuide === false) return { opened: false, reason: 'disabled in config' }
    if (!force && process.env.DSH_CAMPUS_NET_NO_GUIDE === '1') return { opened: false, reason: 'disabled by env' }
    const state = readState()
    if (!force && state.onboardedAt) return { opened: false, reason: 'already onboarded' }
    const server = startSetupServer()
    const info = await server.ready
    const guideUrl = info.url.replace('/?token=', '/guide?token=')
    openInBrowser(guideUrl)
    writeState({ onboardedAt: new Date().toISOString() })
    return { opened: true, url: guideUrl, settingsUrl: info.url }
  } catch (error) {
    return { opened: false, reason: error && error.message ? error.message : String(error) }
  }
}
