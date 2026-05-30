# 效率清单（Efficiency List）

基于产品需求文档实现的**任务 / 日程管理工具**。真实前后端 + 真实 SQLite 持久化，**无任何 mock 数据**。

## 架构（网页 + 桌面双形态就绪）

```
client/  Vite + React + TS  —— 纯 SPA，只通过 /api 与后端通信（host-agnostic）
server/  Express + TS + node:sqlite —— 真实 REST API + 真实 SQLite 文件
```

- **网页形态**：前端构建产物静态托管 + 后端 Express 部署为服务。
- **桌面形态（后续）**：Electron 包壳，渲染层加载同一份 React 产物，Express+SQLite 作为内置进程跑在 127.0.0.1，前端仅改 API base URL，代码 95%+ 复用。
- 持久化用 **Node 24 内置 `node:sqlite`**，零原生编译依赖，Express 与 Electron 运行时均可直接使用。

## 运行

```bash
npm install      # 一次安装前后端依赖（npm workspaces）
npm run dev      # 同时启动后端(:4000) 与前端(:5173)
```

打开 http://localhost:5173 。也可单独启动：`npm run dev:server` / `npm run dev:client`。

数据库文件：`server/data/app.db`（首次运行自动建表并预置「收集箱」）。

## API 契约

| Method | Path | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/smart-lists | 智能清单计数（今天/最近7天/收集箱/已完成/垃圾桶） |
| GET | /api/lists | 自定义清单（含活跃任务数） |
| POST/PATCH/DELETE | /api/lists/:id | 清单增改删（删除时其任务移回收集箱） |
| GET | /api/tasks?view=today\|next7days\|inbox\|completed\|trash 或 ?listId= | 查询任务 |
| POST | /api/tasks | 创建任务（默认进收集箱） |
| GET/PATCH | /api/tasks/:id | 详情 / 更新（切换完成自动写 completedAt） |
| DELETE | /api/tasks/:id[?permanent=1] | 软删除进垃圾桶 / 彻底删除 |
| POST | /api/tasks/:id/restore | 从垃圾桶恢复 |

错误统一返回 `{ error: { code, message } }`。

## 实现进度（对照 PRD）

- [x] **切片 1：任务 + 清单核心**——收集箱 / 今天 / 最近7天 / 已完成 / 垃圾桶智能清单；自定义清单 CRUD；任务创建/完成/优先级/截止日期/软删除/恢复，全链路真实持久化。
- [x] **切片 2：日历**——日/3天/周时间轴 + 全天区 + 范围查询 + 「安排任务」面板 + 拖拽排期/移动/缩放 + 块详情 popover。
- [ ] 切片 3：番茄专注（进行中）
- [ ] 切片 4：四象限（重要×紧急，独立维度）
- [ ] 切片 5：习惯打卡
- [ ] 切片 6：倒数日
- [ ] 切片 7：标签、过滤器、子任务、自然语言快速添加
- [ ] 桌面形态：Electron 封装 + 多用户登录

详见同目录 PRD（`./效率清单-产品需求文档PRD.md`）。
