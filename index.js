import { buildCampusTools } from './lib/tools.js'
import { logLine } from './lib/engine.js'

export const name = 'campus-net'

/** 只依赖工具注册表；不注入客户端 UI，因此无需浏览器端 bundle。 */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const disposers = []
  for (const tool of buildCampusTools(config)) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logLine('注册工具 ' + tool.name + ' 失败：' + (error && error.message ? error.message : String(error)))
    }
  }
  logLine('dsh-campus-net 已加载，注册 ' + disposers.length + ' 个工具')

  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载失败不应影响其它插件
      }
    }
  })
}
