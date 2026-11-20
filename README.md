# 白夜行 · 设备管理后台（独立版）

独立于白夜行用户版的后台：设备在线状态、IP、当前项目、下线/恢复。

## 一键部署到 Render

1. 登录 https://render.com （用 GitHub 登录）
2. 打开：
   https://render.com/deploy?repo=https://github.com/ZHIXIAO-XJY/baiyexing-device-admin
3. 按提示设置 `ADMIN_PASSWORD`（不要使用示例密码）
4. 部署完成后访问：
   `https://<Render 分配的域名>/admin`

## 默认结构

- `server.js`：Node 后台，无第三方依赖
- `admin.html`：管理界面（PWA）
- `admin-manifest.webmanifest` / `admin-sw.js`：手机安装
- `Dockerfile` / `docker-compose.yml`：自托管
- `render.yaml`：Render Blueprint，含持久磁盘

## 注意

- 不要直接公网裸奔 8787 端口；用 HTTPS。
- 管理员密码通过 `ADMIN_PASSWORD` 设置，不要提交到仓库。
- 设备需要调用 `/api/device/register` 与 `/api/device/heartbeat` 才会出现在后台。
- 后台默认不接入用户版主应用，保持隔离。
