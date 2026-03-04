# ACCEPTANCE — 当地行程规划

## 验收结果

### 功能验收 ✅

| 验收项       | 状态 | 说明                                                       |
| ------------ | ---- | ---------------------------------------------------------- |
| 推荐模式     | ✅   | 输入位置+兴趣，返回周边 POI 推荐（含评分、距离、营业时间） |
| 规划模式     | ✅   | 输入多个地点，贪心算法优化路线顺序，编排时间表             |
| 天气感知     | ✅   | 并行获取天气数据                                           |
| 小红书情报   | ✅   | 融合小红书网友推荐和避坑建议                               |
| 多点地图     | ✅   | 生成多标记点静态地图                                       |
| 时间编排     | ✅   | 考虑交通耗时、停留时间、营业时间                           |
| 时间窗口约束 | ✅   | 超出可用时间时警告用户精简行程                             |

### 技术验收 ✅

| 验收项            | 状态 | 说明                                                              |
| ----------------- | ---- | ----------------------------------------------------------------- |
| AnyAgentTool 接口 | ✅   | 遵循现有工具定义模式                                              |
| TypeBox Schema    | ✅   | 参数定义完整                                                      |
| 工具注册          | ✅   | openclaw-tools.ts 已添加                                          |
| 媒体信任列表      | ✅   | pi-embedded-subscribe.tools.ts 已添加                             |
| 系统提示词        | ✅   | Travel Assistance 章节已更新，含工具选择指南                      |
| 类型检查          | ✅   | pnpm tsgo 无新增错误                                              |
| 复用现有函数      | ✅   | geocode、amapGet、getAmapWeather、walkingRoute、searchXiaohongshu |

## 修改文件清单

| 文件                                        | 修改内容                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| `src/agents/tools/amap-tool.ts`             | 新增 6 个辅助函数 + createTripPlannerTool()                |
| `src/agents/openclaw-tools.ts`              | 导入并注册 trip_planner 工具                               |
| `src/agents/pi-embedded-subscribe.tools.ts` | 添加 trip_planner 到媒体信任列表                           |
| `src/agents/system-prompt.ts`               | Travel Assistance 章节新增 trip_planner 说明和工具选择指南 |
