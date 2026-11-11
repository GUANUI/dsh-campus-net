import fs from 'node:fs'
import { CONFIG_PATH, ensureHome } from './paths.js'

/**
 * 南京审计大学门户预设。
 * 其他学校如果也是“POST JSON + reply_code”这一类门户，可以在设置页选“自定义 JSON 门户”
 * 后改门户地址、接口路径和字段名；差异很大的门户（深澜 / Dr.COM 等）目前不冒充支持。
 */
export const PRESETS = {
  nau: {
    preset: 'nau',
    label: '南京审计大学',
    portal: 'http://login.nau.edu.cn',
    portalIpFallback: { ip: '10.255.254.23', host: 'login.nau.edu.cn' },
    paths: {
      session: '/api/portal/v1/getinfo',
      login: '/api/portal/v1/login',
      logout: '/api/portal/v1/logout',
      challenge: '/api/portal/v1/challenge',
    },
    fields: { domain: 'domain', username: 'username', password: 'password' },
    domain: 'default',
    auth: 'auto',
    successCode: 0,
    // i-NAU 与 i-NAU-Lib 都是校内免费网络，按顺序尝试。
    // chinanet / cmcc / unicom 是运营商收费网络，不在自动连接列表里，
    // 避免把用户带到要计费的网络上。
    ssids: ['i-NAU', 'i-NAU-Lib'],
    fallbackSsids: [],
    onlineProbe: 'http://connect.rom.miui.com/generate_204',
    onlineStatus: 204,
  },
}

export const DEFAULTS = {
  preset: 'nau',
  portal: PRESETS.nau.portal,
  portalIpFallback: { ...PRESETS.nau.portalIpFallback },
  paths: { ...PRESETS.nau.paths },
  fields: { ...PRESETS.nau.fields },
  domain: 'default',
  auth: 'auto',
  successCode: 0,
  usernames: [],
  ssids: [...PRESETS.nau.ssids],
  fallbackSsids: [...PRESETS.nau.fallbackSsids],
  onlineProbe: PRESETS.nau.onlineProbe,
  onlineStatus: 204,
  intervalSeconds: 10,
  connectWaitSeconds: 12,
  verifyWaitSeconds: 12,
  lockPort: 47215,
  logOnline: false,
  autoConnectWhenOffline: true,
  // 第一次加载插件时自动打开设置页（顶部有五步指引），只弹一次。
  autoOpenGuide: true,
}

const INT_RANGES = {
  intervalSeconds: [5, 3600],
  connectWaitSeconds: [3, 120],
  verifyWaitSeconds: [3, 120],
  lockPort: [1024, 65535],
  successCode: [0, 999],
  onlineStatus: [200, 499],
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
}

/** 把任意来源的配置洗成可信形状；非法值回落到默认值而不是让守护崩掉。 */
export function normalizeConfig(raw = {}) {
  const cfg = deepMerge(DEFAULTS, isPlainObject(raw) ? raw : {})
  const preset = PRESETS[cfg.preset] ? cfg.preset : 'nau'
  cfg.preset = preset
  cfg.portal = asString(cfg.portal, DEFAULTS.portal).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(cfg.portal)) cfg.portal = DEFAULTS.portal
  cfg.paths = deepMerge(DEFAULTS.paths, isPlainObject(cfg.paths) ? cfg.paths : {})
  for (const key of Object.keys(DEFAULTS.paths)) {
    const value = asString(cfg.paths[key])
    cfg.paths[key] = value.startsWith('/') ? value : '/' + value
  }
  cfg.fields = deepMerge(DEFAULTS.fields, isPlainObject(cfg.fields) ? cfg.fields : {})
  cfg.portalIpFallback = isPlainObject(cfg.portalIpFallback)
    ? { ip: asString(cfg.portalIpFallback.ip), host: asString(cfg.portalIpFallback.host) }
    : { ip: '', host: '' }
  cfg.usernames = asStringList(cfg.usernames)
  cfg.ssids = asStringList(cfg.ssids)
  cfg.fallbackSsids = asStringList(cfg.fallbackSsids)
  cfg.onlineProbe = asString(cfg.onlineProbe, DEFAULTS.onlineProbe)
  cfg.domain = asString(cfg.domain, DEFAULTS.domain)
  cfg.auth = ['auto', 'json', 'chap'].includes(cfg.auth) ? cfg.auth : 'auto'
  for (const [key, [min, max]] of Object.entries(INT_RANGES)) {
    const value = Number(cfg[key])
    cfg[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key]
  }
  cfg.logOnline = Boolean(cfg.logOnline)
  cfg.autoConnectWhenOffline = cfg.autoConnectWhenOffline !== false
  return cfg
}

export function loadConfig() {
  ensureHome()
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return normalizeConfig(raw)
  } catch {
    return normalizeConfig({})
  }
}

/** 原子写入，避免守护进程读到写了一半的配置。 */
export function saveConfig(patch) {
  ensureHome()
  const next = normalizeConfig(deepMerge(loadConfig(), patch))
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, CONFIG_PATH)
  return next
}

/** 切换预设：只覆盖预设负责的字段，保留账号、间隔等用户设置。 */
export function applyPreset(name) {
  const preset = PRESETS[name]
  if (!preset) throw new Error('未知的门户预设：' + name)
  const { label, ...values } = preset
  return saveConfig(values)
}
