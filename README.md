> **已归档**：这个仓库是精简发布版，已停止维护。代码与全部开发文档已合并到 **[diexie10/opencode-relay](https://github.com/diexie10/opencode-relay)**，请到那边查看最新版本。

# OpenCode Relay

> 把桌面的 [opencode](https://opencode.ai) 变成手机上的聊天界面 —— 一个做着玩的项目。

## 这是什么

一个轻量代理服务器，让你可以用手机浏览器访问桌面端运行的 opencode：

- 手机浏览器打开一个 URL，就能和桌面上的 opencode 对话
- 自带登录认证、会话管理、流式输出（SSE）
- 支持把桌面项目"导入"到手机工作区，改完还能"回并"到源目录
- 前端是重写的 Preact 单页应用，SoftGlass 风格，还挺好看的

```
手机浏览器 ⇄ Relay Server (node) ⇄ opencode serve ⇄ 桌面 AI
```

## 快速开始

```bash
npm install
node relay-start.js        # 一键清理旧进程 + 启动 + 健康检查
node relay-start.js --reset  # 重置数据库后启动
```

启动后终端会打印带 token 的访问地址（局域网 / Tailscale），手机浏览器打开即可。

## 使用流程

1. **导入**：设置面板里输入桌面项目路径，relay 会把项目复制到 `relay-data/projects/`
2. **对话**：在手机工作区里正常和 opencode 对话
3. **回并**：手机上的改动可以通过回并功能写回源目录（带冲突检测和备份）

## 项目失误自白

这个项目踩过不少坑，写下来供后来者参考：

- **DB 复制方案是错的**：最初每次启动都从桌面版 `opencode.db` 复制一份。但桌面版用 WAL 模式且一直在写，`copyFileSync` 复制出来的快照必然损坏，`node:sqlite` 备份也不可靠。后来改成独立持久化 DB，彻底不碰桌面版 —— 早该这样。
- **SSE 流不能 buffer**：代理层最初用 `response.text()` 拿完整响应，流式输出直接卡死。必须 pipe 流，并且超时只能保护连接建立阶段，收到响应头后必须清掉，否则长对话会被 30 秒超时掐断。
- **Windows 进程管理是坑**：`spawn` 带 `shell: true` 会触发 deprecation warning；杀进程要用 `taskkill /F /PID x /T`；WAL/SHM 文件会被残留进程锁住导致重启失败。为此写了 `relay-start.js` 统一处理。
- **权限/认证想简单**：认证用 `X-Auth-Token` header 或 `?token=` query param，密码存 `relay-data/config.json`。做做玩可以，生产环境请换正经方案。
- **前端前后重写了两遍**：第一版原生 JS 直接操作 DOM，第二版迁移到 Preact 才算是能维护的样子。

## 免责声明

本项目纯属个人做着玩，代码里充满个人习惯和临时决策，**不保证稳定、不保证安全、不提供任何支持**。

- 不要用于生产环境
- 不要暴露在公网
- 密码、token 都是你自己负责

需要的话随便拿去改，能帮到你一点就很好。

## 技术栈

- **后端**: Node.js（零依赖，仅用内置模块 + qrcode-terminal）
- **前端**: Preact + htm (ES Module CDN) + marked + DOMPurify
- **数据**: SQLite（opencode 自己的存储）

## 目录结构

```
opencode-relay/
├── server.js          # 主入口：路由、导入、回并 API
├── relay-start.js     # 一键启动脚本（清理进程 + 健康检查）
├── lib/               # 后端模块
│   ├── opener.js      # opencode serve 生命周期 + DB 管理
│   ├── proxy.js       # REST 代理（流式 pipe）
│   ├── sse-tunnel.js  # SSE 隧道
│   ├── auth.js        # Token 认证
│   └── ...
├── public/
│   └── index.html     # Preact SPA（SoftGlass 设计系统）
└── relay-data/        # 运行时数据（自动创建，已 gitignore）
    ├── relay.db       # 独立持久数据库
    ├── projects/      # 导入的项目
    └── backups/       # 回并备份
```

## License

[MIT](./LICENSE)
