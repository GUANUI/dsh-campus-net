/**
 * 使用指南页。由设置页的本地服务提供（/guide），也可以在首次加载时直接打开。
 * 内容和设置页共用同一套样式，不依赖任何外部资源，断网也能看。
 */
export function renderGuide(token = '') {
  const settingsHref = token ? '/?token=' + encodeURIComponent(token) : '/'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>校园网自动登录 · 使用指南</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --ok:#16a34a; --bad:#dc2626; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 56px; }
  h1 { font-size:22px; margin:0 0 6px; }
  .sub { color:var(--muted); margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 10px; }
  .steps { margin:0; padding-left:20px; }
  .steps li { margin:8px 0; }
  code { background:#f3f4f6; border-radius:4px; padding:1px 5px; font-size:13px; }
  .btn { display:inline-block; background:var(--brand); color:#fff; text-decoration:none; padding:9px 16px; border-radius:8px; font-size:14px; }
  .btn.ghost { background:#fff; color:var(--text); border:1px solid var(--line); }
  .muted { color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:6px; }
  th, td { text-align:left; border-bottom:1px solid var(--line); padding:8px 6px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  .tip { border-left:3px solid var(--brand); background:#eff6ff; padding:10px 12px; border-radius:6px; font-size:13px; margin:12px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>校园网自动登录 · 使用指南</h1>
  <div class="sub">装一次，之后不用管。下面按“第一次用”到“出问题”的顺序写。</div>

  <div class="card">
    <h2>第一次使用（5 步，约 2 分钟）</h2>
    <ol class="steps">
      <li><b>选校园 Wi-Fi</b>。打开设置页，点“扫描附近的 Wi-Fi”，勾选你学校的校园网（南审免费的是 <code>i-NAU</code> 或 <code>i-NAU-Lib</code>）。
        <div class="muted">带“收费”标记的是 chinanet / cmcc / unicom，插件不会自动连，也不会在它们上面认证。</div></li>
      <li><b>填学号和密码</b>，点“保存账号密码”。
        <div class="muted">密码用 Windows DPAPI 加密，只存在本机，不会上传。</div></li>
      <li><b>点“立即登录”</b>。状态变成“在线”就说明配置正确。</li>
      <li><b>点“开启自启”</b>。之后开机自动运行守护，DSH 关着也生效。</li>
      <li><b>不用再管</b>。掉线后守护每 10 秒重试；密码错误只试一次，不会把账号锁住。</li>
    </ol>
    <p style="margin:14px 0 0"><a class="btn" href="${settingsHref}">打开设置页</a></p>
  </div>

  <div class="card">
    <h2>页面关掉了，去哪找</h2>
    <table>
      <tr><th>方式</th><th>说明</th></tr>
      <tr><td>在 DSH 里说一句</td><td>“打开校园网设置”或“帮我连校园网”，agent 会重新给你一个带临时 token 的链接。</td></tr>
      <tr><td>再打开一次本指南</td><td>如果桌面有“校园网设置”快捷方式，双击即可。</td></tr>
      <tr><td>浏览器历史</td><td>本次 DSH 运行期间有效；DSH 重启后旧链接会失效。</td></tr>
    </table>
    <div class="tip">日常其实不需要页面：开过自启后，守护在后台自己登录。页面只用来改配置和看状态。</div>
  </div>

  <div class="card">
    <h2>多个校园网方案（可选）</h2>
    <p style="margin:0 0 8px">设置页顶部的“校园网方案”可以保存多套配置，例如：南审、实习学校、家里另一所学校。每个方案都有自己的门户地址、Wi-Fi 和账号密码，互不影响。</p>
    <p style="margin:0" class="muted">守护进程只使用当前选中的方案。切换方案后，下一轮重试就会按新方案登录；想回到原来的学校，在下拉框里切回去即可。</p>
  </div>

  <div class="card">
    <h2>常见问题</h2>
    <table>
      <tr><th>现象</th><th>怎么办</th></tr>
      <tr><td>扫描时提示需要位置权限</td><td>Windows 11 读取 Wi-Fi 列表需要位置权限：设置 → 隐私和安全性 → 位置，打开“位置服务”和“让桌面应用访问位置”，回来再扫。不想开权限就手动填 SSID，登录照样能用。</td></tr>
      <tr><td>不知道哪个是校园网</td><td>设置页点“扫描附近的 Wi-Fi”，名字里带学校缩写的通常是（南审是 <code>i-NAU</code>）；标“收费”的是运营商网络，不要选。也可以问学长或看学校通知。</td></tr>
      <tr><td>一直显示离线</td><td>先确认勾选的是免费校园网而不是收费网络；再看设置页“最近错误”。</td></tr>
      <tr><td>登录失败：请重新获取地址</td><td>门户看到的不是校园网地址。退出游戏加速器 / 全局代理，或给门户 IP 加直连路由后重试。</td></tr>
      <tr><td>登录失败：账号或密码错误</td><td>密码只试一次就停，不会锁号。确认密码后重新保存，再点“立即登录”。</td></tr>
      <tr><td>能上网但状态显示离线</td><td>可能走的是代理或收费网络。插件只认门户的 204 探测；先切回免费校园网。</td></tr>
      <tr><td>开机没有自动运行</td><td>设置页点“开启自启”，或让 DSH 执行 <code>campus_net_daemon { "action": "install" }</code>。</td></tr>
      <tr><td>想彻底卸载</td><td>先 <code>campus_net_daemon { "action": "uninstall" }</code>，再从插件市场卸载，最后删掉 <code>%LOCALAPPDATA%\\dsh-campus-net</code>。</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>它做了什么 / 不做什么</h2>
    <p style="margin:0 0 8px">每 10 秒探测一次网络；离线时先连配置里的免费 Wi-Fi，再向学校门户提交账号密码；成功后继续守护，掉线重连。</p>
    <p style="margin:0" class="muted">只支持“POST JSON + <code>reply_code</code>”这类门户（南审的 <code>/api/portal/v1/*</code>）。深澜 Srun、Dr.COM 协议不同，暂不支持。其他学校可在设置页选“自定义 JSON 门户”，手填门户地址和接口路径。</p>
  </div>

  <div class="card">
    <h2>隐私</h2>
    <p style="margin:0">账号密码只保存在本机，DPAPI 加密（非 Windows 用 AES-256-GCM）；日志不含密码；插件不向任何第三方服务器发送数据，只访问你配置的学校门户和在线探测地址。</p>
  </div>

  <p class="muted">遇到指南没覆盖的问题，去 GitHub 仓库提 issue：github.com/GUANUI/dsh-campus-net</p>
</div>
</body>
</html>`
}
