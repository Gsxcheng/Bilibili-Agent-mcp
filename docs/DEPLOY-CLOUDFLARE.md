# 用 Cloudflare Tunnel 把 bilibili-agent-mcp 接到 Claude / ChatGPT 网页版

Claude 和 ChatGPT 网页版的「连接器」是从它们的云端服务器来访问你的 MCP 服务，所以服务必须有一个公网 HTTPS 地址。本文用 Cloudflare Tunnel 把你电脑上运行的服务安全地映射到公网：**不用开路由器端口、不用公网 IP、不用自己配 HTTPS 证书**。

```
Claude / ChatGPT 云端 ──HTTPS──▶ Cloudflare ──隧道──▶ 你电脑上的 cloudflared ──▶ 127.0.0.1:8787 bilibili-agent-mcp ──▶ B 站
```

服务跑在你自己的电脑上有三个好处：用的是你家的网络（B 站风控最少）、Cookie 只存在你本机、下载的视频直接落在你本机硬盘。代价是电脑要开着、cloudflared 和服务都要在运行。

---

## 0. 准备

1. 安装 [Node.js](https://nodejs.org/) 18.17 或更新版本（推荐 LTS）。
2. 下载并编译项目：

   ```bash
   git clone https://github.com/Gsxcheng/Bilibili-Agent-mcp.git
   cd Bilibili-Agent-mcp
   npm install
   ```

3. （可选）把 `.env.example` 复制为 `.env`，填上 B 站 Cookie 等配置。不填就是游客模式。
4. （可选）安装 ffmpeg，用于自动合并下载的音视频。

## 1. 启动 HTTP 模式

```bash
npm run start:http
# 等价于：node dist/index.js --http
```

看到类似输出就成功了：

```
[bilibili-agent-mcp] v0.1.0 HTTP 模式已启动
  B站登录: 已配置 Cookie · 下载目录: C:\Users\you\Downloads\bilibili
  本机测试地址: http://127.0.0.1:8787/mcp/Xk3...（访问密钥）
  连接器地址:   https://<你的隧道域名>/mcp/Xk3...
  访问密钥来源: C:\Users\you\.bilibili-agent-mcp\token
```

- **访问密钥**（地址里 `/mcp/` 后面那一串）第一次启动时自动生成，保存在 `~/.bilibili-agent-mcp/token`，以后重启不变。随时可以用 `node dist/index.js --show-token` 再看一次。
- 默认只监听 `127.0.0.1:8787`，局域网和外网都直接访问不到，只有本机的 cloudflared 能连。端口可用 `--port` 或 `BILIBILI_MCP_PORT` 修改。

本机自测（另开一个终端）：

```bash
curl http://127.0.0.1:8787/health
# 输出 ok 即正常
```

> 这个窗口要一直开着。想开机自动运行，见第 5 节。

## 2. 安装 cloudflared

| 系统 | 安装方式 |
|---|---|
| Windows | 从 [cloudflared 下载页](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) 下载 64 位 MSI 安装包安装（Windows 版不会自动更新，需要偶尔手动升级） |
| macOS | `brew install cloudflared` |
| Linux | 见 [官方安装说明](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel)（apt / yum / pacman / 直接下载二进制） |

装好后运行 `cloudflared --version` 确认。

接下来二选一：**方案 A** 不用注册、一条命令、适合先试试；**方案 B** 地址固定、适合长期用。

---

## 3. 方案 A：临时隧道（免注册，先跑通）

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

输出里会出现一个形如 `https://xxxx-xxxx-xxxx.trycloudflare.com` 的地址。你的连接器地址就是：

```
https://xxxx-xxxx-xxxx.trycloudflare.com/mcp/<访问密钥>
```

然后直接跳到第 6 节添加到 Claude / ChatGPT。

限制（来自 Cloudflare 官方说明）：

- **每次重启 cloudflared 地址都会变**，变了就得去 Claude / ChatGPT 里改连接器地址。
- 没有可用性保证，只用于测试；同时最多 200 个进行中的请求。
- 不支持 SSE。本服务的 HTTP 模式本来就只返回普通 JSON，不受影响。
- 如果 `~/.cloudflared/` 下已有 `config.yaml`，临时隧道会无法启动，需要临时改名。

## 4. 方案 B：固定域名（长期使用）

前提：一个 Cloudflare 账号（免费即可），以及一个**已托管在 Cloudflare 的域名**（即域名的 NS 已改到 Cloudflare）。没有域名可以在 Cloudflare 或其他注册商买一个便宜的。

### 4.1 在网页控制台创建（推荐，最省事）

> Cloudflare 控制台改版较频繁，菜单名称可能和下面略有出入，以官方文档 [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) 为准。

1. 登录 Cloudflare 控制台，进入 **Networking → Tunnels**，点 **Create a tunnel**。
2. 起个名字，比如 `bili-mcp`，点 **Create Tunnel**。
3. 选择你的操作系统，**复制页面给出的安装命令，在你电脑的终端里运行**（Windows 需用管理员身份打开终端）。这条命令会把 cloudflared 装成系统服务，开机自动连上。等页面显示连接成功后点 **Continue**。
4. 在隧道的 **Routes** 标签里点 **Add route → Published application**：
   - **Subdomain**：例如 `bili`
   - **Domain**：选你的域名，例如 `example.com`
   - **Service URL**：`http://localhost:8787`
5. 保存。隧道状态显示 **Healthy** 即可。

你的连接器地址就是：

```
https://bili.example.com/mcp/<访问密钥>
```

### 4.2 用命令行创建（可选）

```bash
cloudflared tunnel login                         # 浏览器登录并选择域名
cloudflared tunnel create bili-mcp               # 创建隧道，记下输出的 UUID 和凭据文件路径
cloudflared tunnel route dns bili-mcp bili.example.com
```

在 `~/.cloudflared/config.yml`（Windows 是 `C:\Users\你\.cloudflared\config.yml`）写入：

```yaml
tunnel: <上一步的 UUID>
credentials-file: /home/you/.cloudflared/<UUID>.json
ingress:
  - hostname: bili.example.com
    service: http://localhost:8787
  - service: http_status:404
```

运行：

```bash
cloudflared tunnel run bili-mcp
```

要开机自启，参考官方的 [以服务方式运行](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/) 文档。

### 4.3 （可选）让下载链接用固定域名

服务默认会从请求头自动识别对外域名来生成文件下载链接，一般不用管。如果链接不对，在 `.env` 里加：

```
BILIBILI_MCP_PUBLIC_URL=https://bili.example.com
```

## 5. 让服务开机自动运行

cloudflared 用方案 B 的控制台命令安装后已经是系统服务；还需要让 bilibili-agent-mcp 本身也常驻。

**Windows（任务计划程序）**

1. 开始菜单搜索「任务计划程序」→ 右侧「创建任务」。
2. 「常规」：名称填 `bilibili-agent-mcp`，勾选「不管用户是否登录都要运行」。
3. 「触发器」：新建 →「启动时」。
4. 「操作」：新建 → 程序填 `node` 的完整路径（PowerShell 里运行 `where.exe node` 可查到，例如 `C:\Program Files\nodejs\node.exe`），参数填 `dist\index.js --http`，「起始于」填项目目录（例如 `D:\Bilibili-Agent-mcp`）。
5. 「设置」：勾选「如果任务失败，按以下频率重新启动」。

> 选了「不管用户是否登录都要运行」时，任务以你的账号运行，`.env` 放在项目目录即可被读到。

**macOS / Linux（pm2）**

```bash
npm install -g pm2
pm2 start dist/index.js --name bili-mcp -- --http
pm2 save
pm2 startup     # 按提示执行它输出的那条命令
```

## 6. 添加到 Claude / ChatGPT

### Claude（网页版、桌面版、手机 App 通用）

- **Free / Pro / Max**：进入 **Customize → Connectors**，点 **Add custom connector**，名称随意（如「B站」），**MCP server URL** 填上面的连接器地址，认证方式选 **No sign-in**（如果看到这个选项），点 **Add**。
- **Team / Enterprise**：需要组织所有者在 **Organization settings → Connectors → Add → Custom** 里添加，成员再到 **Customize → Connectors** 里点 Connect。
- 使用：在对话框的 **+ → Connectors** 里打开这个连接器。

### ChatGPT（仅网页版，需 Plus / Pro / Business / Enterprise / Education）

1. **Settings → Apps → Advanced settings**，打开 **Developer mode**。
2. 在 Apps 设置里点 **Create app**，填名称和连接器地址，认证选 **No Authentication**，保存（会出现在 Drafts 里）。
3. 使用：在对话框的 **+** 菜单里选 **Developer mode**，勾选这个应用。

说明：

- ChatGPT 会按工具上的只读标注决定是否需要确认。查询类工具标了只读，可以直接调用；`bili_download`、`bili_watch_later_edit` 会先请你确认。
- 服务更新、新增工具后，ChatGPT 需要在应用设置里手动刷新才能看到；Claude 可以断开再连接一次。

试一句：「用 B 站工具看看今天热搜是什么」。

## 7. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 连接器添加失败 / 404 | 地址里的访问密钥不对，或少了 `/mcp/`。运行 `node dist/index.js --show-token` 核对。 |
| 502 / 530 / 1033 | cloudflared 连不上本机服务：确认 `npm run start:http` 在运行、端口与 Service URL 一致。 |
| 524 超时 | Cloudflare 对单次请求约 100 秒超时。`bili_download` 的 `wait_seconds` 已限制在 90 秒内，超时的任务会在后台继续，用 `bili_download_status` 查。 |
| B 站返回 -412 / -352 | 风控。在 `.env` 里配置完整 Cookie（含 `buvid3`），稍后再试。 |
| 临时隧道地址失效 | 方案 A 每次重启都换地址，需更新连接器；长期使用请换方案 B。 |
| 下载的文件在哪 | 在运行服务的电脑上（`BILIBILI_DOWNLOAD_DIR`）。远程使用时，工具结果里的 `downloadUrl` / `downloads` 链接可以直接下载。 |
| 国内网络下隧道不稳定 | cloudflared 需要连到 Cloudflare 的边缘节点，部分网络环境下可能断连，cloudflared 会自动重连；长期不稳定可考虑云服务器部署。 |

## 8. 安全须知

- **连接器地址 = 密码。** 知道完整地址的人可以调用所有工具，包括读取你的观看历史、收藏和动态（如果配置了 Cookie）。不要截图分享、不要提交到 Git。
- **更换密钥**：删除 `~/.bilibili-agent-mcp/token`（或修改 `.env` 里的 `BILIBILI_MCP_TOKEN`），重启服务，然后在 Claude / ChatGPT 里把连接器地址改成新的。
- 密钥错误、路径错误时服务统一返回 404，不暴露任何信息；文件下载接口同样需要密钥，且只能访问下载目录里的文件。
- 修改账号数据的工具默认关闭（`BILIBILI_ALLOW_WRITE`），远程使用时建议保持关闭。
- B 站 Cookie 只保存在你电脑的 `.env` 里，只用于请求 B 站，不会出现在返回给 Claude / ChatGPT 的工具结果中。

## 参考

- [Claude：Third party connectors with remote MCP](https://claude.com/docs/connectors/custom/remote-mcp.md)
- [ChatGPT：Developer mode](https://developers.openai.com/api/docs/guides/developer-mode.md)
- [Cloudflare：Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare：Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Cloudflare：Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel)
