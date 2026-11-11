import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CRED_PATH, KEY_PATH, ensureHome } from './paths.js'

/**
 * 凭据加密：
 * - Windows：DPAPI（CurrentUser），只有同一台机器的同一用户能解开，不落明文。
 * - 其他平台：AES-256-GCM，密钥文件 0600。安全性不如系统钥匙串，但不会明文落盘。
 *
 * 明文只存在于进程内存里；它不会被写进日志、配置或工具返回值。
 */

function powershellPath() {
  if (process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return 'powershell.exe'
}

function runPowerShell(script, extraEnv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      powershellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...extraEnv },
      },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('DPAPI 调用超时'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error('DPAPI 调用失败：' + (stderr.trim() || 'exit code ' + code)))
    })
  })
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Security',
  '$bytes = [Convert]::FromBase64String($env:CN_CRED_B64)',
  "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
  '[Convert]::ToBase64String($protected)',
].join('\n')

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Security',
  '$bytes = [Convert]::FromBase64String($env:CN_CRED_B64)',
  "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
  '[Convert]::ToBase64String($plain)',
].join('\n')

async function dpapiProtect(plaintext) {
  const out = await runPowerShell(PROTECT_SCRIPT, {
    CN_CRED_B64: Buffer.from(plaintext, 'utf8').toString('base64'),
  })
  return out.replace(/^﻿/, '').trim()
}

async function dpapiUnprotect(encoded) {
  const out = await runPowerShell(UNPROTECT_SCRIPT, { CN_CRED_B64: encoded })
  return Buffer.from(out.replace(/^﻿/, '').trim(), 'base64').toString('utf8')
}

function loadKey() {
  ensureHome()
  if (fs.existsSync(KEY_PATH)) {
    const key = fs.readFileSync(KEY_PATH)
    if (key.length === 32) return key
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 })
  return key
}

function aesEncrypt(plaintext) {
  const key = loadKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    scheme: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function aesDecrypt(payload) {
  const key = loadKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const data = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()])
  return data.toString('utf8')
}

/** 解出文件里的明文对象；失败返回 null。 */
async function readPlain() {
  ensureHome()
  if (!fs.existsSync(CRED_PATH)) return null
  try {
    const payload = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))
    let plaintext
    if (payload.scheme === 'dpapi') {
      plaintext = await dpapiUnprotect(payload.data)
    } else if (payload.scheme === 'aes-256-gcm') {
      plaintext = aesDecrypt(payload)
    } else {
      return null
    }
    return JSON.parse(plaintext)
  } catch {
    return null
  }
}

async function writePlain(value) {
  ensureHome()
  const plaintext = JSON.stringify(value)
  let payload
  if (process.platform === 'win32') {
    payload = { v: 1, scheme: 'dpapi', data: await dpapiProtect(plaintext) }
  } else {
    payload = aesEncrypt(plaintext)
  }
  const tmp = CRED_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, CRED_PATH)
  try {
    fs.chmodSync(CRED_PATH, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位，失败不影响加密本身
  }
}

/** 兼容 v1（顶层 username/password）与 v2（profiles 映射）。 */
function toMap(plain, cfg) {
  if (plain && plain.profiles && typeof plain.profiles === 'object') {
    const map = {}
    for (const [id, value] of Object.entries(plain.profiles)) {
      if (value && typeof value.username === 'string' && typeof value.password === 'string') {
        map[id] = { username: value.username, password: value.password }
      }
    }
    return map
  }
  if (plain && typeof plain.username === 'string' && typeof plain.password === 'string') {
    const legacyId = (cfg.profiles && cfg.profiles[0] && cfg.profiles[0].id) || 'nau'
    return { [legacyId]: { username: plain.username, password: plain.password } }
  }
  return {}
}

import { loadConfig } from './config.js'

export async function saveCred(username, password, profileId) {
  if (!username || !password) throw new Error('账号和密码都不能为空')
  const cfg = loadConfig()
  const id = profileId || cfg.activeProfile
  const map = toMap(await readPlain(), cfg)
  map[id] = { username: String(username), password: String(password) }
  await writePlain({ version: 2, profiles: map })
  return true
}

export async function loadCred(profileId) {
  const cfg = loadConfig()
  const id = profileId || cfg.activeProfile
  const map = toMap(await readPlain(), cfg)
  const cred = map[id]
  if (!cred || typeof cred.username !== 'string' || typeof cred.password !== 'string') return null
  return { username: cred.username, password: cred.password }
}

export async function hasCred(profileId) {
  return (await loadCred(profileId)) !== null
}

export async function deleteCred(profileId) {
  const cfg = loadConfig()
  const id = profileId || cfg.activeProfile
  const map = toMap(await readPlain(), cfg)
  if (!map[id]) return false
  delete map[id]
  await writePlain({ version: 2, profiles: map })
  return true
}
