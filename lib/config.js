import fs from 'node:fs'
import { CONFIG_PATH, ensureHome } from './paths.js'

/**
 * 通用的 “POST JSON + reply_code” 门户模板。
 * 门户地址、接口路径、账号字段、Wi-Fi 名称全部由用户在设置页填写，
 * 插件不内置任何学校、单位或运营商的域名与 SSID。
 * 差异很大的门户（深澜 / Dr.COM 等）协议不同，目前不冒充支持。
 */
export const PRESETS = {
  custom: {
    preset: 'custom',
    label: '自定义 JSON 门户',
    portal: '',
    portalIpFallback: { ip: '', host: '' },
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
    // 校园网 SSID 由用户在设置页扫描后勾选；默认不预设任何网络。
    ssids: [],
    fallbackSsids: [],
    onlineProbe: 'http://connect.rom.miui.com/generate_204',
    onlineStatus: 204,
  },
}

/** 方案级别（每个校园网各存一份）的字段。 */
const PROFILE_KEYS = [
  'id',
  'name',
  'preset',
  'portal',
  'portalIpFallback',
  'paths',
  'fields',
  'domain',
  'auth',
  'successCode',
  'usernames',
  'ssids',
  'fallbackSsids',
  'preferCampusOverPaid',
  'onlineProbe',
  'onlineStatus',
]
const PROFILE_DATA_KEYS = PROFILE_KEYS.filter((key) => key !== 'id')
/** 所有方案共用的全局字段。 */
const GLOBAL_KEYS = [
  'intervalSeconds',
  'connectWaitSeconds',
  'verifyWaitSeconds',
  'lockPort',
  'logOnline',
  'autoConnectWhenOffline',
  'autoOpenGuide',
]

export const DEFAULTS = {
  preset: 'custom',
  portal: '',
  portalIpFallback: { ...PRESETS.custom.portalIpFallback },
  paths: { ...PRESETS.custom.paths },
  fields: { ...PRESETS.custom.fields },
  domain: 'default',
  auth: 'auto',
  successCode: 0,
  usernames: [],
  ssids: [...PRESETS.custom.ssids],
  fallbackSsids: [...PRESETS.custom.fallbackSsids],
  // 已连上收费网络（chinanet / cmcc / unicom）时，主动切回配置的免费校园网。
  preferCampusOverPaid: true,
  onlineProbe: PRESETS.custom.onlineProbe,
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

function sanitizeId(raw, fallback) {
  const id = asString(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return id || fallback
}

function applyIntRanges(target, keys = Object.keys(INT_RANGES)) {
  for (const key of keys) {
    const [min, max] = INT_RANGES[key]
    const value = Number(target[key])
    target[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key]
  }
}

/** 洗一个校园网方案（一个学校 / 一套门户 + Wi-Fi 配置）。 */
export function normalizeProfile(raw = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const presetName = PRESETS[source.preset] ? source.preset : 'custom'
  const preset = PRESETS[presetName]
  const picked = {}
  for (const key of [...PROFILE_DATA_KEYS, 'id', 'name']) {
    if (source[key] !== undefined) picked[key] = source[key]
  }
  const cfg = deepMerge(
    {
      preset: presetName,
      portal: preset.portal,
      portalIpFallback: { ...preset.portalIpFallback },
      paths: { ...preset.paths },
      fields: { ...preset.fields },
      domain: preset.domain,
      auth: preset.auth,
      successCode: preset.successCode,
      usernames: [],
      ssids: [...preset.ssids],
      fallbackSsids: [...preset.fallbackSsids],
      preferCampusOverPaid: true,
      onlineProbe: preset.onlineProbe,
      onlineStatus: preset.onlineStatus,
    },
    picked,
  )
  cfg.id = sanitizeId(source.id, presetName)
  cfg.name = asString(source.name, preset.label || '我的校园网').slice(0, 60)
  cfg.portal = asString(cfg.portal, '').replace(/\/+$/, '')
  if (cfg.portal && !/^https?:\/\//i.test(cfg.portal)) cfg.portal = 'http://' + cfg.portal
  cfg.paths = deepMerge(preset.paths, isPlainObject(cfg.paths) ? cfg.paths : {})
  for (const key of Object.keys(preset.paths)) {
    const value = asString(cfg.paths[key])
    cfg.paths[key] = value.startsWith('/') ? value : '/' + value
  }
  cfg.fields = deepMerge(preset.fields, isPlainObject(cfg.fields) ? cfg.fields : {})
  cfg.portalIpFallback = isPlainObject(cfg.portalIpFallback)
    ? { ip: asString(cfg.portalIpFallback.ip), host: asString(cfg.portalIpFallback.host) }
    : { ip: '', host: '' }
  cfg.usernames = asStringList(cfg.usernames)
  cfg.ssids = asStringList(cfg.ssids)
  cfg.fallbackSsids = asStringList(cfg.fallbackSsids)
  cfg.preferCampusOverPaid = cfg.preferCampusOverPaid !== false
  cfg.onlineProbe = asString(cfg.onlineProbe, preset.onlineProbe)
  cfg.domain = asString(cfg.domain, preset.domain)
  cfg.auth = ['auto', 'json', 'chap'].includes(cfg.auth) ? cfg.auth : 'auto'
  applyIntRanges(cfg, ['successCode', 'onlineStatus'])
  return cfg
}

/** 把任意来源的配置洗成可信形状；v1 的单方案配置会自动迁移成 profiles[0]。 */
export function normalizeConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const list = Array.isArray(source.profiles) && source.profiles.length ? source.profiles : [source]
  const profiles = list.map((item) => normalizeProfile(item))
  const seen = new Set()
  for (const profile of profiles) {
    let id = profile.id
    let n = 2
    while (seen.has(id)) id = profile.id + '-' + n++
    profile.id = id
    seen.add(id)
  }
  const activeProfile = profiles.some((profile) => profile.id === source.activeProfile)
    ? source.activeProfile
    : profiles.some((profile) => profile.id === source.preset)
      ? profiles.find((profile) => profile.id === source.preset).id
      : profiles[0].id
  const active = profiles.find((profile) => profile.id === activeProfile)
  const globals = deepMerge(
    Object.fromEntries(GLOBAL_KEYS.map((key) => [key, DEFAULTS[key]])),
    Object.fromEntries(GLOBAL_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
  )
  applyIntRanges(globals, GLOBAL_KEYS.filter((key) => INT_RANGES[key]))
  globals.logOnline = Boolean(globals.logOnline)
  globals.autoConnectWhenOffline = globals.autoConnectWhenOffline !== false
  globals.autoOpenGuide = globals.autoOpenGuide !== false
  return { ...globals, ...active, profiles, activeProfile }
}

function readRaw() {
  ensureHome()
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

/** 组装真正落盘的结构：方案列表 + 当前方案 + 全局设置（不重复存扁平字段）。 */
function toStore(cfg) {
  const store = { version: 2, activeProfile: cfg.activeProfile }
  store.profiles = cfg.profiles.map((profile) => {
    const copy = {}
    for (const key of PROFILE_DATA_KEYS) copy[key] = profile[key]
    return copy
  })
  for (const key of GLOBAL_KEYS) store[key] = cfg[key]
  return store
}

function writeStore(store) {
  ensureHome()
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, CONFIG_PATH)
  return normalizeConfig(store)
}

export function loadConfig() {
  return normalizeConfig(readRaw())
}

/** 原子写入。方案字段写进当前方案，全局字段写进顶层；返回扁平视图。 */
export function saveConfig(patch = {}) {
  const cfg = loadConfig()
  const profilePatch = {}
  const globalPatch = {}
  for (const key of PROFILE_DATA_KEYS) {
    if (patch[key] !== undefined) profilePatch[key] = patch[key]
  }
  for (const key of GLOBAL_KEYS) {
    if (patch[key] !== undefined) globalPatch[key] = patch[key]
  }
  if (patch.activeProfile) cfg.activeProfile = String(patch.activeProfile)
  if (Object.keys(profilePatch).length) {
    cfg.profiles = cfg.profiles.map((profile) =>
      profile.id === cfg.activeProfile ? normalizeProfile({ ...profile, ...profilePatch }) : profile,
    )
  }
  Object.assign(cfg, globalPatch)
  return writeStore(toStore(cfg))
}

/** 切换预设：只覆盖当前方案的预设字段，保留账号、间隔等用户设置。 */
export function applyPreset(name) {
  const preset = PRESETS[name]
  if (!preset) throw new Error('未知的门户预设：' + name)
  const { label, ...values } = preset
  return saveConfig({ ...values, name: label })
}

function uniqueId(cfg, base) {
  let id = sanitizeId(base, 'profile')
  let n = 2
  while (cfg.profiles.some((profile) => profile.id === id)) id = base + '-' + n++
  return id
}

/** 新建一个校园网方案并切换过去。 */
export function createProfile({ name, preset = 'custom' } = {}) {
  const cfg = loadConfig()
  const presetName = PRESETS[preset] ? preset : 'custom'
  const label = asString(name, '我的校园网 ' + (cfg.profiles.length + 1)).slice(0, 60)
  const id = uniqueId(cfg, presetName)
  const profile = normalizeProfile({ preset: presetName, id, name: label })
  cfg.profiles.push(profile)
  cfg.activeProfile = id
  return writeStore(toStore(cfg))
}

export function selectProfile(id) {
  const cfg = loadConfig()
  if (!cfg.profiles.some((profile) => profile.id === id)) throw new Error('方案不存在：' + id)
  cfg.activeProfile = id
  return writeStore(toStore(cfg))
}

export function renameProfile(id, name) {
  const cfg = loadConfig()
  const next = asString(name).slice(0, 60)
  if (!next) throw new Error('方案名称不能为空')
  cfg.profiles = cfg.profiles.map((profile) => (profile.id === id ? { ...profile, name: next } : profile))
  return writeStore(toStore(cfg))
}

/** 删除方案；至少保留一个，删的是当前方案时自动切到第一个。 */
export function removeProfile(id) {
  const cfg = loadConfig()
  if (cfg.profiles.length <= 1) throw new Error('至少要保留一个方案')
  cfg.profiles = cfg.profiles.filter((profile) => profile.id !== id)
  if (!cfg.profiles.some((profile) => profile.id === cfg.activeProfile)) {
    cfg.activeProfile = cfg.profiles[0].id
  }
  return writeStore(toStore(cfg))
}
