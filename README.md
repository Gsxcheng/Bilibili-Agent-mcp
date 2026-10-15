# bilibili-agent-mcp

让 AI Agent 直接使用 B 站的 MCP 服务。

> 非 Bilibili-Evolved 官方项目。功能参考并部分移植自 [the1812/Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved)（MIT），在此致谢。

把 [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) 里「能脱离浏览器页面独立运行」的功能移植成 MCP 服务，让 Claude / Cursor 等 AI 客户端可以直接调用：查视频、下视频、抓弹幕、拿字幕文字稿、看评论、搜索、热榜、UP 主信息、稍后再看 / 收藏 / 历史 / 动态。

> 版本 V0.1 · Node.js ≥ 18.17 · stdio 传输 · 15 个工具 + 1 个提示词模板

## 为什么不是“直接把脚本包一层”

Bilibili-Evolved 是油猴脚本，运行在 B 站网页里，大部分组件是改 DOM / 改样式 / 改播放器行为。这类功能离开浏览器没有意义，AI 也调用不了。本项目只移植**以数据和 B 站接口为核心**的功能，并在服务端补上浏览器原本自动完成的部分（WBI 签名、buvid 风控 Cookie、Referer、ffmpeg 合并）。

| Bilibili-Evolved 功能 | MCP 工具 | 说明 |
|---|---|---|
| BV 号转换、av 号链接 | `bili_resolve` | 识别链接 / BV / av / ep / ss / md / cv / UID / 直播间，展开 b23.tv 短链 |
| 展开完整简介、查看封面、视频元数据 | `bili_video_info` | 标题、完整简介、封面、UP 主、数据、标签、分 P、合集；番剧返回剧集与评分 |
| 下载视频（DASH，AVC/HEVC/AV1） | `bili_video_streams` | 清晰度 / 编码列表与直链 |
| 下载视频 + 输出插件、批量下载、下载音频、查看封面 | `bili_download` / `bili_download_status` | 后台任务；ffmpeg 自动合并并写入章节；可附带封面 / 弹幕 / 字幕 / 元数据 |
| 下载弹幕、弹幕转换器（XML→ASS） | `bili_danmaku` | stats 统计高频弹幕与高能时间点、lines 带时间戳文本、ass/xml/json 存文件 |
| 下载字幕 | `bili_subtitles` | 文字稿（最适合 AI 总结）、SRT、ASS、JSON |
| 保存视频元数据（ffmetadata / OGM 章节） | `bili_chapters` | UP 主看点章节；番剧 OP/ED 转章节 |
| 评论区增强 | `bili_comments` | 热门 / 最新、置顶、IP 属地、楼中楼，可翻页 |
| 搜索栏 / Launch Bar 搜索 | `bili_search` | 视频、用户、番剧、影视、直播间、专栏 |
| 热搜、排行 | `bili_hot` | 热搜词、综合热门、分区排行、每周必看 |
| UID 搜索、查看头像 | `bili_user` | 资料、粉丝、获赞、认证、最近投稿 |
| 直播相关 | `bili_live_room` | 标题、开播状态、人气、分区 |
| 稍后再看、收藏、历史、动态 | `bili_account` | 需登录 Cookie，只读 |
| 稍后再看添加 / 移除 | `bili_watch_later_edit` | 写操作，默认关闭 |
| — | 提示词 `summarize_bilibili_video` | 一键「总结这个视频」：信息 + 字幕 + 章节 + 弹幕反应 |

**没有移植的**（依赖网页 DOM 或纯视觉）：夜间模式、自定义导航栏、播放器定位 / 快捷键 / 手势、宽屏、去广告、样式调整、直播礼物框隐藏等。

## 安装

```bash
git clone https://github.com/Gsxcheng/Bilibili-Agent-mcp.git bilibili-agent-mcp
cd bilibili-agent-mcp
npm install          # 会自动编译到 dist/
npm test             # 可选：26 个离线测试
```

想要下载后自动合并音视频，请安装 [ffmpeg](https://ffmpeg.org/download.html) 并确保在 PATH 中（或设置 `BILIBILI_FFMPEG`）。

## 接入 AI 客户端

下面的 `/绝对路径/bilibili-agent-mcp` 换成你本机路径（Windows 用 `C:\\path\\to\\...` 形式）。

**Claude Desktop**（设置 → 开发者 → 编辑配置，`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "bilibili": {
      "command": "node",
      "args": ["/绝对路径/bilibili-agent-mcp/dist/index.js"],
      "env": {
        "BILIBILI_COOKIE": "SESSDATA=...; bili_jct=...; buvid3=...",
        "BILIBILI_DOWNLOAD_DIR": "/Users/你/Downloads/bilibili"
      }
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add bilibili -e BILIBILI_COOKIE="SESSDATA=...; bili_jct=..." -- node /绝对路径/bilibili-agent-mcp/dist/index.js
```

**Cursor**（`~/.cursor/mcp.json`）：与 Claude Desktop 相同的 `mcpServers` 结构。

配置后重启客户端，直接对 AI 说：「总结一下 https://b23.tv/xxxx」「把这个视频 1080P 下载下来并带上弹幕」「这期视频观众在哪几分钟最激动？」。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `BILIBILI_COOKIE` | 浏览器里完整 Cookie 字符串（推荐） | 空（游客） |
| `BILIBILI_SESSDATA` / `BILIBILI_BILI_JCT` | 只填这两项也可以 | 空 |
| `BILIBILI_DOWNLOAD_DIR` | 下载与导出目录 | `~/Downloads/bilibili` |
| `BILIBILI_FFMPEG` | ffmpeg 路径 | `ffmpeg` |
| `BILIBILI_ALLOW_WRITE` | `true` 才开放会修改账号的工具 | 关闭 |
| `BILIBILI_USER_AGENT` | 自定义 UA | Chrome 130 |

**不配 Cookie 能用什么**：视频信息、480P 以下流与下载、弹幕、评论、搜索、热榜、用户、直播间、章节。
**需要 Cookie 的**：720P/1080P 及以上（部分需大会员）、AI 字幕、稍后再看 / 收藏 / 历史 / 动态。

获取 Cookie：浏览器登录 bilibili.com → F12 → 应用(Application) → Cookie → `https://www.bilibili.com`，复制 `SESSDATA`、`bili_jct`、`buvid3`。

## 安全设计

- Cookie 只发往 `*.bilibili.com` / `b23.tv`，不会发给视频 CDN（bilivideo.com、hdslb.com）或其他域名。
- 修改账号数据的工具默认禁用，需显式设置 `BILIBILI_ALLOW_WRITE=true`，且工具带 `destructiveHint` 标注，客户端会提示确认。
- 本服务只读写 `BILIBILI_DOWNLOAD_DIR` 下的文件。
- `SESSDATA` 等同于登录态，请勿把含 Cookie 的配置文件提交到 Git 或分享给他人；Cookie 过期后重新复制即可。

## 验证情况（V0.1）

| 项目 | 状态 |
|---|---|
| WBI 签名、av⇄BV 算法 | 公开参考向量 + 5 个线上真实 av/BV 对比通过 |
| 弹幕 protobuf 解码与 ASS 转换 | 用线上 `seg.so` / `dm/web/view` 真实二进制数据解码通过 |
| `wbi/view`、`wbi/playurl`、`player/wbi/v2`、`reply/wbi/main`、`wbi/search/type`、热搜、排行、每周必看、用户卡片、直播间、番剧季信息、buvid 获取 | 2026-10 线上请求，返回结构与代码一致 |
| 发现并修复 | 未签名的 `/x/web-interface/view` 现在会被返回 HTTP 412，已改用 `wbi/view` 并保留回退 |
| MCP 协议、15 个工具、后台下载、ffmpeg 合并 + 章节写入、备用 CDN 回退、Cookie 隔离 | 26 个离线测试（真实 MCP Client + 模拟 B 站后端 + 真实 ffmpeg） |
| 从 CDN 实际下载媒体、登录态接口（稍后再看 / 收藏 / 历史 / 动态 / AI 字幕 / 写操作） | **UNVERIFIED**：开发环境无法直连 B 站 CDN，且未使用登录账号测试 |

## 已知限制 / 路线图

- B 站风控变化频繁；遇到 `-352` / `-412` 时，配置完整 Cookie（含 `buvid3`）通常能解决。
- 弹幕 ASS 的文字宽度是估算值（原脚本在浏览器里用 canvas 精确测量），极少数情况下滚动弹幕间距略有差异。
- 下载任务保存在内存中，服务重启后任务列表清空（已下载的文件不受影响）。
- 后续可加：专栏 / 动态图文、直播弹幕实时流、合集 / 收藏夹批量下载、视频截图（videoshot）、HTTP 传输模式。

## 许可与致谢

MIT。弹幕转换器、字幕 ASS 转换、DASH 选流逻辑移植自 [the1812/Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved)（MIT），源文件头部标注了出处。本项目不分发 Bilibili-Evolved 脚本本体。B 站接口为非公开接口，请遵守 B 站用户协议，仅用于个人学习与合理使用；下载内容版权归原作者所有。
