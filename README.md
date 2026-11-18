# 心里韧带 · 青少年心理韧性自查工具

面向 12-18 岁青少年的心理健康自助网页应用，提供情绪自查、韧性训练、沟通支持和真实案例参考。

## 在线体验

- **生产版（含后端）**：https://xinli-ligand-t3tamdheczu.qoder.zone
- **管理员后台**：https://xinli-ligand-t3tamdheczu.qoder.zone/admin.html

## 功能

| 模块 | 说明 |
|------|------|
| 情绪自查 | 标准化量表，结果留在本地不上传 |
| 韧性训练 | 分阶段练习，支持打卡记录 |
| 沟通支持 | 内置对话引擎，模拟真实场景 |
| 真实案例 | 长文案例 + 可播放视频 |
| 账号系统 | 注册/登录/游客模式，PBKDF2 加密 |
| 管理后台 | 访问统计、账号管理、CSV 数据导出 |

## 技术栈

### 前端
- 原生 HTML5 + CSS3 + JavaScript (ES6)，无框架
- 单页应用架构，手动 DOM 渲染
- 微信小程序版本（原生 WXML + WXSS + JS）

### 后端
- 运行时：Deno（Edge Function）
- 语言：JavaScript ES Modules
- 架构：Serverless Function，自写路由层
- 数据库：PostgreSQL（5 张表）
- 认证：PBKDF2-SHA256（15 万轮）+ 不透明令牌会话
- 安全：`__Host-` Cookie、Origin CSRF 校验、固定窗口限流

### 部署
- 动态后端：Qoder Sites（阿里云基础设施）
- 静态提交版：GitHub Pages
- 本地开发：Deno + 内存数据库

## 本地运行

```bash
# 安装 Deno（https://deno.land）
deno run --allow-net --allow-env --allow-read dev/serve.mjs
```

打开 http://127.0.0.1:8123 即可体验。

## 提交包（无需服务器）

`提交包/` 目录包含自包含的 HTML 文件，双击即可在浏览器打开，所有功能通过 localStorage 模拟后端运行。

## 项目结构

```
├── dist/              # 生产版前端页面
├── functions/         # 后端 Edge Function 代码
│   ├── router.mjs     # API 路由与业务逻辑
│   ├── http.mjs       # HTTP 工具（CORS、请求解析、错误码）
│   ├── sessions.mjs   # 会话管理（令牌签发/验证/撤销）
│   ├── passwords.mjs  # 密码哈希（PBKDF2-SHA256）
│   ├── limiter.mjs    # 登录限流
│   ├── config.mjs     # 站点配置
│   └── export.mjs     # CSV 导出（RFC 4180 + 注入防护）
├── dev/               # 本地开发工具
│   ├── serve.mjs      # 本地演练服务器
│   ├── demo-shim.js   # 浏览器端演示后端
│   ├── fake-db.mjs    # 内存数据库（契约测试用）
│   ├── check.mjs      # 契约测试套件
│   └── build-submission.mjs  # 构建提交包
├── 提交包/            # 比赛提交用（自包含 HTML）
└── database-schema.sql # PostgreSQL 表结构
```

## AI 使用声明

本项目的后端服务（用户认证、数据存储、API 接口）使用 Qoder Desktop 的 AI 辅助功能生成。开发者理解并能够独立维护所有代码逻辑。前端界面设计、产品功能规划、内容调研由开发者独立完成。

## License

MIT
