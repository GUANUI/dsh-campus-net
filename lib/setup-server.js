import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  createProfile,
  loadConfig,
  PRESETS,
  removeProfile,
  renameProfile,
  saveConfig,
  selectProfile,
} from './config.js'
import { deleteCred, loadCred, saveCred } from './creds.js'
import { loginOnce, overview, readTail } from './engine.js'
import { daemonStatus, installAutostart, removeAutostart, startDaemon, stopDaemon } from './daemon.js'
import { renderGuide } from './guide.js'
import { savedWifiProfiles, scanWifi, wifiStatus } from './network.js'

/**
 * 本地设置页：只监听 127.0.0.1，带一次性 token，不对外网开放。
 * 这是插件的“设置界面”——DSH 插件本身没有浏览器端 bundle，
 * 所以在 DSH 里点工具会打开这个页面。
 */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>校园网自动登录 · 设置</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --ok:#16a34a; --bad:#dc2626; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 48px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 12px; display:flex; align-items:center; gap:8px; }
  .badge { font-size:12px; padding:1px 8px; border-radius:999px; background:#eef2ff; color:var(--brand); font-weight:500; }
  .badge.ok { background:#ecfdf5; color:var(--ok); }
  .badge.bad { background:#fef2f2; color:var(--bad); }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > * { flex:1 1 220px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; background:#fff; }
  input:focus, select:focus { outline:2px solid #bfdbfe; border-color:var(--brand); }
  .hint { font-size:12px; color:var(--muted); margin-top:4px; }
  label.check { display:flex; align-items:center; gap:8px; margin:12px 0 2px; color:var(--text); font-size:13px; }
  label.check input { width:auto; margin:0; }
  button { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#fff; font:inherit; cursor:pointer; }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  button.danger { color:var(--bad); border-color:#fecaca; }
  button:disabled { opacity:.55; cursor:default; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
  .kv { display:grid; grid-template-columns:120px 1fr; gap:6px 10px; font-size:13px; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; word-break:break-all; }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#111827; color:#fff; padding:9px 16px; border-radius:999px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:.95; }
  pre { background:#0f172a; color:#e2e8f0; padding:12px; border-radius:8px; font-size:12px; overflow:auto; max-height:240px; margin:10px 0 0; }
  .steps { margin:0; padding-left:20px; font-size:13px; }
  .steps li { margin:6px 0; }
  .steps b { font-weight:600; }
  .warn { display:none; margin-top:12px; padding:10px 12px; border:1px solid #f0c36d; background:#fffbeb; color:#8a5a00; border-radius:8px; font-size:13px; }
  .warn.show { display:block; }
  .wifi-list { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
  .wifi-item { display:flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:13px; cursor:pointer; background:#fff; }
  .wifi-item.cur { border-color:var(--brand); background:#eff6ff; }
  .wifi-item input { width:auto; margin:0; }
  .wifi-item .sig { color:var(--muted); font-size:12px; }
  .wifi-item .tag { font-size:11px; padding:0 6px; border-radius:999px; background:#f3f4f6; color:var(--muted); }
  .wifi-item .tag.paid { background:#fef2f2; color:var(--bad); }
</style>
</head>
<body>
<div class="wrap">
  <h1>校园网自动登录</h1>
  <div class="sub">本页只监听 127.0.0.1，关闭后需重新从 DSH 打开。凭据经过系统加密，不会显示在这里。 · <a id="guide-link" href="/guide" style="color:var(--brand)">使用指南</a></div>

  <div class="card">
    <h2>使用步骤</h2>
    <ol class="steps">
      <li><b>选校园 Wi-Fi</b>：在下面点“扫描附近的 Wi-Fi”，勾选你学校的校园网（南审免费的是 <code>i-NAU</code> 或 <code>i-NAU-Lib</code>）。<br>
          <span class="hint">chinanet / cmcc / unicom 是运营商收费网络，插件不会自动连接。</span></li>
      <li><b>填学号密码</b>，点“保存账号密码”。密码只存在本机（DPAPI 加密），不会上传。</li>
      <li><b>点“立即登录”</b>：状态变成“在线”就说明配置正确。</li>
      <li><b>点“开启自启”</b>：以后开机自动拉起守护，DSH 关着也生效。</li>
      <li>掉线后守护每 10 秒重试；<b>密码错误只试一次</b>，不会反复试导致锁号。</li>
    </ol>
  </div>

  <div class="card">
    <h2>校园网方案 <span class="badge" id="profileBadge"></span></h2>
    <div class="row">
      <div><label for="profile">当前使用</label><select id="profile"></select></div>
      <div style="flex:0 0 auto; display:flex; align-items:flex-end; gap:8px">
        <button id="btn-profile-add">新建</button>
        <button id="btn-profile-rename">重命名</button>
        <button id="btn-profile-del" class="danger">删除</button>
      </div>
    </div>
    <div class="hint">可以保存多个校园网（例如学校、实习单位），守护只使用当前选中的方案；每个方案的账号密码分开保存。</div>
  </div>

  <div class="card">
    <h2>当前状态 <span id="statusBadge" class="badge">读取中</span></h2>
    <dl class="kv">
      <dt>在线状态</dt><dd id="s-online">-</dd>
      <dt>Wi-Fi</dt><dd id="s-wifi">-</dd>
      <dt>守护进程</dt><dd id="s-daemon">-</dd>
      <dt>当前账号</dt><dd id="s-user">-</dd>
      <dt>最近动作</dt><dd id="s-action">-</dd>
      <dt>最近错误</dt><dd id="s-error">-</dd>
    </dl>
    <div id="paid-warn" class="warn">当前连接的是运营商收费网络，校园网认证不适用。请先切到 <b>i-NAU</b> 或 <b>i-NAU-Lib</b>。</div>
    <div class="actions">
      <button id="btn-login" class="primary">立即登录</button>
      <button id="btn-daemon-start">启动守护</button>
      <button id="btn-daemon-stop" class="danger">停止守护</button>
    </div>
  </div>

  <div class="card">
    <h2>账号密码</h2>
    <div class="row">
      <div><label for="username">账号（学号/手机号）</label><input id="username" autocomplete="username" placeholder="学号或手机号"></div>
      <div><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" placeholder="留空则不修改"></div>
    </div>
    <div class="hint">密码使用 Windows DPAPI（或 AES-256-GCM）加密保存，只有当前用户能解开。</div>
    <div class="actions"><button id="btn-save-cred" class="primary">保存账号密码</button></div>
  </div>

  <div class="card">
    <h2>门户配置 <span class="badge" id="presetBadge"></span></h2>
    <div class="row">
      <div><label for="preset">预设</label><select id="preset"><option value="nau">南京审计大学</option><option value="custom">自定义 JSON 门户</option></select></div>
      <div><label for="portal">门户地址</label><input id="portal" placeholder="http://login.nau.edu.cn"></div>
    </div>
    <div class="row">
      <div><label for="interval">检查间隔（秒）</label><input id="interval" type="number" min="5" max="3600"></div>
      <div><label for="auth">认证方式</label><select id="auth"><option value="auto">自动（JSON 失败后试 CHAP）</option><option value="json">仅 JSON</option><option value="chap">仅 CHAP</option></select></div>
    </div>
    <div class="row">
      <div><label for="usernames">备用账号（逗号分隔，可留空）</label><input id="usernames" placeholder="手机号等"></div>
      <div></div>
    </div>

    <label>校园 Wi-Fi（勾选哪个是校园网）</label>
    <div class="hint" id="wifi-current">当前连接：-</div>
    <div class="actions" style="margin-top:8px"><button id="btn-scan">扫描附近的 Wi-Fi</button></div>
    <div id="wifi-list" class="wifi-list"><span class="hint">点“扫描”列出附近网络，再勾选你的校园网。</span></div>
    <div id="wifi-note" class="hint"></div>
    <div class="actions" id="loc-actions" style="display:none"><button id="btn-location">打开 Windows 位置设置</button></div>
    <details style="margin-top:10px">
      <summary class="hint" style="cursor:pointer">列表里没有？手动填写 SSID</summary>
      <input id="ssids" placeholder="i-NAU, i-NAU-Lib" style="margin-top:8px">
    </details>
    <div class="hint">勾选多个会依次尝试；收费网络（chinanet / cmcc / unicom）不会自动连接。</div>
    <label class="check"><input type="checkbox" id="prefer-campus"> 优先校园网：连着手机热点、家里路由器或收费网络时，扫描到校园网就自动切回去</label>
    <div class="hint">开着这个开关时，如果电脑挂在 chinanet / cmcc / unicom 上，守护会主动连回上面勾选的校园网；连不上就保持原网络，不会把你断网。</div>
    <div class="hint">自定义门户需要和南审一样是“POST JSON + reply_code”接口；深澜 / Dr.COM 等协议不同，暂不支持。</div>
    <div class="actions"><button id="btn-save-config" class="primary">保存配置</button></div>
  </div>

  <div class="card">
    <h2>开机自启</h2>
    <div class="hint">在启动文件夹放一个隐藏启动项，登录 Windows 后自动拉起守护，不依赖 DSH 是否打开。</div>
    <div class="actions">
      <button id="btn-auto-on">开启自启</button>
      <button id="btn-auto-off" class="danger">关闭自启</button>
    </div>
  </div>

  <div class="card">
    <h2>最近日志</h2>
    <pre id="logs">加载中…</pre>
    <div class="actions"><button id="btn-refresh">刷新</button></div>
  </div>
</div>
<div id="toast"></div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const guideLink = document.getElementById('guide-link');
if (guideLink) guideLink.href = '/guide?token=' + encodeURIComponent(token);
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CN-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '-'; }
let scanned = [];
function selectedSsids() {
  return document.getElementById('ssids').value.split(/[,，\\s]+/).filter(Boolean);
}
function renderWifi() {
  const list = document.getElementById('wifi-list');
  const selected = new Set(selectedSsids());
  if (!scanned.length) {
    list.innerHTML = '<span class="hint">点“扫描”列出附近网络，再勾选你的校园网。</span>';
    return;
  }
  list.innerHTML = '';
  for (const n of scanned) {
    const label = document.createElement('label');
    label.className = 'wifi-item' + (n.current ? ' cur' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(n.ssid);
    cb.value = n.ssid;
    cb.onchange = () => {
      const next = new Set(selectedSsids());
      if (cb.checked) next.add(n.ssid); else next.delete(n.ssid);
      document.getElementById('ssids').value = [...next].join(', ');
      renderWifi();
    };
    label.appendChild(cb);
    label.appendChild(document.createTextNode(n.ssid));
    const sig = document.createElement('span');
    sig.className = 'sig';
    sig.textContent = n.signal ? n.signal + '%' : '';
    label.appendChild(sig);
    if (n.current) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '当前连接';
      label.appendChild(tag);
    }
    if (n.paid) {
      const tag = document.createElement('span');
      tag.className = 'tag paid';
      tag.textContent = '收费';
      label.appendChild(tag);
    }
    list.appendChild(label);
  }
}
document.getElementById('btn-scan').onclick = async (event) => {
  const button = event.target;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '扫描中…';
  try {
    const data = await api('/api/scan');
    const networks = data.networks || [];
    const candidates = networks.length
      ? networks
      : (data.profiles || []).map((ssid) => ({ ssid, signal: 0, paid: /chinanet|cmcc|unicom/i.test(ssid) }));
    scanned = candidates.map((n) => ({ ...n, current: n.ssid === data.current }));
    const note = document.getElementById('wifi-note');
    const loc = document.getElementById('loc-actions');
    if (data.reason === 'location') {
      note.textContent = 'Windows 没开位置权限，扫不到附近网络。下面是本机保存过的 Wi-Fi，勾选即可；要列出附近网络，点“打开 Windows 位置设置”。';
      loc.style.display = 'flex';
    } else if (!networks.length) {
      note.textContent = data.profiles && data.profiles.length
        ? '没有扫到附近网络，下面是本机保存过的 Wi-Fi，勾选即可。'
        : '没有扫描到网络。可以先手动连一次校园网（之后会出现在保存过的列表），或展开下方手动填写。';
      loc.style.display = 'none';
    } else {
      note.textContent = '';
      loc.style.display = 'none';
    }
    renderWifi();
    toast(networks.length ? '扫描到 ' + networks.length + ' 个网络' : (data.profiles || []).length ? '已列出保存过的 Wi-Fi' : '没有扫描到网络，可展开手动填写');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};
document.getElementById('btn-location').onclick = async (event) => {
  try {
    const r = await api('/api/location-settings', {});
    toast(r.message || '已打开位置设置');
  } catch (error) {
    toast(error.message);
  }
};
function renderProfiles(cfg) {
  const sel = document.getElementById('profile');
  const list = cfg.profiles || [];
  sel.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    sel.appendChild(opt);
  }
  sel.value = cfg.activeProfile || (list[0] && list[0].id) || '';
  const active = list.find((p) => p.id === sel.value);
  document.getElementById('profileBadge').textContent = active ? active.name : '';
}
async function refresh() {
  const data = await api('/api/state');
  const on = data.online;
  const badge = document.getElementById('statusBadge');
  badge.textContent = on ? '在线' : '离线';
  badge.className = 'badge ' + (on ? 'ok' : 'bad');
  document.getElementById('s-online').textContent = on ? '在线（HTTP ' + data.probe.status + '）' : '离线 · ' + data.probe.detail;
  document.getElementById('s-wifi').textContent = data.wifi.restricted
    ? '无法读取（Windows 位置权限未开）'
    : (data.wifi.ssid ? data.wifi.ssid + ' · ' + (data.wifi.state || '') : '未连接');
  document.getElementById('paid-warn').classList.toggle('show', /chinanet|cmcc|unicom/i.test(data.wifi.ssid || ''));
  document.getElementById('s-daemon').textContent = data.daemon.running
    ? '运行中' + (data.daemon.pid ? '（PID ' + data.daemon.pid + '）' : '')
    : (data.daemon.autostart ? '未运行（已设自启）' : '未运行');
  document.getElementById('s-user').textContent = data.state.currentUsername || '-';
  document.getElementById('s-action').textContent = (data.state.lastAction || '-') + (data.state.lastActionAt ? ' · ' + fmt(data.state.lastActionAt) : '');
  document.getElementById('s-error').textContent = data.state.lastError || '无';
  const cfg = data.config;
  renderProfiles(cfg);
  document.getElementById('preset').value = ['nau','custom'].includes(cfg.preset) ? cfg.preset : 'custom';
  document.getElementById('presetBadge').textContent = cfg.preset === 'nau' ? '南京审计大学' : '自定义';
  document.getElementById('portal').value = cfg.portal || '';
  document.getElementById('ssids').value = (cfg.ssids || []).join(', ');
  document.getElementById('prefer-campus').checked = cfg.preferCampusOverPaid !== false;
  document.getElementById('wifi-current').textContent = data.wifi.restricted
    ? '当前连接：无法读取（位置权限未开）'
    : data.wifi.ssid
      ? '当前连接：' + data.wifi.ssid + (data.wifi.state ? ' · ' + data.wifi.state : '')
      : '当前没有连接 Wi-Fi';
  renderWifi();
  document.getElementById('interval').value = cfg.intervalSeconds;
  document.getElementById('usernames').value = (cfg.usernames || []).join(', ');
  document.getElementById('auth').value = cfg.auth;
  document.getElementById('username').value = data.credUsername || '';
  document.getElementById('password').value = '';
  document.getElementById('logs').textContent = (data.logs || []).join('\\n') || '暂无日志';
}
async function run(button, fn, okText) {
  button.disabled = true;
  try { const r = await fn(); toast(r.message || okText || '完成'); await refresh(); }
  catch (e) { toast(e.message); }
  finally { button.disabled = false; }
}
document.getElementById('btn-refresh').onclick = () => run(document.getElementById('btn-refresh'), refresh, '已刷新');
document.getElementById('btn-login').onclick = (e) => run(e.target, () => api('/api/login', {}), '登录成功');
document.getElementById('btn-save-cred').onclick = (e) => run(e.target, async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) throw new Error('账号和密码都要填');
  const r = await api('/api/credentials', { username, password });
  document.getElementById('password').value = '';
  return r;
}, '已保存');
document.getElementById('btn-save-config').onclick = (e) => run(e.target, () => api('/api/config', {
  preset: document.getElementById('preset').value,
  portal: document.getElementById('portal').value,
  ssids: document.getElementById('ssids').value,
  intervalSeconds: Number(document.getElementById('interval').value),
  usernames: document.getElementById('usernames').value,
  auth: document.getElementById('auth').value,
  preferCampusOverPaid: document.getElementById('prefer-campus').checked,
}), '配置已保存');
document.getElementById('profile').onchange = (e) => run(e.target, () => api('/api/profile', { action: 'select', id: e.target.value }), '已切换方案');
document.getElementById('btn-profile-add').onclick = (e) => run(e.target, async () => {
  const name = prompt('新方案名称（例如：南京审计大学、实习单位）');
  if (!name) throw new Error('已取消');
  return api('/api/profile', { action: 'add', name });
}, '已新建方案');
document.getElementById('btn-profile-rename').onclick = (e) => run(e.target, async () => {
  const selected = document.getElementById('profile').selectedOptions[0];
  const name = prompt('新的方案名称', selected ? selected.textContent : '');
  if (!name) throw new Error('已取消');
  return api('/api/profile', { action: 'rename', id: document.getElementById('profile').value, name });
}, '已重命名');
document.getElementById('btn-profile-del').onclick = (e) => run(e.target, async () => {
  if (!confirm('删除当前方案？该方案的账号密码也会一起删除。')) throw new Error('已取消');
  return api('/api/profile', { action: 'remove', id: document.getElementById('profile').value });
}, '已删除');
document.getElementById('btn-daemon-start').onclick = (e) => run(e.target, () => api('/api/daemon', { action: 'start' }), '守护已启动');
document.getElementById('btn-daemon-stop').onclick = (e) => run(e.target, () => api('/api/daemon', { action: 'stop' }), '守护已停止');
document.getElementById('btn-auto-on').onclick = (e) => run(e.target, () => api('/api/daemon', { action: 'autostart-on' }), '已开启自启');
document.getElementById('btn-auto-off').onclick = (e) => run(e.target, () => api('/api/daemon', { action: 'autostart-off' }), '已关闭自启');
refresh().catch((e) => toast(e.message));
if (new URLSearchParams(location.search).has('scan')) {
  setTimeout(() => document.getElementById('btn-scan').click(), 1200);
}
setInterval(() => refresh().catch(() => {}), 10000);
</script>
</body>
</html>`

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 启动设置页；重复调用会先关掉上一个实例。
 * 返回 { url, port, close }。
 */
let current = null

export function startSetupServer(options = {}) {
  if (current) {
    try {
      current.close()
    } catch {
      // 忽略
    }
  }
  const token = crypto.randomBytes(16).toString('hex')
  let server = null
  let closed = false

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const supplied = String(req.headers['x-cn-token'] || url.searchParams.get('token') || '')
    const authorized =
      /^[0-9a-f]{32}$/i.test(supplied) &&
      crypto.timingSafeEqual(Buffer.from(supplied.toLowerCase(), 'utf8'), Buffer.from(token, 'utf8'))

    if (req.method === 'GET' && url.pathname === '/guide') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderGuide(authorized ? token : ''))
      return
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!authorized) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('链接无效或已过期，请从 DSH 重新打开设置页。')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(PAGE)
      return
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!authorized) {
      sendJson(res, 403, { error: '链接无效或已过期' })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/scan') {
        const [scan, current, profiles] = await Promise.all([scanWifi(), wifiStatus(), savedWifiProfiles()])
        sendJson(res, 200, {
          ...scan,
          profiles,
          current: current.ssid || '',
          restricted: Boolean(current.restricted),
          selected: loadConfig().ssids || [],
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/location-settings') {
        await new Promise((resolve) => {
          const child = spawn('cmd', ['/c', 'start', '', 'ms-settings:privacy-location'], {
            windowsHide: true,
            stdio: 'ignore',
            detached: true,
          })
          child.on('error', resolve)
          child.on('spawn', () => {
            child.unref()
            resolve()
          })
        })
        sendJson(res, 200, { ok: true, message: '已打开 Windows 位置设置' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const info = await overview()
        const daemon = await daemonStatus()
        const cfg = loadConfig()
        const cred = await loadCred()
        sendJson(res, 200, {
          online: info.online,
          probe: info.probe,
          wifi: info.wifi,
          state: info.state,
          daemon,
          credUsername: cred ? cred.username : '',
          config: {
            ...info.config,
            auth: cfg.auth,
            usernames: cfg.usernames,
            activeProfile: cfg.activeProfile,
            profiles: cfg.profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              preset: profile.preset,
            })),
          },
          logs: readTail(30),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/credentials') {
        const body = await readBody(req)
        if (!body.username || !body.password) throw new Error('账号和密码都要填')
        await saveCred(body.username, body.password)
        sendJson(res, 200, { ok: true, message: '账号密码已加密保存' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req)
        const patch = {}
        if (body.preset && PRESETS[body.preset]) patch.preset = body.preset
        if (typeof body.portal === 'string') patch.portal = body.portal
        if (typeof body.ssids === 'string') patch.ssids = body.ssids.split(/[,，\s]+/).filter(Boolean)
        if (body.intervalSeconds !== undefined) patch.intervalSeconds = Number(body.intervalSeconds)
        if (typeof body.usernames === 'string') patch.usernames = body.usernames.split(/[,，\s]+/).filter(Boolean)
        if (['auto', 'json', 'chap'].includes(body.auth)) patch.auth = body.auth
        if (typeof body.preferCampusOverPaid === 'boolean') patch.preferCampusOverPaid = body.preferCampusOverPaid
        await saveConfig(patch)
        sendJson(res, 200, { ok: true, message: '配置已保存' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const result = await loginOnce()
        sendJson(res, result.ok ? 200 : 500, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/profile') {
        const body = await readBody(req)
        const action = body.action
        const id = String(body.id || '')
        let result
        if (action === 'select') result = selectProfile(id)
        else if (action === 'add') result = createProfile({ name: body.name })
        else if (action === 'rename') result = renameProfile(id, body.name)
        else if (action === 'remove') {
          await deleteCred(id)
          result = removeProfile(id)
        } else throw new Error('未知操作')
        sendJson(res, 200, { ok: true, message: '方案已更新', activeProfile: result.activeProfile })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/daemon') {
        const body = await readBody(req)
        const action = body.action
        let result
        if (action === 'start') result = await startDaemon()
        else if (action === 'stop') result = await stopDaemon()
        else if (action === 'autostart-on') result = await installAutostart()
        else if (action === 'autostart-off') result = await removeAutostart()
        else throw new Error('未知操作')
        sendJson(res, result.ok ? 200 : 500, result)
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
    }
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port || 0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      resolve({ url: 'http://127.0.0.1:' + port + '/?token=' + token, port })
    })
  })

  const instance = {
    ready,
    close() {
      if (closed) return
      closed = true
      setImmediate(() => server.close())
      if (current === instance) current = null
    },
    get closed() {
      return closed
    },
  }
  current = instance
  return instance
}
