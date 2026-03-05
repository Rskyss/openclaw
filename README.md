# OpenClaw 智能助理 🦀

OpenClaw 是一款开源的智能大模型 Agent（智能体）框架。我们基于其深度定制了**出行与生活实况能力**，使它不仅仅是一个聊天机器，更是一位懂出行的"生活管家"。

## ✨ 核心特色功能

### 1. 🚲 智能路线推荐引擎（全新升级）

核心流水线采用**三引擎协作模式**，彻底杜绝 AI 凭空捏造路线：

```
用户："下班骑车20km，推荐路线"
         ↓
recommend_route 工具（强制触发）
    ├── Google 搜索（Gemini）→ 真实路线攻略
    └── 小红书搜索（XHS MCP）→ 骑友真实评价
         ↓
AI 提取真实途经点
         ↓
hiking_route_map → 高德地图画出骑行轨迹图
         ↓
最终回复：真实路线 + 路线地图图片
```

- **`recommend_route`**：路线推荐工具（新增）。用户发出"推荐骑行/徒步/跑步路线"请求时**系统强制调用**，内部自动同时触发 Google 搜索 + 小红书搜索，把真实的网络攻略和骑友评价返回给 AI，AI 才能基于真实数据提取途经点。
- **`hiking_route_map`**：多途经点户外路线地图生成工具（增强）。支持骑行、步行、徒步、跑步模式，使用高德骑行/驾车/步行导航 API 规划真实路线折线，并画出带编号标注的骑行地图。

### 2. 🗺️ 图文并茂的"聪明出行"向导 (`smart_trip`)

- **导航地图生成**：底层接入高德地图 API，自动规划并生成含车辆、步行及停车场的微缩路线图。
- **网友实拍聚合**：独创集成小红书场景搜索，把景点的最新"网友实拍"和避坑指南直接展示在聊天窗口中。
- **决策辅助**：自动结合新闻、天气及周边路况对出行时间给出贴心建议。

### 3. 🧠 多模态与超长上下文基础

- 核心支持调用 `Doubao-Seed-2.0-lite` 等新一代大语言模型。
- 长期记忆（`MEMORY`）与偏好保存：您的习惯一旦被记录，永久生效。

---

## 🚀 如何开始使用

### 1. 填入你自己的密钥 (API Keys)

> ⚠️ **安全警告**：本项目出于安全考虑，**没有内置或上传任何 API Key**。要使用搜索、地图等工具，你必须配置自己的访问凭证！

在运行环境（系统环境变量或 `~/.openclaw/openclaw.json`）里填入以下必需的密钥：

- **`AMAP_API_KEY`**：高德地图 Web 服务 API Key。用于路线规划、地理编码与静态地图生成。前往 [高德开放平台](https://lbs.amap.com/) 免费申请。
- **`GEMINI_API_KEY`**：用于 Google 联网搜索（`recommend_route` 的核心搜索引擎）以及可选的底座模型。

### 2. 启动小红书 MCP 服务（可选，但推荐）

小红书搜索通过独立的 MCP 服务提供，需要单独启动：

```bash
# 进入小红书 MCP 目录
cd tools/xiaohongshu-mcp

# 首次使用需要登录
./xiaohongshu-login-darwin-arm64

# 后台启动 MCP 服务（默认端口 18060）
nohup ./xiaohongshu-mcp-darwin-arm64 -port :18060 &
```

### 3. 启动 OpenClaw 主服务

```bash
# 安装依赖
npm install

# 构建（修改源码后需要重新执行）
npm run build

# 启动 Gateway 后端服务
node scripts/run-node.mjs gateway
```

### 4. 试试这些指令

- _"今晚下班想骑小布刷 20km，推荐一条环线"_
- _"今晚下班想去西溪湿地看灯会，现在那边什么情况？"_
- _"帮我看看怎么去西湖银泰性价比最高？最好有网友最近的实拍反馈。"_
- _"周末去哪爬山？"_

---

## 🛠️ 技术说明（开发者）

### 三引擎协作架构

| 引擎                | 角色       | 工具/服务                                |
| ------------------- | ---------- | ---------------------------------------- |
| **Google (Gemini)** | 路线推荐官 | `recommend_route` → Gemini Search API    |
| **小红书 (XHS)**    | 骑友评价员 | `recommend_route` → XHS MCP (port 18060) |
| **高德 (Amap)**     | 地图工程师 | `hiking_route_map` → Amap REST API       |

### 主要代码改动

- `src/agents/tools/amap-tool.ts`：新增 `recommend_route` 工具（内置 Google + 小红书搜索）、`hiking_route_map` 支持骑行模式、优化静态地图折线采样（防止 URL 超长报 `20003` 错误）、PNG 魔数校验防止保存损坏图片。
- `src/agents/openclaw-tools.ts`：注册 `recommend_route` 工具。
- `src/agents/system-prompt.ts`：强化 Exploration 模式指令，强制 AI 在推荐路线前必须先搜索。
- `src/agents/tools/web-search.ts`：Gemini 搜索添加自动重试逻辑。

### 排版控制

输出在服务端使用 `sharp` 对地图和实况图片进行尺寸重塑（地图 800px、组图 180px），兼容各类端内 Markdown 渲染。

---

> 该项目开源维护，欢迎点个 ⭐ Star！
