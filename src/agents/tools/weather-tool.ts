import { Type } from "@sinclair/typebox";
import { logWarn } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const AMAP_BASE = "https://restapi.amap.com";

// 高德天气 API — 国内稳定，复用 AMAP_API_KEY
// Step 1: 用地理编码接口把城市名 → adcode
// Step 2: 用天气接口（/v3/weather/weatherInfo）查实况 + 预报

async function amapGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${AMAP_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

// 城市名 → adcode（高德行政区划代码）
async function cityToAdcode(
  city: string,
  apiKey: string,
): Promise<{ adcode: string; name: string } | null> {
  try {
    const data = (await amapGet("/v3/geocode/geo", {
      address: city,
      key: apiKey,
      output: "json",
    })) as {
      status: string;
      geocodes?: Array<{ adcode: string; formatted_address: string; city: string }>;
    };
    if (data.status !== "1" || !data.geocodes?.length) {
      return null;
    }
    const g = data.geocodes[0];
    if (!g) {
      return null;
    }
    // adcode 取前 6 位（市级），避免街道级 adcode
    const adcode = g.adcode.slice(0, 6);
    return { adcode, name: g.city || g.formatted_address };
  } catch {
    return null;
  }
}

// 风力等级 → 描述
function windPowerDesc(power: string): string {
  const n = parseInt(power, 10);
  if (isNaN(n)) {
    return power;
  }
  if (n <= 3) {
    return "微风";
  }
  if (n <= 5) {
    return `${n}级风`;
  }
  return `${n}级大风`;
}

const GetWeatherSchema = Type.Object({
  city: Type.String({ description: "城市名称，支持中文，如 '杭州'、'余杭区'、'北京'" }),
  days: Type.Optional(
    Type.Number({
      description: "预报天数（1-4，默认3），高德最多支持4天预报",
      minimum: 1,
      maximum: 4,
    }),
  ),
});

export function createGetWeatherTool(): AnyAgentTool {
  return {
    name: "get_weather",
    label: "Get Weather",
    description:
      "获取指定城市的当前天气和未来几天的天气预报（使用高德地图天气接口，国内稳定）。支持中文城市名。",
    parameters: GetWeatherSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("get_weather: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key（AMAP_API_KEY）" });
      }

      const params = args as Record<string, unknown>;
      const city = readStringParam(params, "city", { required: true });
      const days = typeof params.days === "number" ? Math.min(4, Math.max(1, params.days)) : 3;

      // Step 1: 城市名 → adcode
      const geo = await cityToAdcode(city, apiKey);
      if (!geo) {
        logWarn(`get_weather: geocode failed for city="${city}"`);
        return jsonResult({
          error: `无法识别城市"${city}"，请使用更标准的城市名称，如"杭州"或"余杭区"`,
          city,
        });
      }

      // Step 2: 查实况天气（extensions=base）
      let liveData: unknown;
      try {
        liveData = await amapGet("/v3/weather/weatherInfo", {
          city: geo.adcode,
          key: apiKey,
          extensions: "base",
          output: "json",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `获取实况天气失败: ${message}`, city: geo.name });
      }

      const live = liveData as {
        status: string;
        lives?: Array<{
          city: string;
          weather: string;
          temperature: string;
          winddirection: string;
          windpower: string;
          humidity: string;
          reporttime: string;
        }>;
      };

      if (live.status !== "1" || !live.lives?.length) {
        return jsonResult({ error: `获取天气数据失败，请稍后重试`, city: geo.name });
      }

      const lw = live.lives[0];

      // Step 3: 查预报天气（extensions=all，最多4天）
      let forecastResult: Array<{
        date: string;
        dayWeather: string;
        nightWeather: string;
        maxTemp: string;
        minTemp: string;
        dayWind: string;
      }> = [];

      try {
        const forecastData = (await amapGet("/v3/weather/weatherInfo", {
          city: geo.adcode,
          key: apiKey,
          extensions: "all",
          output: "json",
        })) as {
          status: string;
          forecasts?: Array<{
            casts: Array<{
              date: string;
              dayweather: string;
              nightweather: string;
              daytemp: string;
              nighttemp: string;
              daywind: string;
              daypower: string;
            }>;
          }>;
        };

        if (forecastData.status === "1" && forecastData.forecasts?.[0]?.casts) {
          forecastResult = forecastData.forecasts[0].casts.slice(0, days).map((c) => ({
            date: c.date,
            dayWeather: c.dayweather,
            nightWeather: c.nightweather,
            maxTemp: `${c.daytemp}°C`,
            minTemp: `${c.nighttemp}°C`,
            dayWind: `${c.daywind}风 ${windPowerDesc(c.daypower)}`,
          }));
        }
      } catch {
        // 预报失败不影响实况数据返回
      }

      return jsonResult({
        city: lw.city || geo.name,
        current: {
          weather: lw.weather,
          temperature: `${lw.temperature}°C`,
          wind: `${lw.winddirection}风 ${windPowerDesc(lw.windpower)}`,
          humidity: `${lw.humidity}%`,
          reportTime: lw.reporttime,
        },
        forecast: forecastResult,
        // 给模型的提示：根据天气给出出行建议
        tips: (() => {
          const w = lw.weather;
          const t = parseInt(lw.temperature, 10);
          const tips: string[] = [];
          if (w.includes("雨") || w.includes("雪")) {
            tips.push("建议携带雨伞或雨衣");
          }
          if (w.includes("雪") || w.includes("冰")) {
            tips.push("路面可能湿滑，驾车需谨慎");
          }
          if (t >= 35) {
            tips.push("天气炎热，注意防暑，备好水");
          }
          if (t <= 5) {
            tips.push("天气较冷，注意保暖");
          }
          if (w.includes("雾")) {
            tips.push("能见度低，驾车需开雾灯并保持车距");
          }
          return tips;
        })(),
      });
    },
  };
}
