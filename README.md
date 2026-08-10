# obsidian-gdrive-syncthing

Obsidian ↔ Google Drive **双向增量同步**插件，采用 **Syncthing 风格的冲突解决机制**：任何冲突都会自动生成
`Filename.sync-conflict-YYYYMMDD-HHMMSS-xxxx.md` 副本，**绝不静默覆盖**任何数据。

- 用户在 Obsidian 端修改 → 自动上传到 Google Drive；
- AI 助手在 Google Drive 云端修改 → 自动下载到 Obsidian 本地；
- 双向同时修改 → 保留本地原名 + 云端版本保存为冲突副本（副本会同步回云端，两端可见）。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| Google Drive API v3 | 基于原生 `fetch` 实现，桌面端 / iOS / Android 均可运行 |
| OAuth 2.0 | 支持 Client ID / Secret / Refresh Token，支持授权码一键换取令牌 |
| 自动创建同步根目录 | 默认 `Sync_Obsidian`，不存在时自动创建 |
| 本地索引 | `.obsidian/gdrive-sync-index.json`：相对路径、本地 mtime、云端 fileId、云端 modifiedTime、本地 SHA-256 / 云端 MD5 |
| 增量比对 | 仅本地变动→上传；仅云端变动→下载；双向无变动→跳过（配合散列二次校验，进一步省流量） |
| Syncthing 冲突处理 | 冲突文件命名 `name.sync-conflict-YYYYMMDD-HHMMSS-xxxx.ext`，并弹出 Notice 提醒 |
| 删除安全 | 云端删除进回收站（可恢复）；“本地已改+云端已删”或“本地已删+云端已改”视为删除冲突并自动恢复，不丢数据 |
| 实时监听 | `vault.on('modify/create/delete/rename')` + 1000ms 防抖 |
| 定时轮询 | 启动同步 + 可配置轮询间隔（默认 60 秒）拉取云端变动 |
| 移动端兼容 | 所有本地读写统一使用 `this.app.vault.adapter` |

## 项目结构

```
obsidian-gdrive-syncthing/
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── styles.css
└── src/
    ├── main.ts                   # 插件主入口、生命周期、菜单/命令/状态栏
    ├── types.ts                  # 索引结构、配置项与 SyncStatus 类型
    ├── utils.ts                  # 路径 / MIME / 时间戳工具
    ├── gdrive/
    │   └── GDriveClient.ts       # Drive API v3 封装（OAuth/上传/下载/查询）
    ├── sync/
    │   ├── SyncEngine.ts         # 双向同步主引擎、事件监听与调度队列
    │   ├── IndexManager.ts       # 本地与云端 Index 元数据对比库
    │   └── ConflictResolver.ts   # Syncthing 冲突处理（生成 .sync-conflict-* 副本）
    └── ui/
        └── SettingsTab.ts        # OAuth 配置与同步参数设置面板
```

## 构建与安装

```bash
cd obsidian-gdrive-syncthing
npm install
npm run build
```

构建产物为 `main.js`。安装到 Obsidian：

1. 在 vault 下创建目录 `.obsidian/plugins/obsidian-gdrive-syncthing/`；
2. 将 `manifest.json`、`main.js`、`styles.css` 复制进去；
3. 打开 Obsidian：设置 → 第三方插件 → 重新加载，然后启用 **GDrive 双向同步**。

## Google Cloud 配置（一次性）

> 插件设置面板中已内置「① 获取 Google Drive API 凭据」教程，含每一步的快捷链接，可直接照做。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) → 新建项目（或使用已有项目）；
2. **启用 Google Drive API**（API 与服务 → 库 → 搜索 "Google Drive API" → 启用）；
3. 配置 **OAuth 同意屏幕**（外部），把测试用户添加为你的 Google 账号；
4. 凭据 → 创建凭据 → **OAuth 客户端 ID** → 应用类型选 **Web 应用**；
5. 在 **已获授权的重定向 URI** 中添加 `http://localhost:8080/`（与插件设置中的 Redirect URI 一致）；
6. 将 Client ID 与 Client Secret 填入插件设置面板；
7. 点击 **生成授权链接** → 在浏览器中完成授权 → 复制跳转地址中 `code=` 后的参数 → 点击 **用授权码换取令牌**；
8. 点击 **测试连接** 验证配置。

> 授权范围使用 `https://www.googleapis.com/auth/drive.file`：插件只能访问自己创建的文件。
> 同步根目录由插件自动创建，因此目录内的文件均可正常访问，不会触及其它个人文件。

### 免注册备选方案：rclone 公共凭据（无需 Google Cloud 项目 / 无需信用卡）

不想注册 Google Cloud 项目？可以在插件设置面板点击 **「② 免注册备选方案」→ 一键填入 rclone 凭据**，或手动填写：

| 字段 | 值 |
| --- | --- |
| Client ID | `202264815644.apps.googleusercontent.com` |
| Client Secret | `X4Z3ca8xfWDb1Voo-F9a7ZxJ` |
| Redirect URI | `http://127.0.0.1:53682/`（必须，不能改） |

授权完成后浏览器会跳转到 `http://127.0.0.1:53682/?code=…`，页面打不开是正常的，复制地址栏中 `code=` 后的参数粘贴到插件即可。

## 常见问题

### 授权页报错 `400. That's an error ... malformed` / `redirect_uri_mismatch`

几乎都是 **Redirect URI 与 Google Cloud Console 注册的不一致**（Google 在登录后才校验回调地址）：

- 使用 rclone 公共凭据时，插件默认的 `http://localhost:8080/` 无效，必须改为 `http://127.0.0.1:53682/`（设置面板已内置一键填入）；
- 使用自己创建的 OAuth 客户端时，请在 Console → 凭据 → 该 OAuth 客户端 → **已获授权的重定向 URI** 中，添加与插件设置完全一致的地址（含结尾斜杠，如 `http://localhost:8080/`）；
- 确认 Client ID 以 `.apps.googleusercontent.com` 结尾、没有多余空格；
- 若使用 Google 家长控制 / Workspace 受限账号，请换普通 Gmail 账号或联系管理员。

## 使用说明

- 功能区点击刷新图标或执行命令 **立即同步到 Google Drive** 手动触发；
- 命令 **暂停 / 恢复 GDrive 同步** 可随时暂停/恢复；
- 状态栏显示当前状态与上次同步时间；
- 设置面板中的 **重置同步索引** 可清除索引，下次同步进行全量比对（不会删除任何文件）。

## 同步算法

1. 扫描本地文件与递归列出云端文件（均跳过排除路径）；
2. 以索引为基准对比两侧：
   - 仅本地变动 → 上传（更新或新建）；
   - 仅云端变动 → 下载覆盖本地；
   - 双向同时变动 → 冲突：保留本地原名，云端版本生成 `*.sync-conflict-*` 副本（副本上传到云端）；
   - 本地已改 + 云端已删 → 删除冲突，重新上传本地版本；
   - 本地已删 + 云端已改 → 删除冲突，恢复下载云端版本；
   - 单侧删除且对侧未变动 → 传播删除（云端进回收站 / 本地进系统回收站）；
   - 双向无变动 → 跳过；
3. 每个操作成功后增量更新索引，最终写回 `.obsidian/gdrive-sync-index.json`。

## 安全与限制

- 令牌以明文保存在 vault 的 `.obsidian/plugins/obsidian-gdrive-syncthing/data.json` 中，请妥善保管 Google 账号；
- 冲突副本与普通文件一样会继续参与同步（Syncthing 行为），若不再需要可手动删除；
- 重命名（内容不变）会被识别为“删除 + 新建”；
- Windows/macOS 文件系统大小写不敏感，而 Drive 大小写敏感，请避免仅大小写不同的文件；
- 首次同步会全量上传/下载，请确保配额充足（每个账号每天 750GB 传输配额）。