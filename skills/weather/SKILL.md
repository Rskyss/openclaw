---
name: weather
description: "Get current weather and forecasts via Open-Meteo. Use when: user asks about weather, temperature, or forecasts for any location. NOT for: historical weather data, severe weather alerts, or detailed meteorological analysis. No API key needed."
homepage: https://open-meteo.com
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }
---

# Weather Skill

Get current weather and forecasts using Open-Meteo. **No API key needed. Supports any city worldwide.**

## IMPORTANT: Use exec tool to run these curl commands. Do NOT use web_fetch or web_search.

---

## Step 1: Get coordinates for any city (no proxy needed)

Use `--data-urlencode` to handle Chinese city names correctly:

```bash
curl -s --max-time 8 -G "https://geocoding-api.open-meteo.com/v1/search" \
  --data-urlencode "name=城市名" \
  -d "count=1&language=zh&format=json"
```

Examples:

```bash
# 怀化
curl -s --max-time 8 -G "https://geocoding-api.open-meteo.com/v1/search" \
  --data-urlencode "name=怀化" -d "count=1&language=zh&format=json"

# 三亚
curl -s --max-time 8 -G "https://geocoding-api.open-meteo.com/v1/search" \
  --data-urlencode "name=三亚" -d "count=1&language=zh&format=json"
```

Response: `{"results":[{"name":"怀化市","latitude":27.56,"longitude":110.00,"timezone":"Asia/Shanghai"}]}`

**If `results` is empty**, retry with pinyin/English name (e.g., 厦门 → Xiamen, 成都 → Chengdu).

---

## Step 2: Get weather with coordinates (proxy required)

```bash
curl -s --max-time 10 -x http://127.0.0.1:8118 \
  "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=Asia%2FShanghai&forecast_days=7"
```

Example for 怀化 (lat=27.56, lon=110.00):

```bash
curl -s --max-time 10 -x http://127.0.0.1:8118 \
  "https://api.open-meteo.com/v1/forecast?latitude=27.56&longitude=110.00&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=Asia%2FShanghai&forecast_days=7"
```

---

## WMO Weather Code Reference

| Code  | Weather      |
| ----- | ------------ |
| 0     | 晴天 ☀️      |
| 1-3   | 少云/多云 ⛅ |
| 45,48 | 雾 🌫️        |
| 51-57 | 毛毛雨 🌦️    |
| 61-67 | 雨 🌧️        |
| 71-77 | 雪 ❄️        |
| 80-82 | 阵雨 🌦️      |
| 95-99 | 雷暴 ⛈️      |

---

## Quick Response Format

```
📍 [城市] 天气报告
🌡️ 当前: X°C，[天气描述]
💨 风速: X km/h
📅 今天: X-X°C，降水 Xmm
📅 明天: X-X°C，[天气描述]
```
