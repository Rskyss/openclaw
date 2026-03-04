# ALIGNMENT — 当地行程规划

## 原始需求

用户到达一个城市后，在当地进行行程规划和路线安排。例如：

- "我在西湖附近，想玩半天，帮我安排一下"
- "我到了成都，推荐一下附近好吃的好玩的"
- "我想去灵隐寺、河坊街、南宋御街，怎么安排路线最顺"

## 项目上下文

### 技术栈

- TypeScript (ESM)，TypeBox 做参数 Schema
- 工具定义模式：`AnyAgentTool` 接口（name, label, description, parameters, execute）
- 工具注册位置：`src/agents/openclaw-tools.ts` 的 `createOpenClawTools()`
- 系统提示词：`src/agents/system-prompt.ts` 的 `buildProactivePlanningSection()`
- 媒体信任列表：`src/agents/pi-embedded-subscribe.tools.ts` 的 `TRUSTED_TOOL_RESULT_MEDIA`
- 高德地图 API Key：`process.env.AMAP_API_KEY`

### 现有出行工具（在 `src/agents/tools/amap-tool.ts`）

| 工具                    | 功能                     | 局限                       |
| ----------------------- | ------------------------ | -------------------------- |
| `maps_search`           | POI 关键词搜索、周边搜索 | 无评分、无营业时间、无门票 |
| `maps_route`            | 驾车路线规划 + 实时路况  | 仅 A→B 单段                |
| `maps_navigation_image` | 导航地图生成             | 仅两点之间                 |
| `smart_trip`            | 多模式出行综合分析       | 仅 A→B 单段，不支持多点    |
| `xhs_image_search`      | 小红书图片搜索           | 已有                       |
| `event_search`          | 活动实时信息             | 已有                       |

### 现有可复用能力

- `geocode()` — 地址→坐标
- `amapGet()` — 高德 API 封装
- `generateNavMap()` — 静态地图生成
- `getAmapWeather()` — 天气查询
- `searchXiaohongshu()` — 小红书搜索
- `web_search` 工具 — 网络搜索（可搜攻略、评分、门票）
- `jsonResult()` / `imageResult()` — 标准返回格式

### 高德地图 API 已用端点

```
✅ /v3/place/text          — POI 关键词搜索
✅ /v3/place/around        — 周边搜索
✅ /v3/geocode/geo         — 地址编码
✅ /v3/direction/driving   — 驾车路线
✅ /v3/direction/transit/integrated — 公交换乘
✅ /v3/direction/walking   — 步行路线
✅ /v3/staticmap           — 静态地图
✅ /v3/weather/weatherInfo — 天气
```

### 高德地图 API 可用但未用端点

```
❌ /v3/direction/driving（多途经点） — strategy + waypoints 参数支持途经点
❌ /v3/place/text extensions=all — 返回营业时间、评分等详细信息
```

## 需求理解

### 核心场景

1. **开放式推荐**："我在XX，推荐附近好玩的好吃的" → 需要 POI 推荐 + 分类 + 排序
2. **多点行程编排**："想去A、B、C，怎么安排最顺" → 需要多点路线优化 + 时间编排
3. **半日/全日规划**："下午半天时间，帮我安排" → 需要结合时间窗口 + 推荐 + 路线

### 边界确认

- **不做**：行程保存/导出、用户偏好学习、酒店预订、购票功能
- **不做**：跨城交通（高铁/飞机）
- **做**：当地 POI 推荐、多点路线优化、时间编排、营业时间感知

## 疑问清单（需确认）

### Q1: 推荐数据来源

高德 POI 搜索（`extensions=all`）可以返回评分和营业时间，但数据质量不如大众点评/小红书。

- **方案A**：纯高德数据 — 开发简单，但推荐质量一般
- **方案B**：高德 POI + web_search 补充 — 调用 web_search 搜"[地点] 推荐 评分"获取更丰富信息
- **方案C**：高德 POI + 小红书情报 — 复用现有 `searchXiaohongshu()` 获取网友推荐

### Q2: 多点路线优化算法

- **方案A**：纯 AI 决策 — 返回各点间距离矩阵，让 AI 自己排序（简单，但可能不够精确）
- **方案B**：贪心算法 — 每次选最近的下一个点（实现简单，90% 场景够用）
- **方案C**：全排列最优 — 对 N 个点做全排列，计算最短总路程（N≤8 时可行）

### Q3: 工具粒度

- **方案A**：新增 1 个 `trip_planner` 综合工具 — 一次调用搞定推荐+排序+路线
- **方案B**：新增 2 个工具 — `poi_recommend`（推荐）+ `route_optimize`（多点路线优化），AI 按需组合
