/**
 * 使用指南页（/guide）。设置页顶部有入口，卸载/重装插件后也能从这里重新看。
 * 内容要跟 lib/daemon.js 的三层自启保持一致：改了自启逻辑，记得同步这一页。
 */
export function renderGuide(token = '') {
  const openLink = token
    ? '<a class="btn" href="/?token=' + token + '">打开设置页</a>'
    : '<span class="muted">打开设置页：在 DSH 里运行 <code>campus_net_setup</code>，或点设置页右上角的“使用指南”。</span>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>校园网自动登录 · 使用指南</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2328; background: #f6f7f9; }
  main { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  .sub { color: #6a737d; margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 18px 20px; margin: 12px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .btn { display: inline-block; background: #1f6feb; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; }
  code { background: #eef1f4; padding: 1px 6px; border-radius: 5px; font-size: 13px; }
  ol, ul { padding-left: 22px; margin: 8px 0; }
  li { margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eceff2; vertical-align: top; }
  th { color: #57606a; font-weight: 600; }
  .muted { color: #6a737d; font-size: 13px; }
  .tip { background: #fff8e6; border: 1px solid #f0d9a8; border-radius: 10px; padding: 10px 14px; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>校园网自动登录 · 使用指南</h1>
  <p class="sub">南京审计大学预设 · 插件在本机跑一个守护进程，断网自动连、登录后自动认证。${openLink}</p>

  <h2>第一次用：五步</h2>
  <div class="card">
    <ol>
      <li>在设置页点“扫描 Wi-Fi”，勾选 <code>i-NAU</code>（免费）和 <code>i-NAU-Lib</code>（图书馆）。<code>chinanet / cmcc / unicom</code> 是收费网，不要勾。</li>
      <li>填学号和密码，点“保存账号密码”（Windows 下用 DPAPI 加密存在本机，不是明文）。</li>
      <li>门户地址保持 <code>http://login.nau.edu.cn</code>；换学校就在“预设”里改成自定义再填。</li>
      <li>点“保存配置”。</li>
      <li>点“开启开机自启”，再点“启动守护”。</li>
    </ol>
    <p class="muted">连着手机热点、家里路由器或收费网络时，只要附近有信号 ≥40% 的校园网，守护会自动切回去登录；切过去登不上会自动切回原网络，不会把你断网。</p>
  </div>

  <h2>开机自启有三层，缺一层都可能“开机没自动连”</h2>
  <div class="card">
    <table>
      <tr><th>层</th><th>做什么</th><th>被谁破坏</th></tr>
      <tr><td>计划任务 <code>DSH CampusNet Watchdog</code></td><td>登录 Windows 时拉起看门狗；被结束后 1 分钟重启 3 次</td><td>少数安全软件会禁用未知任务</td></tr>
      <tr><td>启动文件夹 <code>dsh-campus-net.vbs</code></td><td>第二重入口，登录时同样拉起看门狗</td><td>基本不会被搬走（联想只管 Run 键）</td></tr>
      <tr><td>看门狗自己</td><td>每 20 秒看一次守护心跳，超过 30 秒没更新就重启守护；发现计划任务被删就自己重建</td><td>被任务管理器一起结束</td></tr>
    </table>
    <p class="muted">另外守护每 60 秒反向检查看门狗，插件加载时也会自检一次；所以任意一层活着，整套就能自己恢复。Run 键只是第三重备份——被联想电脑管家搬进 <code>Run\\LenovoDisabled</code> 是正常的，不影响自启。</p>
  </div>

  <h2>开机后没有自动连？按这个顺序查</h2>
  <div class="card">
    <ol>
      <li>先确认不是在锁屏界面：Windows 要等用户登录后才触发计划任务和启动文件夹，锁屏时连不上是正常的。</li>
      <li>在 DSH 里运行 <code>campus_net_status</code>，看“守护进程”和“开机自启”两行。</li>
      <li>运行 <code>campus_net_daemon { "action": "repair" }</code>。它会补齐三层自启、拉起守护和看门狗，最后回报现状。</li>
      <li>还不行就打开“任务计划程序”，找 <code>DSH CampusNet Watchdog</code>：被禁用就右键启用；被删了上一步会重建。</li>
      <li>Run 键里没有 <code>DSHCampusNet</code> 是正常的，联想会把它搬走，不影响另外两层。</li>
      <li>三层都没了（重装系统、换用户、安全软件清理），跑一次 repair 就够。</li>
      <li>要看具体原因，打开日志：<code>%LOCALAPPDATA%\\dsh-campus-net\\campus-net.log</code>，最后几行一般就写着失败原因。</li>
    </ol>
    <p class="tip">自检最快的办法：手动断开 Wi-Fi 再连上，或直接关掉 Wi-Fi 30 秒。守护应在 10–20 秒内连回校园网并登录。</p>
  </div>

  <h2>常见问题</h2>
  <div class="card">
    <table>
      <tr><th>现象</th><th>怎么办</th></tr>
      <tr><td>提示“免费校园网不在范围内”</td><td>扫描没看到 i-NAU。走到有信号的地方，或在设置页重新扫描勾选。</td></tr>
      <tr><td>连着收费网（chinanet / cmcc）不动</td><td>确认设置页“优先校园网”是勾上的，并且附近有 i-NAU 信号 ≥40%。</td></tr>
      <tr><td>密码错误</td><td>插件不会重试错误密码（避免锁号）。去设置页重填，或用 <code>campus_net_login</code> 手动试一次。</td></tr>
      <tr><td>门户改版 / 换了学校</td><td>设置页把“预设”改成自定义，按学校门户的字段名填路径；不认识的字段保持默认。</td></tr>
      <tr><td>开机没有自动运行</td><td>先跑 <code>campus_net_daemon { "action": "repair" }</code>，再按上面的七步查。</td></tr>
      <tr><td>想彻底关掉</td><td><code>campus_net_daemon { "action": "uninstall" }</code>：删除计划任务、启动文件夹、Run 键并停止守护。</td></tr>
    </table>
  </div>

  <p class="muted">日志：<code>%LOCALAPPDATA%\\dsh-campus-net\\campus-net.log</code> · 设置页只监听 127.0.0.1，带一次性 token，关掉插件后链接失效。</p>
</main>
</body>
</html>`
}
