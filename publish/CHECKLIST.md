# 发布清单（GitHub + DSH 插件市场）

本地代码已经完成并通过测试；下面只差一个公开 GitHub 仓库和一条市场 PR。
本机没有 git / gh，所以全部走网页操作。

## 0. 先准备

- 一个 GitHub 账号（没有就在 https://github.com/signup 注册，用户名会填进仓库地址）。
- 仓库必须是 **public**，且创建满 **1 天** 后才能提市场 PR。

## 1. 建仓库

1. 打开 https://github.com/new
2. Repository name 填 `dsh-campus-net`
3. 选 **Public**，不要勾 “Add a README file”（我们已经有）
4. Create repository

## 2. 把 OWNER 换成你的用户名

在仓库上传之前，先把本地 `package.json` 里的 3 处 `OWNER` 换成你的 GitHub 用户名：

```powershell
cd C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\dsh-campus-net
(Get-Content package.json -Raw).Replace('OWNER', '你的用户名') | Set-Content package.json -Encoding utf8
```

检查：

```powershell
Select-String -Path package.json -Pattern 'github.com'
```

## 3. 上传代码

1. 新仓库页面点 **uploading an existing file**
2. 打开 `C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\dsh-campus-net`
3. 全选这些文件和文件夹，拖进浏览器：
   - `index.js`、`package.json`、`cordis.patch.yml`、`LICENSE`
   - `README.md`、`README.zh.md`、`.gitignore`
   - `lib\`、`bin\`、`test\`、`docs\`、`publish\`
4. **不要**拖 `node_modules`、`.git`、`cred.dat`、`config.json`、`state.json`、日志
5. Commit message 填 `dsh-campus-net 0.1.0`，点 **Commit changes**

## 4. 给仓库打 topic

仓库首页右侧 **About** → 齿轮：

- Description：`Campus network auto-login for DSH (generic JSON portal, no school-specific data)`
- Topics 加：`dsh-plugin`（必须）、`deepseek-harness`、`campus-network`

## 5. 提市场 PR（创建满 1 天后）

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 点 **Fork**，得到你自己的副本
3. 在副本里进入 `data/plugins/`
4. **Add file → Create new file**，文件名：

   ```
   <你的用户名>__dsh-campus-net.yml
   ```

5. 内容用 `publish/market.yml`，把里面的 `OWNER` 换成你的用户名（description 的引号要保留）
6. Commit，然后 **Contribute → Open pull request**
7. PR 标题：`Add dsh-campus-net`；描述里写清楚：Windows 校园网自动登录、通用 JSON 门户（不内置任何学校信息）、三重自启守护、不实现深澜/Dr.COM

## 6. 可选：发 npm

市场不要求 npm。如果要发：

```powershell
npm publish
```

前提：`repository` 已指回被收录的仓库，且 npm 账号已登录。

## 发布前自查

- [ ] 仓库是 public
- [ ] `package.json` 有 `dsh.bundle.patch`，且 `cordis.patch.yml` 里 `name` 是 `dsh-campus-net`
- [ ] 仓库 topic 有 `dsh-plugin`
- [ ] 没有 `cred.dat` / `config.json` / 日志 / 个人学号手机号
- [ ] `node test/smoke.mjs` 20 项全过
- [ ] 市场 yml 的 `url`、`name`、文件名三处 owner 一致
- [ ] 描述不写“支持深澜/Dr.COM”
