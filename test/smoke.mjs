import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = path.join(os.tmpdir(), 'cn-smoke-' + Date.now())
process.env.DSH_CAMPUS_NET_HOME = home

const { normalizeConfig, saveConfig, loadConfig, DEFAULTS } = await import('../lib/config.js')
const { buildCampusTools } = await import('../lib/tools.js')
const { startSetupServer } = await import('../lib/setup-server.js')
const { saveCred, loadCred } = await import('../lib/creds.js')
const { readTail } = await import('../lib/engine.js')

let passed = 0
function ok(name, condition) {
  assert.ok(condition, name)
  passed += 1
  console.log('  ✓ ' + name)
}

console.log('config')
const normalized = normalizeConfig({ intervalSeconds: 1, lockPort: 70000, auth: 'nope', ssids: [' i-NAU ', 'i-NAU'], portal: 'login.nau.edu.cn' })
ok('interval clamped to 5', normalized.intervalSeconds === 5)
ok('lockPort clamped to 65535', normalized.lockPort === 65535)
ok('bad auth falls back to auto', normalized.auth === 'auto')
ok('ssids deduped and trimmed', JSON.stringify(normalized.ssids) === JSON.stringify(['i-NAU']))
ok('portal without scheme falls back', normalized.portal === DEFAULTS.portal)

const saved = saveConfig({ usernames: ['20230001'], intervalSeconds: 12 })
ok('saveConfig persists', loadConfig().usernames[0] === '20230001' && loadConfig().intervalSeconds === 12)
ok('saveConfig keeps defaults', saved.portal === DEFAULTS.portal)

console.log('tools')
const tools = buildCampusTools()
ok('four tools', tools.length === 4)
ok('tool names', JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(['campus_net_status', 'campus_net_login', 'campus_net_setup', 'campus_net_daemon']))
ok('every tool has parameters/output/execute', tools.every((t) => t.parameters && t.output && t.output.schema && typeof t.output.render === 'function' && typeof t.execute === 'function'))
for (const tool of tools) {
  const rendered = tool.output.render({}, tool.name === 'campus_net_status'
    ? { online: true, probe: { detail: '在线' }, wifi: { ssid: 'i-NAU' }, daemon: { running: true, pid: 1, autostart: true }, state: {} }
    : tool.name === 'campus_net_login' ? { ok: true, username: '20230002' }
    : tool.name === 'campus_net_setup' ? { ok: true, url: 'http://127.0.0.1:1/?token=x' }
    : { ok: true, message: 'ok' })
  ok(tool.name + ' render returns text parts', Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.length > 0)
}

console.log('credentials (DPAPI)')
await saveCred('20230002', 'not-a-real-password')
const cred = await loadCred()
ok('credential round-trips', cred && cred.username === '20230002' && cred.password === 'not-a-real-password')
const raw = fs.readFileSync(path.join(home, 'cred.dat'), 'utf8')
ok('credential file is not plaintext', !raw.includes('not-a-real-password'))

console.log('settings server')
const server = startSetupServer()
const info = await server.ready
const page = await fetch(info.url)
const html = await page.text()
ok('page served', page.status === 200 && html.includes('校园网自动登录'))
const forbidden = await fetch(info.url.replace(/\?token=.*$/, '') + 'api/state')
ok('api rejects missing token', forbidden.status === 403)
const scanForbidden = await fetch(info.url.replace(/\?token=.*$/, '') + 'api/scan')
ok('scan rejects missing token', scanForbidden.status === 403)
const state = await fetch('http://127.0.0.1:' + info.port + '/api/state?token=' + new URL(info.url).searchParams.get('token'))
const stateValue = await state.json()
ok('api/state returns daemon block', state.status === 200 && stateValue.daemon && typeof stateValue.online === 'boolean')
const guideUrl = info.url.replace('/?token=', '/guide?token=')
const guide = await fetch(guideUrl)
const guideHtml = await guide.text()
ok('guide page served', guide.status === 200 && guideHtml.includes('使用指南') && guideHtml.includes('打开设置页'))
const anonGuide = await (await fetch(info.url.replace('/?token=', '/guide'))).text()
ok('guide hides settings token when not authorized', !/token=[0-9a-f]{32}/.test(anonGuide))
server.close()

console.log('logs')
ok('log tail readable', Array.isArray(readTail(5)))

fs.rmSync(home, { recursive: true, force: true })
console.log('\n' + passed + ' checks passed')
