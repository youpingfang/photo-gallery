# Image Gallery（本地图片画廊 / PWA）

一个自托管的本地图片画廊：支持 **泡泡下雨效果**、**拼贴轮播墙**、**瀑布**。手机端可 **PWA 添加到主屏幕**，并支持大图浏览、缩放。

**亮点：可连接 Immich（开源自托管照片库）**
- 用 Immich 的某个相册作为“公开展示画廊”，发链接给朋友/家人直接看
- 管理端用 `ADMIN_PASS` 解锁后可更换公开相册、进行管理操作

> 本项目由正正提出需求，我（Clawdbot 内的 AI 助手）协助完成主要开发与迭代。
>
> 使用 **openclawd** 开发。
>
> Developed with **openclawd**.

## 功能亮点

## 界面预览

| 拼贴模式 | 泡泡模式 | 圆形/椭圆效果 |
|---|---|---|
| ![拼贴模式](docs/screenshots/collage.jpg) | ![泡泡模式](docs/screenshots/bubble.jpg) | ![圆形效果](docs/screenshots/bubble-circles.jpg) |

- 三种浏览模式
  - **泡泡模式**：图片像“下雨”从上往下落；新图尽量在上方，旧图优先从底部替换
  - **拼贴模式**：固定模板拼图墙，格子随机轮播切换，过渡更柔和
  - **瀑布流模式**：支持列数配置；支持随机顺序展示（每次进入不固定）
- 大图浏览（Lightbox）
  - `contain` 不裁切 + **模糊背景填充**（避免黑边）
  - 支持 **滚轮缩放 / 双击缩放 / 拖拽平移**
  - 支持 **左右滑动切换**，并减少 iOS 边缘返回误触
- PWA
  - 支持“添加到主屏幕”后全屏体验（减少地址栏/底栏影响）
- 性能
  - 缩略图由 `sharp` 生成并缓存到磁盘 `.thumbs`
  - 可选 Redis 缓存：目录列表 & EXIF 元数据（不缓存图片二进制）

---

## 快速开始

### 本地运行

```bash
npm install
PORT=8088 IMAGES_DIR=/path/to/your/images npm start
```

打开：
- http://localhost:8088/

> `IMAGES_DIR` 是图片目录，支持子目录结构（例如 `2026/01`）。

---

## 环境变量

### Docker Compose（推荐）
仓库内提供了 `.env.example`：
1) 复制为 `.env`
2) 填入你的值（**不要提交 .env**）

> Docker Compose 会自动读取同目录的 `.env`，用于替换 `compose.yaml` 里的 `${VAR}`。

### Node 直跑
| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `3000` |
| `IMAGES_DIR` | 图片目录（必填） | `/images` |
| `THUMB_WIDTH` | 缩略图宽度（可选） | （见代码默认） |
| `THUMB_QUALITY` | 缩略图质量（可选） | （见代码默认） |
| （已移除） | 上传/删除已统一由 `ADMIN_PASS` 解锁（cookie，默认 7 天）控制 | |
| `ADMIN_PASS` | 管理解锁密码（用于配置公共相册/管理操作） | 空（不启用） |
| `IMMICH_URL` | Immich 公网地址 | 空 |
| `IMMICH_API_KEY` | Immich API Key（仅服务端） | 空 |
| `WEBDAV_ENABLED` | 是否启用 WebDAV | `0` |
| `WEBDAV_URL` | WebDAV URL | 空 |
| `WEBDAV_USER` | WebDAV 用户名 | 空 |
| `WEBDAV_PASS` | WebDAV 密码 | 空 |
| `GALLERY_CONFIG_PATH` | 公共相册配置文件路径 | `/images/.gallery_config.json` |
| `REDIS_URL` | Redis 连接串（可选，用于元数据缓存） | 空 |

示例：

```bash
PORT=8088 \
IMAGES_DIR=/data/photos \
# UPLOAD_TOKEN 已移除：上传/删除由 ADMIN_PASS 解锁控制
REDIS_URL=redis://127.0.0.1:6379 \
npm start
```

---

## 使用说明

- 右下角 **“xxx\n模式”按钮**：快速切换「泡泡 / 拼贴 / 瀑布流」
- ⚙️ 设置：列数、泡泡数量、删除模式等
- PWA（iPhone）：Safari → 分享 → 添加到主屏幕

---

## Immich 联动（开源照片库）

本项目支持把 **Immich**（开源自托管照片库）作为远程数据源：
- 由服务端通过 Immich API 拉取相册与资产
- 前端展示为本画廊的三种模式 + 大图浏览

### 你能得到什么

- 把 Immich 里的某个相册做成一个“公开展示画廊”（适合分享给朋友/家人）
- 仍然保留管理能力：只有管理员能改公开相册、上传/删除等

### 配置方式（Docker Compose）

1) 在 `.env`（不要提交）里填：

```env
IMMICH_URL=https://your-immich-domain
IMMICH_API_KEY=your_immich_api_key
ADMIN_PASS=your_admin_pass
IMAGE_DIR_HOST=/path/to/your/images
```

2) 启动：

```bash
docker compose up -d
```

3) 打开画廊网页 → ⚙️ 设置 → 输入管理密码解锁 → 数据源选择「远程 Immich」→ 选择要公开的相册 → 保存。

> 这个“公开相册选择”会持久化到 `GALLERY_CONFIG_PATH` 指定的 json 文件中（默认写入 `/images/.gallery_config.json`），容器重启也不会丢。

---

## 安全提示（重要）

如果部署到公网，强烈建议：

1) 设置 `ADMIN_PASS`（用于解锁管理设置；上传/删除也需要先解锁）
2) `IMMICH_API_KEY` 只放在服务端环境变量中（不要写进仓库/前端）
3) 如部署到公网，建议通过反向代理做访问控制（Basic Auth / IP 白名单 / VPN）

---

## 目录结构

```text
.
  server.js
  public/
    index.html
    manifest.webmanifest
    sw.js
    icons/
    assets/
      app.js
      styles.css
  images/         # 示例目录（实际由 IMAGES_DIR 指定）
```

---

## License

MIT（如需改协议可自行调整）
