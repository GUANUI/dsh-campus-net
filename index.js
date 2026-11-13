import { readState } from './lib/engine.js'
import { daemonStatus, ensureWatchdog, installAutostart, isPaused, startDaemon } from './lib/daemon.js'
import { maybeOnboard } from './lib/onboarding.js'
import { buildCampusTools } from './lib/tools.js'

/**
 * dsh-campus-net 的宿主半边：注册四个工具，并在插件加载后做一次自检。
 *
 * 自检只“修复”，不“新建”：如果用户执行过 uninstall（state.autostartInstalled === false），
 * 这里什么都不做，避免卸载后重启 DSH 又被装回去。
 */

export const name = 'dsh-campus-net'
export const inject = ['tools']

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // 记日志失败不能影响插件加载
  }
}

export function apply(ctx) {
  for (const tool of buildCampusTools()) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      warn(ctx, '[dsh-campus-net] 工具注册失败：' + tool.name + ' · ' + (error && error.message ? error.message : String(error)))
    }
  }

  const timer = setTimeout(() => {
    selfCheck(ctx).catch((error) => warn(ctx, '[dsh-campus-net] 自检失败：' + (error && error.message ? error.message : String(error))))
    maybeOnboard().catch(() => {})
  }, 2500)
  if (timer && typeof timer.unref === 'function') timer.unref()
}

async function selfCheck(ctx) {
  const state = readState()
  if (state.autostartInstalled === false) return
  if (isPaused()) return
  try {
    const installed = await installAutostart()
    if (!installed.ok) warn(ctx, '[dsh-campus-net] 自启没装全：' + installed.message)
    const status = await daemonStatus()
    if (!status.running) {
      const started = await startDaemon()
      if (!started.ok) warn(ctx, '[dsh-campus-net] 守护没起来：' + started.message)
    } else if (!status.watchdog) {
      await ensureWatchdog()
    }
  } catch (error) {
    warn(ctx, '[dsh-campus-net] 自检异常：' + (error && error.message ? error.message : String(error)))
  }
}
