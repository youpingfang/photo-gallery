# Image Gallery (local images → web)

把宿主机某个目录里的图片，以网页画廊方式展示。

## 1) 准备图片目录
默认会读取项目内 `./images`。你也可以指定宿主机目录：

```bash
export IMAGE_DIR_HOST=/root/your/images
```

支持 jpg/jpeg/png/gif/webp/bmp/svg。

## 2) 启动
```bash
cd /root/clawd/image_gallery
# 可选：对外端口
export PORT=8088

docker compose up -d --build
```

访问：
- 本机：`http://127.0.0.1:8088`
- 远程：`http://<你的VPS公网IP>:8088`

## 3) 关闭
```bash
docker compose down
```
