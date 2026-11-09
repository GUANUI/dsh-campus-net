#!/usr/bin/env node
import fs from 'node:fs'
import net from 'node:net'

/**
 * 常驻守护进程入口。
 * 由 WMI 隐藏启动（见 lib/daemon.js），不依赖 DSH 是否开着。
 *
 * --home 用来显式传数据目录：WMI 启动的进程不继承 DSH 的环境变量，
 * 所以不能只靠 DSH_CAMPUS_NET_HOME。必须在 import lib 之前设置。
 */

const homeIndex = process.argv.indexOf('--home')
if (homeIndex > 0 && process.argv[homeIndex + 1]) {
  process.env.DSH_CAMPUS_NET_HOME = process.argv[homeIndex + 1]
}

const { PID_PATH, STOP_PATH, ensureHome } = await import('../lib/paths.js')
const { loadConfig } = await import('../lib/config.js')
const { createEngine, logLine, writeState } = await import('../lib/engine.js')

const cfg = loadConfig()
ensureHome()

let shuttingDown = false

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  logLine('守护退出：' + reason)
  writeState({ running: false, stoppedAt: new Date().toISOString() })
  try {
    fs.rmSync(PID_PATH, { force: true })
  } catch {
    // 忽略
  }
  process.exit(0)
}

process.on('uncaughtException', (error) => {
  logLine('未捕获异常：' + (error && error.stack ? error.stack : String(error)))
})
process.on('unhandledRejection', (error) => {
  logLine('未处理 Promise 拒绝：' + (error && error.stack ? error.stack : String(error)))
})
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 单实例锁：端口只允许一个守护监听；第二个实例直接退出。
const lock = net.createServer()
lock.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    logLine('已有守护在监听 ' + cfg.lockPort + '，本实例退出')
    process.exit(0)
  }
  logLine('锁端口异常：' + error.message)
  process.exit(1)
})
lock.listen({ host: '127.0.0.1', port: cfg.lockPort, exclusive: true }, () => {
  try {
    fs.writeFileSync(PID_PATH, JSON.stringify({ pid: process.pid, port: cfg.lockPort, startedAt: new Date().toISOString() }), 'utf8')
  } catch {
    // 忽略
  }
  const engine = createEngine()
  engine.start()

  // 停止标记每 2 秒检查一次，避免等待长退避时停不下来。
  setInterval(() => {
    if (fs.existsSync(STOP_PATH)) {
      try {
        fs.rmSync(STOP_PATH, { force: true })
      } catch {
        // 忽略
      }
      shutdown('收到停止标记')
    }
  }, 2000).unref()
})
