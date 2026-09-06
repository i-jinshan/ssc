# 腾讯10分彩 · 本机 / 宝塔部署说明

Vite + React 前端。开奖验证码、登录转发、拉历史开奖由 **Node 中间层**（`server/lottery-proxy.ts`）完成，随 Vite 一起跑，**不依赖云端 Supabase**。会话存在进程内存里，进程一停就要重新登录。

本程序只做数据展示与模拟盈亏，不要当成自动下注工具。

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **20.x**（18 也可；14 无法运行 Vite 5） |
| 出网 | 服务器要能访问开奖站 `https://sk.jhc3ejo8.com`（HTTPS 443） |
| 代理 | **仅当直连该站失败时** 才需要。通过环境变量 / `.env` 里的 `LOTTERY_PROXY` 配置 |

---

## 本机开发

本机若直连开奖站 TLS 被重置（常见于大陆宽带），需本机代理软件（如 QuickQ，端口 `10900`）。仓库 `.env` 示例：

```bash
LOTTERY_PROXY=http://127.0.0.1:10900
```

启动：

```bash
cd /path/to/项目

# 若用 nvm
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20

npm install
npm run dev
```

浏览器打开终端提示的地址，一般为 <http://127.0.0.1:5173/>。

关掉终端或电脑休眠后进程会退出，需重新执行 `npm run dev`。

---

## 宝塔面板部署

下面以 **宝塔 Linux**（aaPanel 同类）为准。核心是：先 `npm run build` 出静态包，再用 **`npm start`（vite preview）** 同时提供网页和开奖代理。不要只把 `dist` 丢给 Nginx 当纯静态站，否则验证码和开奖接口会 404。

### 1. 安装 Node

1. 宝塔 → **软件商店** → 搜索 **PM2 管理器** 或 **Node.js 版本管理器**，安装。
2. 安装 **Node 20.x**，并设为当前版本。  
   SSH 检查：`node -v` 应类似 `v20.x.x`。

### 2. 上传代码

任选一种：

- 宝塔 **文件** 里上传 zip 并解压到例如 `/www/wwwroot/ssc`
- 或 SSH：`git clone` 到该目录

不要把本机 `node_modules` 一起上传，在服务器上重新 `npm install`。

### 3. 服务器上的 `.env`

在项目根目录放 `.env`（可从本机复制后改）：

**服务器能直连开奖站（海外 VPS 常见）：不要设置 `LOTTERY_PROXY`。** 删掉该行，或不要把本机那行 `http://127.0.0.1:10900` 带到服务器（服务器上没有 QuickQ，写了会连不上）。

**服务器也直连失败：** 在服务器自己搭 HTTP 代理后填写，例如：

```bash
LOTTERY_PROXY=http://127.0.0.1:7890
```

改 `.env` 后必须重启 Node 进程。

可用 SSH 测试直连：

```bash
curl -I --max-time 15 https://sk.jhc3ejo8.com/
```

返回 HTTP 状态码则多半可直连；`Connection reset` 则需要代理。

### 4. 安装依赖并构建

SSH 进入项目目录：

```bash
cd /www/wwwroot/ssc
npm install
npm run build
```

`build` 成功后会有 `dist/` 目录。

### 5. 用 PM2 常驻进程（推荐）

宝塔 → **PM2 管理器** → 添加项目，或 SSH：

```bash
cd /www/wwwroot/ssc
npx pm2 start npm --name ssc -- start
npx pm2 save
npx pm2 startup
```

默认监听 **4173**（见 `package.json` 的 `start` 脚本）。

查看：

```bash
npx pm2 status
npx pm2 logs ssc
```

更新代码后：

```bash
cd /www/wwwroot/ssc
git pull          # 若用 git
npm install
npm run build
npx pm2 restart ssc
```

重启后 **所有用户要重新登录**（内存会话会清空）。

也可在宝塔「Node 项目」里：启动文件选项目目录，启动命令填 `npm start`，端口填 `4173`。

### 6. Nginx 反代 + 域名 / HTTPS

1. 宝塔 → **网站** → 添加站点（绑定你的域名，根目录可随便指一个空目录，真正流量走反代）。
2. 站点 → **反向代理** → 添加：
   - 代理名称：随意
   - 目标 URL：`http://127.0.0.1:4173`
3. **SSL** → 申请 Let’s Encrypt 证书并强制 HTTPS。
4. 安全组 / 宝塔防火墙：对外开放 **80、443** 即可，**不必**把 4173 映射到公网。

反代后访问 `https://你的域名` 应出现登录页。点刷新验证码，能出图说明 Node 中间层和出网都正常。

---

## 注意事项

1. **不能当纯静态网站**  
   接口路径是 `/api/lottery`，必须由 `vite preview` / `npm start` 提供。只部署 `dist` 到 Nginx 会登录失败。

2. **`LOTTERY_PROXY` 本机和服务器往往相反**  
   本机常要填 QuickQ；能直连的服务器应留空。配错会导致「获取验证码失败」。

3. **会话不持久**  
   登录 cookie 存在 Node 内存。`pm2 restart`、崩溃、服务器重启后需重新登录。浏览器 `localStorage` 里的期数、统计窗口等设置还在，但服务端会话会失效。

4. **Node 版本**  
   必须 18+。宝塔默认有时是很老的 Node，先在版本管理器里切到 20。

5. **出网与防火墙**  
   服务器要允许访问外部 443。部分国内机器访问开奖站会被重置，需要代理或换能直连的机房。

6. **进程必须常驻**  
   不要用 `npm run dev` 在 SSH 里前台跑（断开 SSH 就停）。用 PM2 或宝塔守护。

7. **不要用 root 把 4173 直接暴露到公网**  
   走 Nginx 反代即可。调试接口 `?action=debug` 仍存在，公网部署时注意访问范围。

8. **模拟盈亏不是真金**  
   倍投、推荐只作用于本页统计。部署后也不会对开奖站自动下注。

9. **时区**  
   开奖时间字符串来自上游页面。服务器时区不影响解析，但看日志可用 `timedatectl` 设为 `Asia/Shanghai`。

---

## 常用命令对照

| 场景 | 命令 |
|---|---|
| 本机开发 | `npm run dev` → 端口 5173 |
| 生产构建 | `npm run build` |
| 生产运行 | `npm start` → 端口 4173 |
| 看进程 | `npx pm2 status` |
| 看日志 | `npx pm2 logs ssc` |
| 重启 | `npx pm2 restart ssc` |

---

## 目录要点

| 路径 | 作用 |
|---|---|
| `src/` | 前端 |
| `server/lottery-proxy.ts` | 开奖站代理（验证码 / 登录 / 开奖） |
| `server/vite-plugin.ts` | 把代理挂到 Vite / preview |
| `.env` | `LOTTERY_PROXY`（可选） |
| `dist/` | `npm run build` 产物 |
| `supabase/` | 旧云端方案，部署时**不用** |
