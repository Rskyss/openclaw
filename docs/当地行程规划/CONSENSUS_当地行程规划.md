# CONSENSUS — 当地行程规划

## 需求描述

新增 `trip_planner` 工具，用户到达一个城市后，能够：

1. 获取当地景点/美食/玩乐推荐（含评分、营业时间、门票）
2. 给定多个地点，自动优化游览顺序
3. 生成带时间节点的行程安排表
4. 生成多点导航地图

## 验收标准

### 功能验收

1. 用户说"我在西湖附近，推荐附近好玩的" → 返回分类推荐列表（景点/美食/娱乐），含评分、距离、营业时间
2. 用户说"想去灵隐寺、河坊街、南宋御街，怎么安排" → 返回最优游览顺序 + 各段路线 + 时间编排
3. 用户说"下午半天时间帮我安排西湖周边" → 结合时间窗口推荐 + 路线优化 + 行程表
4. 生成多点导航地图，标注所有景点和路线

### 技术验收

- 工具定义遵循现有 `AnyAgentTool` 模式
- 参数使用 TypeBox Schema
- 注册到 `openclaw-tools.ts` 和信任媒体列表
- 系统提示词更新，指导 AI 何时调用此工具
- 复用现有 `geocode()`、`amapGet()`、`generateNavMap()` 等函数

## 技术方案

### 数据来源（三层融合）

1. **高德地图**（基础层）：POI 搜索 `extensions=all`，获取名称、评分、营业时间、地址、坐标、类型
2. **web_search**（补充层）：搜索"[地点] [城市] 推荐 攻略"，获取网友评价和攻略信息
3. **小红书**（体验层）：复用 `searchXiaohongshu()` 获取网友实拍和避坑建议

### 路线优化算法

- **贪心最近点**：从当前位置出发，每次选直线距离最近的下一个未访问点
- 使用 Haversine 公式计算球面距离（无需调用高德 API）
- 优化完成后，调用高德步行/驾车 API 获取各段实际距离和耗时

### 工具设计

```
trip_planner(
  location: string,      // 当前位置，如 "西湖" "我在春熙路"
  city?: string,         // 城市名，默认从 location 推断
  interests?: string,    // 兴趣偏好，如 "美食" "历史文化" "自然风景"
  places?: string[],     // 指定要去的地点列表（用于多点路线优化）
  duration?: string,     // 可用时间，如 "半天" "3小时" "一整天"
  transport?: string,    // 交通方式偏好，"步行" | "驾车" | "公交"，默认"步行"
)
```

### 返回数据结构

```json
{
  "location": "西湖景区",
  "weather": { "condition": "晴", "temperature": "22°C" },
  "recommendations": [
    {
      "name": "灵隐寺",
      "type": "景点",
      "rating": "4.7",
      "distance": "2.3km",
      "business_hours": "07:00-18:00",
      "ticket": "飞来峰+灵隐寺 75元",
      "highlight": "千年古刹，杭州必去"
    }
  ],
  "itinerary": [
    {
      "order": 1,
      "name": "断桥残雪",
      "arrive": "14:00",
      "stay": "30min",
      "walk_to_next": "15min/1.2km"
    },
    {
      "order": 2,
      "name": "白堤",
      "arrive": "14:45",
      "stay": "20min",
      "walk_to_next": "10min/0.8km"
    }
  ],
  "route_map": { "image_path": "/tmp/trip_xxx.png" },
  "xiaohongshu_tips": "近期网友提到..."
}
```

## 技术约束

- 高德 API Key：复用 `process.env.AMAP_API_KEY`
- 小红书 MCP：依赖 `127.0.0.1:18060`，不可用时降级（不影响主功能）
- web_search：依赖现有 web_search 工具的底层函数，不可用时降级
- 工具代码放在 `src/agents/tools/amap-tool.ts` 中（与现有出行工具同文件）
- 静态地图 URL 长度限制：polyline 点数多时需采样

## 任务边界

- ✅ 当地 POI 推荐（景点/美食/娱乐）
- ✅ 多点路线优化（贪心最近点）
- ✅ 时间编排（考虑营业时间 + 步行/驾车耗时）
- ✅ 多点导航地图
- ✅ 天气感知
- ✅ 小红书/web 攻略融合
- ❌ 行程保存/导出
- ❌ 用户偏好学习
- ❌ 购票/预订
- ❌ 跨城交通
