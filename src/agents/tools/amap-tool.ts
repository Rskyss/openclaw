import { Type } from "@sinclair/typebox";
import { logWarn } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const AMAP_BASE = "https://restapi.amap.com";

// Amap is a Chinese API, direct access works inside China.
async function amapGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${AMAP_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Amap API`);
  }
  return res.json();
}

async function geocode(
  address: string,
  apiKey: string,
  city?: string,
): Promise<{ lng: string; lat: string; formatted: string } | null> {
  try {
    // 1. 优先使用 POI 搜索（更适合解析 "浙一余杭院区"、"翡翠城" 等自然地点名词）
    const textParams: Record<string, string> = { keywords: address, key: apiKey, output: "json" };
    if (city) {
      textParams.city = city;
    }
    const textData = (await amapGet("/v3/place/text", textParams)) as {
      status: string;
      pois?: Array<{
        name: string;
        location: string;
        address: string | [];
        cityname: string;
        districtname: string;
      }>;
    };
    if (textData.status === "1" && textData.pois && textData.pois.length > 0) {
      const p = textData.pois[0];
      if (p && p.location) {
        const [lng, lat] = p.location.split(",");
        const addrStr = Array.isArray(p.address) ? "" : p.address;
        const formatted = `${p.cityname || ""}${p.districtname || ""}${addrStr}${p.name}`;
        if (lng && lat) {
          return { lng, lat, formatted };
        }
      }
    }

    // 2. 如果 POI 搜不到，再降级使用地理编码 API（适合标准结构化街道地址）
    const params: Record<string, string> = { address, key: apiKey, output: "json" };
    if (city) {
      params.city = city;
    }
    const data = (await amapGet("/v3/geocode/geo", params)) as {
      status: string;
      geocodes?: Array<{ location: string; formatted_address: string }>;
    };
    if (data.status !== "1" || !data.geocodes?.length) {
      return null;
    }
    const g = data.geocodes[0];
    if (!g) {
      return null;
    }
    const [lng, lat] = g.location.split(",");
    return { lng: lng ?? "", lat: lat ?? "", formatted: g.formatted_address };
  } catch {
    return null;
  }
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}小时${m}分钟`;
  }
  return `${m}分钟`;
}

function fmtDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)}公里`;
  }
  return `${meters}米`;
}

/**
 * 把中文自然语言时间 / ISO时间字符串 / "HH:MM" 格式转换为 Unix 时间戳（秒）。
 * 支持："下午4点"、"16:00"、"明天上午9点半"、"下午3点30分"、"今天下午4点" 等。
 * 如果只提供时分（无日期），默认为今天；如果该时间已过去，则顺延到明天。
 */
function parseDepartureTime(input: string): number | null {
  const now = new Date();

  // 尝试直接解析 ISO / RFC 日期字符串
  const directParsed = Date.parse(input);
  if (!isNaN(directParsed)) {
    return Math.floor(directParsed / 1000);
  }

  // 中文时间解析
  const s = input.trim();

  // 检测是否是"明天"
  const isTomorrow = s.includes("明天") || s.includes("明日");

  // 检测上下午
  const isAfternoon = /下午|PM|pm/.test(s);
  const isMorning = /上午|早上|AM|am/.test(s);

  // 尝试提取时:分
  let hour: number | null = null;
  let minute = 0;

  // 匹配 "HH:MM" 格式
  const colonMatch = s.match(/(\d{1,2}):(\d{2})/);
  if (colonMatch) {
    hour = parseInt(colonMatch[1], 10);
    minute = parseInt(colonMatch[2], 10);
  } else {
    // 匹配中文数字时间，如 "4点"、"4点30"、"4点30分"、"四点半"
    const chMatch = s.match(/(\d{1,2})点([三二四五六七八九十半0-9]*)/);
    if (chMatch) {
      hour = parseInt(chMatch[1], 10);
      const minPart = chMatch[2] ?? "";
      if (minPart === "半") {
        minute = 30;
      } else {
        const minNum = parseFloat(minPart);
        minute = isNaN(minNum) ? 0 : Math.floor(minNum);
      }
    }
  }

  if (hour === null) {
    return null;
  }

  // 处理 12 小时制
  if (isAfternoon && hour < 12) {
    hour += 12;
  } else if (isMorning && hour === 12) {
    hour = 0;
  } else if (!isMorning && !isAfternoon && hour < 7) {
    // 如果未指定上下午且小时 < 7（比如 "4点"），默认为下午
    hour += 12;
  }

  const target = new Date(now);
  if (isTomorrow) {
    target.setDate(target.getDate() + 1);
  }
  target.setHours(hour, minute, 0, 0);

  // 如果目标时间已过去（且没有指定明天），顺延到明天
  if (!isTomorrow && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return Math.floor(target.getTime() / 1000);
}

// ─── Tool 1: maps_search ─────────────────────────────────────────────────────

const MapsSearchSchema = Type.Object({
  keywords: Type.String({
    description:
      "搜索关键词，如 '停车场'、'浙江大学医学院附属第一医院余杭院区'。也可用于解决地点歧义：当目的地有多个院区/分部时，先用此工具搜索确认准确地址，再调 maps_route",
  }),
  city: Type.Optional(Type.String({ description: "城市名，如 '杭州'，缩小搜索范围" })),
  near: Type.Optional(
    Type.String({ description: "附近地址，设置后改为周边搜索，如 '市中心医院'" }),
  ),
  radius: Type.Optional(
    Type.Number({
      description: "周边搜索半径（米，默认1000），仅 near 参数存在时生效",
      minimum: 100,
      maximum: 5000,
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "返回结果数量（默认5，最多10）", minimum: 1, maximum: 10 }),
  ),
});

export function createMapsSearchTool(): AnyAgentTool {
  return {
    name: "maps_search",
    label: "Maps Search",
    description: "使用高德地图搜索地点、停车场、医院等 POI 信息。支持关键词搜索和周边搜索。",
    parameters: MapsSearchSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("maps_search: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key（AMAP_API_KEY）" });
      }

      const params = args as Record<string, unknown>;
      const keywords = readStringParam(params, "keywords", { required: true });
      const city = typeof params.city === "string" ? params.city : undefined;
      const near = typeof params.near === "string" ? params.near : undefined;
      const radius = typeof params.radius === "number" ? params.radius : 1000;
      const limit = typeof params.limit === "number" ? Math.min(10, params.limit) : 5;

      try {
        if (near) {
          // Nearby search: geocode the `near` address first
          const geo = await geocode(near, apiKey, city);
          if (!geo) {
            return jsonResult({ error: `无法找到地址"${near}"的坐标` });
          }
          const data = (await amapGet("/v3/place/around", {
            location: `${geo.lng},${geo.lat}`,
            keywords,
            radius: String(radius),
            key: apiKey,
            output: "json",
            offset: String(limit),
            extensions: "base",
          })) as {
            status: string;
            pois?: Array<{
              name: string;
              address: string | [];
              location: string;
              distance: string;
              type: string;
              tel: string | [];
            }>;
          };

          if (data.status !== "1" || !data.pois?.length) {
            return jsonResult({ error: `未找到"${near}"附近的"${keywords}"`, near, keywords });
          }

          const results = data.pois.map((p) => ({
            name: p.name,
            address: Array.isArray(p.address) ? "" : p.address,
            distance: fmtDistance(Number(p.distance)),
            type: p.type,
            tel: Array.isArray(p.tel) ? "" : p.tel,
          }));

          return jsonResult({ near: geo.formatted, keywords, radius: `${radius}米`, results });
        } else {
          // Keyword search
          const reqParams: Record<string, string> = {
            keywords,
            key: apiKey,
            output: "json",
            offset: String(limit),
            extensions: "base",
          };
          if (city) {
            reqParams.city = city;
          }

          const data = (await amapGet("/v3/place/text", reqParams)) as {
            status: string;
            pois?: Array<{
              name: string;
              address: string | [];
              location: string;
              cityname: string;
              type: string;
              tel: string | [];
            }>;
          };

          if (data.status !== "1" || !data.pois?.length) {
            return jsonResult({ error: `未找到"${keywords}"相关地点`, keywords, city });
          }

          const results = data.pois.map((p) => ({
            name: p.name,
            address: Array.isArray(p.address) ? "" : p.address,
            city: p.cityname,
            type: p.type,
            tel: Array.isArray(p.tel) ? "" : p.tel,
          }));

          return jsonResult({ keywords, city, results });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `搜索失败: ${message}` });
      }
    },
  };
}

// ─── Tool 2: maps_route ───────────────────────────────────────────────────────

const MapsRouteSchema = Type.Object({
  origin: Type.String({ description: "出发地址，如 '某某小区东门'" }),
  destination: Type.String({
    description:
      "目的地地址。⚠️ 若目的地是医院/园区等可能有多个院区的场所，请先用 maps_search 确认准确地址后再填入此字段，避免导航到错误院区",
  }),
  city: Type.Optional(Type.String({ description: "城市名，帮助解析地址，如 '杭州'" })),
  strategy: Type.Optional(
    Type.String({
      description:
        "路线策略：speed（速度优先，默认）、cost（费用优先）、distance（距离优先）、avoid_highway（不走高速）",
      enum: ["speed", "cost", "distance", "avoid_highway"],
    }),
  ),
  departure_time: Type.Optional(
    Type.String({
      description:
        "预计出发时间，支持中文自然语言，如 '下午3点'、'明天上午9点半'、'16:00'。传入后高德会返回该时段历史路况预测，结果比实时路况更准确。当用户提到要 '几点到达' 时，用 arrival_time 代替此参数。",
    }),
  ),
  arrival_time: Type.Optional(
    Type.String({
      description:
        "期望到达时间，支持中文自然语言，如 '下午4点'、'16:00'。传入后系统会结合路线时长自动计算出\"建议出发时间\"，并在预测该时间段路况后返回。当用户说 '我X点要到达' 或 '我有个X点的预约' 时，请传此参数而不是 departure_time。",
    }),
  ),
});

export function createMapsRouteTool(): AnyAgentTool {
  return {
    name: "maps_route",
    label: "Maps Route",
    description: `⛔【强制前置规则】如果用户是在询问"怎么去某地"、"出行方案"或"路线"等，你必须先调用 smart_trip 工具进行智能出行分析，再根据 smart_trip 的推荐结果决定是否调用本工具。禁止直接调用 maps_route 作为用户出行咨询的第一个工具！
只有在以下情况才允许直接调用本工具：
- smart_trip 已执行，且推荐方案为"驾车"或"打车"
- 用户明确指定了"我要开车去"或"帮我算驾车路线"

使用高德地图规划驾车路线，获取预估耗时、主要道路和路况等。
    
【系统强制指令 1：必须调用图片生成】
获取到此处返回的路线信息后，你必须【紧接着调用 maps_navigation_image 工具】！千万不能口头说“地图已生成”，而是必须进行实质性的 tool_call 操作来生成图片！

【系统强制指令 2：必须严格使用官方排版模板】
绝不可套用你自己的旧回答或胡乱编造（如不要错把儿保认作浙一！请仔细阅读本工具返回的具体距离与地点数据）。
在你输出的内容中，必须包含并严格遵守以下5个区块的格式（使用加粗、列表和对应的Emoji）：
1. 🚗 行程概览（写入返回的实际起终点、distance、duration、费用）
2. ⏰ 出发建议（建议出发时间及理由）
3. 🚦 路况及预测（必须根据返回的 traffic_status 准确说明，不可遗漏）
4. 🛣️ 推荐路线（写入返回的 main_roads）
5. 🅿️ 停车指引（这里请综合你从 maps_navigation_image 里看到的停车场信息，不要瞎编）`,
    parameters: MapsRouteSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("maps_route: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key（AMAP_API_KEY）" });
      }

      const params = args as Record<string, unknown>;
      const originAddr = readStringParam(params, "origin", { required: true });
      const destAddr = readStringParam(params, "destination", { required: true });
      const city = typeof params.city === "string" ? params.city : undefined;
      const strategyInput = typeof params.strategy === "string" ? params.strategy : "speed";
      const departureTimeStr =
        typeof params.departure_time === "string" ? params.departure_time : undefined;
      const arrivalTimeStr =
        typeof params.arrival_time === "string" ? params.arrival_time : undefined;

      // 解析时间参数：arrival_time 优先，转换为 departure_time 使用（先估算路线，后扣除得出出发时间）
      // 对于 arrival_time，我们先用 departure_time 获取路线，再根据实际 duration 倒推
      const timeInput = departureTimeStr ?? arrivalTimeStr;
      const parsedTimestamp = timeInput ? parseDepartureTime(timeInput) : null;
      const isArrivalMode = Boolean(arrivalTimeStr && !departureTimeStr);

      // Map strategy to Amap strategy code
      const strategyMap: Record<string, string> = {
        speed: "0", // 速度优先（考虑实时路况）
        cost: "1", // 费用优先
        distance: "2", // 距离优先
        avoid_highway: "10", // 不走高速
      };
      const strategy = strategyMap[strategyInput] ?? "0";

      // Geocode both addresses
      const [originGeo, destGeo] = await Promise.all([
        geocode(originAddr, apiKey, city),
        geocode(destAddr, apiKey, city),
      ]);

      if (!originGeo) {
        return jsonResult({ error: `无法解析出发地址"${originAddr}"，请提供更详细的地址` });
      }
      if (!destGeo) {
        return jsonResult({ error: `无法解析目的地地址"${destAddr}"，请提供更详细的地址` });
      }

      try {
        type TmcItem = { lcode: string; distance: string; status: string };
        type StepItem = { road: string; instruction: string; tmcs?: TmcItem[] };
        // 构建高德导航请求参数
        const driveParams: Record<string, string> = {
          origin: `${originGeo.lng},${originGeo.lat}`,
          destination: `${destGeo.lng},${destGeo.lat}`,
          key: apiKey,
          extensions: "all",
          strategy,
          output: "json",
        };

        // 传入出发时间戳（Unix秒），高德会基于历史大数据预测该时段路况
        if (parsedTimestamp) {
          driveParams.departure_time = String(parsedTimestamp);
        }

        const data = (await amapGet("/v3/direction/driving", driveParams)) as {
          status: string;
          info: string;
          route?: {
            taxi_cost: string;
            paths: Array<{
              distance: string;
              duration: string;
              steps: StepItem[];
            }>;
          };
        };

        if (data.status !== "1" || !data.route?.paths?.length) {
          return jsonResult({ error: `路线规划失败: ${data.info ?? "未知错误"}` });
        }

        const path = data.route.paths[0];
        if (!path) {
          return jsonResult({ error: "未找到可用路线" });
        }

        const durationSec = Number(path.duration);
        const distanceM = Number(path.distance);

        // Extract key roads from steps (deduplicate)
        const roads = [
          ...new Set(
            path.steps
              .map((s) => s.road?.trim())
              .filter((r): r is string => Boolean(r) && r.length > 0),
          ),
        ].slice(0, 6);

        // 汇总实时路况：遍历所有步骤的 tmcs（拥堵片段）
        const allTmcs: TmcItem[] = path.steps.flatMap((s) => s.tmcs ?? []);
        const trafficSummary = aggregateTraffic(allTmcs);

        const durationMin = Math.ceil(durationSec / 60);

        // 计算建议出发时间（仅 arrival_time 模式）
        let suggestedDepartureTime: string | undefined;
        let suggestedDepartureNote: string | undefined;
        if (isArrivalMode && parsedTimestamp) {
          // 预留停车+步行缓冲（医院/大型场所建议 20 分钟）
          const bufferMin = 20;
          const totalMin = durationMin + bufferMin;
          const departureTs = parsedTimestamp - totalMin * 60;
          const departureDate = new Date(departureTs * 1000);
          const hh = departureDate.getHours().toString().padStart(2, "0");
          const mm = departureDate.getMinutes().toString().padStart(2, "0");
          suggestedDepartureTime = `${hh}:${mm}`;
          suggestedDepartureNote = `基于预测行驶时间 ${durationMin} 分钟 + 停车/步行缓冲 ${bufferMin} 分钟（共 ${totalMin} 分钟），建议最晚 ${hh}:${mm} 出发`;
        }

        const arrivalTimestampFormatted =
          isArrivalMode && parsedTimestamp
            ? new Date(parsedTimestamp * 1000).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : undefined;

        return jsonResult({
          _SYSTEM_NEXT_REQUIRED_ACTION: `⚡ 你现在必须立即调用 maps_navigation_image 工具！参数：origin="${originAddr}", destination="${destAddr}"${city ? `, city="${city}"` : ""}。这是强制要求，不是可选的。调用完成前不要输出任何文字。`,
          geocoded_origin: originGeo.formatted,
          geocoded_destination: destGeo.formatted,
          internal_note:
            "核查 geocoded_destination 是否与用户期望院区一致，不符则重新搜索纠正，但不要把这个核查过程说给用户听",
          duration: fmtDuration(durationSec),
          duration_minutes: durationMin,
          distance: fmtDistance(distanceM),
          taxi_cost_estimate: data.route.taxi_cost ? `约${data.route.taxi_cost}元` : undefined,
          main_roads: roads,
          strategy: strategyInput,
          traffic_status: trafficSummary.level,
          traffic_tip: trafficSummary.tip,
          ...(arrivalTimestampFormatted ? { target_arrival_time: arrivalTimestampFormatted } : {}),
          ...(suggestedDepartureTime ? { suggested_departure_time: suggestedDepartureTime } : {}),
          ...(suggestedDepartureNote ? { suggested_departure_note: suggestedDepartureNote } : {}),
          traffic_prediction_note: parsedTimestamp
            ? `路况数据基于高德历史大数据对 ${timeInput} 时段的预测，比实时路况更准确`
            : "路况数据为当前实时路况",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `路线规划失败: ${message}` });
      }
    },
  };
}

// 把高德 tmcs 路况片段汇总成一个综合评级
function aggregateTraffic(tmcs: Array<{ distance: string; status: string }>): {
  level: string;
  tip: string;
} {
  if (!tmcs.length) {
    return { level: "未知", tip: "" };
  }

  // 统计各状态对应的路段距离（米）
  const distByStatus: Record<string, number> = {};
  let totalKnown = 0;
  for (const t of tmcs) {
    const d = Number(t.distance) || 0;
    const s = t.status || "未知";
    distByStatus[s] = (distByStatus[s] ?? 0) + d;
    if (s !== "未知") {
      totalKnown += d;
    }
  }

  const congested = (distByStatus["拥堵"] ?? 0) + (distByStatus["严重拥堵"] ?? 0);
  const slow = distByStatus["缓行"] ?? 0;
  const severe = distByStatus["严重拥堵"] ?? 0;
  const base = totalKnown || 1;

  if (severe / base > 0.2) {
    return { level: "严重拥堵", tip: "全程严重拥堵，建议推迟出发或考虑绕行" };
  }
  if (congested / base > 0.3) {
    return { level: "拥堵", tip: "路上比较堵，建议提前30分钟出发" };
  }
  if ((congested + slow) / base > 0.3) {
    return { level: "局部缓行", tip: "部分路段有缓行，建议提前15分钟出发" };
  }
  return { level: "畅通", tip: "" };
}

// ─── Tool 3: maps_navigation_image ────────────────────────────────────────────

const MapsNavImageSchema = Type.Object({
  origin: Type.String({ description: "出发地地址，如 '某某小区'" }),
  destination: Type.String({ description: "目的地地址，如 '市中心医院'" }),
  city: Type.Optional(Type.String({ description: "城市名，如 '北京'" })),
});

export function createMapsNavImageTool(): AnyAgentTool {
  return {
    name: "maps_navigation_image",
    label: "Navigation Map Image",
    description:
      "生成导航地图图片，返回图片的本地路径。【强制要求】收到此工具的返回结果后，你在写最终文字回复时，必须把返回的 image_path 字段写在你回复的【第一行】，格式为：MEDIA:<image_path的值>（单独一行，无其他文字）。写完 MEDIA 行后再写正常的出行建议文字。这样图片才会和文字显示在同一条消息里。你不需要解释这个过程，直接执行即可。",
    parameters: MapsNavImageSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("maps_navigation_image: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key" });
      }

      const params = args as Record<string, unknown>;
      const origin = readStringParam(params, "origin", { required: true });
      const destination = readStringParam(params, "destination", { required: true });
      const city = typeof params.city === "string" ? params.city : undefined;

      // Step 1: 解析起终点坐标
      const originGeo = await geocode(origin, apiKey, city);
      if (!originGeo) {
        return jsonResult({ error: `无法解析出发地"${origin}"的坐标` });
      }
      const destGeo = await geocode(destination, apiKey, city);
      if (!destGeo) {
        return jsonResult({ error: `无法解析目的地"${destination}"的坐标` });
      }

      // Step 2: 获取驾车路线（含 polyline 坐标）
      type StepItem = { road: string; instruction: string; polyline: string };
      let routePolyline = "";
      try {
        const driveData = (await amapGet("/v3/direction/driving", {
          origin: `${originGeo.lng},${originGeo.lat}`,
          destination: `${destGeo.lng},${destGeo.lat}`,
          key: apiKey,
          extensions: "all",
          strategy: "0",
          output: "json",
        })) as {
          status: string;
          route?: { paths: Array<{ steps: StepItem[] }> };
        };
        if (driveData.status === "1" && driveData.route?.paths?.[0]) {
          // 把所有 step 的 polyline 拼起来
          routePolyline = driveData.route.paths[0].steps
            .map((s) => s.polyline)
            .filter(Boolean)
            .join(";");
        }
      } catch {
        // 路线获取失败不阻塞，地图上只显示标注点
      }

      // Step 3: 搜索目的地附近停车场
      type PoiItem = { name: string; location: string; address: string };
      let parkingSpots: PoiItem[] = [];
      try {
        const searchData = (await amapGet("/v3/place/around", {
          location: `${destGeo.lng},${destGeo.lat}`,
          keywords: "停车场",
          radius: "500",
          key: apiKey,
          output: "json",
          offset: "3",
          sortrule: "0", // 0 表示按距离排序，防止返回远处高权重的商场停车场
        })) as { status: string; pois?: PoiItem[] };
        if (searchData.status === "1" && searchData.pois?.length) {
          parkingSpots = searchData.pois.slice(0, 3);
        }
      } catch {
        // 停车场搜索失败不阻塞
      }

      // Step 4: 拼接高德静态地图 URL
      // markers: 起点=绿色(起), 终点=红色(终), 停车场=蓝色(P)
      const markers: string[] = [];
      markers.push(`large,0x00CC00,起:${originGeo.lng},${originGeo.lat}`);
      markers.push(`large,0xFF0000,终:${destGeo.lng},${destGeo.lat}`);
      for (const p of parkingSpots) {
        markers.push(`mid,0x0000FF,P:${p.location}`);
      }

      const staticUrl = new URL(`${AMAP_BASE}/v3/staticmap`);
      staticUrl.searchParams.set("key", apiKey);
      staticUrl.searchParams.set("size", "800*600");
      staticUrl.searchParams.set("scale", "2"); // 高清
      staticUrl.searchParams.set("markers", markers.join("|"));

      // 添加路线 path（蓝色线）
      if (routePolyline) {
        // 高德 polyline 格式: lng,lat;lng,lat — 静态地图的 paths 也用这个格式
        // 如果坐标点太多（>200），需要抽稀以免 URL 过长
        let points = routePolyline.split(";");
        if (points.length > 200) {
          // 等间距抽稀到 200 个点
          const step = Math.ceil(points.length / 200);
          const sampled: string[] = [];
          for (let i = 0; i < points.length; i += step) {
            const pt = points[i];
            if (pt) {
              sampled.push(pt);
            }
          }
          // 确保最后一个点
          const lastPt = points[points.length - 1];
          if (lastPt && sampled[sampled.length - 1] !== lastPt) {
            sampled.push(lastPt);
          }
          points = sampled;
        }
        const pathStr = `6,0x0088FF,1,,:${points.join(";")}`;
        staticUrl.searchParams.set("paths", pathStr);
      }

      // Step 5: 下载图片并保存到临时文件
      try {
        const imgRes = await fetch(staticUrl.toString());
        if (!imgRes.ok) {
          return jsonResult({ error: `静态地图生成失败: HTTP ${imgRes.status}` });
        }
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());

        // 保存到 OpenClaw 临时目录（系统安全策略要求路径在 /tmp/openclaw/ 下）
        const fs = await import("node:fs/promises");
        const tmpDir = "/tmp/openclaw";
        await fs.mkdir(tmpDir, { recursive: true });
        const tmpPath = `${tmpDir}/nav-map-${Date.now()}.png`;
        await fs.writeFile(tmpPath, imgBuf);

        // 构建停车场说明文本
        const parkingDesc = parkingSpots.length
          ? parkingSpots
              .map((p, i) => `${i + 1}. ${p.name}（${p.address || "详见地图蓝色P标注"}）`)
              .join("\n")
          : "未找到附近停车场";

        // ⚠️ 不在工具结果里放 MEDIA:，而是把路径给 AI，让 AI 在文字回复里嵌入
        return jsonResult({
          _SYSTEM_IMAGE_INSTRUCTION: `✅ 导航地图已生成。你现在必须把以下 MEDIA 路径写在你最终文字回复的【第一行】，格式严格如下（不要加引号、不要加任何前后文字，单独一行）：\nMEDIA:${tmpPath}\n\n写完 MEDIA 行之后，在新的一段继续写你的出行分析文字即可。`,
          image_path: tmpPath,
          parking_info: parkingDesc,
          parking_names: parkingSpots.map((p) => p.name),
          map_description:
            "图中绿色标注为出发地，红色标注为目的地，蓝色P标注为附近停车场，蓝色线为推荐驾车路线。",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `地图图片下载失败: ${message}` });
      }
    },
  };
}

// ─── 内部辅助函数：公交地铁换乘路线 ──────────────────────────────────────────

interface TransitResult {
  duration_minutes: number;
  walking_distance_meters: number;
  cost_yuan: number;
  transfers: number;
  segments_desc: string[];
  nightflag: boolean;
}

async function transitRoute(
  originLng: string,
  originLat: string,
  destLng: string,
  destLat: string,
  city: string,
  apiKey: string,
): Promise<TransitResult | null> {
  try {
    const data = (await amapGet("/v3/direction/transit/integrated", {
      origin: `${originLng},${originLat}`,
      destination: `${destLng},${destLat}`,
      city,
      key: apiKey,
      strategy: "0",
      extensions: "all",
      output: "json",
    })) as {
      status: string;
      route?: {
        transits?: Array<{
          cost: string;
          duration: string;
          walking_distance: string;
          nightflag: string;
          segments?: Array<{
            bus?: {
              buslines?: Array<{
                name: string;
                via_num: string;
                departure_stop?: { name: string };
                arrival_stop?: { name: string };
              }>;
            };
            railway?: { name: string };
            walking?: { distance: string };
          }>;
        }>;
      };
    };
    if (data.status !== "1" || !data.route?.transits?.length) {
      return null;
    }
    const t = data.route.transits[0];
    if (!t) {
      return null;
    }

    const segments: string[] = [];
    let transfers = 0;
    for (const seg of t.segments ?? []) {
      if (seg.bus?.buslines?.length) {
        const line = seg.bus.buslines[0];
        if (line) {
          segments.push(`${line.name}（${line.via_num || "?"}站）`);
          transfers++;
        }
      } else if (seg.railway) {
        segments.push(`🚄 ${seg.railway.name}`);
        transfers++;
      }
    }
    if (transfers > 0) {
      transfers--;
    }

    return {
      duration_minutes: Math.ceil(Number(t.duration) / 60),
      walking_distance_meters: Number(t.walking_distance) || 0,
      cost_yuan: Number(t.cost) || 0,
      transfers,
      segments_desc: segments,
      nightflag: t.nightflag === "1",
    };
  } catch {
    return null;
  }
}

// ─── 内部辅助函数：步行路线 ──────────────────────────────────────────────────

interface WalkingResult {
  duration_minutes: number;
  distance_meters: number;
}

async function walkingRoute(
  originLng: string,
  originLat: string,
  destLng: string,
  destLat: string,
  apiKey: string,
): Promise<WalkingResult | null> {
  try {
    const data = (await amapGet("/v3/direction/walking", {
      origin: `${originLng},${originLat}`,
      destination: `${destLng},${destLat}`,
      key: apiKey,
      output: "json",
    })) as {
      status: string;
      route?: { paths?: Array<{ distance: string; duration: string }> };
    };
    if (data.status !== "1" || !data.route?.paths?.length) {
      return null;
    }
    const p = data.route.paths[0];
    if (!p) {
      return null;
    }
    return {
      duration_minutes: Math.ceil(Number(p.duration) / 60),
      distance_meters: Number(p.distance) || 0,
    };
  } catch {
    return null;
  }
}

// ─── 内部辅助函数：天气查询 ──────────────────────────────────────────────────

interface WeatherResult {
  weather: string;
  temperature: string;
  wind: string;
  isRainy: boolean;
  isBadWeather: boolean;
}

async function getAmapWeather(city: string, apiKey: string): Promise<WeatherResult | null> {
  try {
    const geoData = (await amapGet("/v3/geocode/geo", {
      address: city,
      key: apiKey,
      output: "json",
    })) as {
      status: string;
      geocodes?: Array<{ adcode: string }>;
    };
    const adcode = geoData.geocodes?.[0]?.adcode;
    if (!adcode) {
      return null;
    }

    const data = (await amapGet("/v3/weather/weatherInfo", {
      city: adcode,
      key: apiKey,
      extensions: "base",
      output: "json",
    })) as {
      status: string;
      lives?: Array<{
        weather: string;
        temperature: string;
        winddirection: string;
        windpower: string;
      }>;
    };
    if (data.status !== "1" || !data.lives?.length) {
      return null;
    }
    const w = data.lives[0];
    if (!w) {
      return null;
    }

    const rainyKeywords = ["雨", "雷", "阵雨", "暴雨", "中雨", "小雨", "大雨"];
    const badKeywords = ["暴雨", "大暴雨", "雪", "暴雪", "冰雹", "雷暴", "台风", "沙尘暴"];

    return {
      weather: w.weather,
      temperature: `${w.temperature}°C`,
      wind: `${w.winddirection}风${w.windpower}级`,
      isRainy: rainyKeywords.some((k) => w.weather.includes(k)),
      isBadWeather: badKeywords.some((k) => w.weather.includes(k)),
    };
  } catch {
    return null;
  }
}

// ─── 内部辅助函数：停车难度评估 ──────────────────────────────────────────────

interface ParkingAssessment {
  parkingCount: number;
  difficulty: "easy" | "medium" | "hard";
  estimatedCostPerHour: number;
  parkingNames: string[];
}

async function assessParking(
  lng: string,
  lat: string,
  poiType: string,
  apiKey: string,
): Promise<ParkingAssessment> {
  let parkingCount = 0;
  const parkingNames: string[] = [];
  try {
    const data = (await amapGet("/v3/place/around", {
      location: `${lng},${lat}`,
      keywords: "停车场",
      radius: "500",
      key: apiKey,
      output: "json",
      offset: "10",
      sortrule: "0",
    })) as { status: string; pois?: Array<{ name: string }> };
    if (data.status === "1" && data.pois) {
      parkingCount = data.pois.length;
      for (const p of data.pois.slice(0, 3)) {
        parkingNames.push(p.name);
      }
    }
  } catch {
    /* 不阻塞 */
  }

  const isHardArea =
    /商场|购物|银泰|万达|商圈|医院|医学|附属|儿[保童]|人民医院|中心医院|火车站|高铁站|机场/.test(
      poiType,
    );
  let difficulty: "easy" | "medium" | "hard" = "easy";
  let estimatedCostPerHour = 5;

  if (isHardArea) {
    difficulty = parkingCount <= 2 ? "hard" : "medium";
    estimatedCostPerHour = /商场|购物|银泰|万达|商圈/.test(poiType) ? 20 : 12;
  } else if (parkingCount <= 1) {
    difficulty = "medium";
    estimatedCostPerHour = 8;
  }

  return { parkingCount, difficulty, estimatedCostPerHour, parkingNames };
}

// ─── 内部辅助函数：智能打分 ──────────────────────────────────────────────────

interface ModeScore {
  mode: string;
  label: string;
  score: number;
  duration_minutes: number;
  cost_yuan: number;
  details: string;
  available: boolean;
}

function scoreModes(opts: {
  driving: { duration_minutes: number; taxi_cost: number; traffic_level: string } | null;
  transit: TransitResult | null;
  walking: WalkingResult | null;
  parking: ParkingAssessment;
  weather: WeatherResult | null;
  distanceMeters: number;
}): ModeScore[] {
  const { driving, transit, walking, parking, weather, distanceMeters } = opts;
  const modes: ModeScore[] = [];

  const allDurations: number[] = [];
  const allCosts: number[] = [];
  if (driving) {
    allDurations.push(driving.duration_minutes);
    allCosts.push(driving.taxi_cost);
  }
  if (transit) {
    allDurations.push(transit.duration_minutes);
    allCosts.push(transit.cost_yuan);
  }
  if (walking && walking.duration_minutes <= 60) {
    allDurations.push(walking.duration_minutes);
    allCosts.push(0);
  }

  const maxDur = Math.max(...allDurations, 1);
  const maxCost = Math.max(...allCosts, 1);

  const isRainy = weather?.isRainy ?? false;
  const isBad = weather?.isBadWeather ?? false;

  // ── 打车方案 ──
  if (driving) {
    const timeScore = (1 - driving.duration_minutes / maxDur) * 100;
    const costScore = (1 - driving.taxi_cost / maxCost) * 100;
    const parkingScore = 100;
    const weatherScore = isRainy ? 100 : isBad ? 100 : 60;
    const comfortScore = 90;
    const total =
      timeScore * 0.3 +
      costScore * 0.25 +
      parkingScore * 0.2 +
      weatherScore * 0.15 +
      comfortScore * 0.1;
    modes.push({
      mode: "taxi",
      label: "🚕 打车",
      score: Math.round(total),
      duration_minutes: driving.duration_minutes,
      cost_yuan: driving.taxi_cost,
      details: `预计${driving.duration_minutes}分钟，约¥${driving.taxi_cost}`,
      available: true,
    });
  }

  // ── 自驾方案 ──
  if (driving) {
    const timeScore = (1 - driving.duration_minutes / maxDur) * 100;
    const parkingHours = 2;
    const driveCost = Math.round(
      driving.taxi_cost * 0.35 + parking.estimatedCostPerHour * parkingHours,
    );
    const costScore = (1 - driveCost / maxCost) * 100;
    const parkingScoreMap = { easy: 90, medium: 50, hard: 15 };
    const parkingScore = parkingScoreMap[parking.difficulty];
    const trafficPenalty =
      driving.traffic_level === "严重拥堵" ? -20 : driving.traffic_level === "拥堵" ? -10 : 0;
    const weatherScore = isBad ? 40 : 70;
    const comfortScore = 80;
    const total = Math.max(
      0,
      timeScore * 0.3 +
        costScore * 0.25 +
        parkingScore * 0.2 +
        weatherScore * 0.15 +
        comfortScore * 0.1 +
        trafficPenalty,
    );
    const parkingNote =
      parking.difficulty === "hard"
        ? "⚠️停车困难"
        : parking.difficulty === "medium"
          ? "停车一般"
          : "停车方便";
    modes.push({
      mode: "drive",
      label: "🚗 自驾",
      score: Math.round(total),
      duration_minutes: driving.duration_minutes,
      cost_yuan: driveCost,
      details: `预计${driving.duration_minutes}分钟，油费+停车≈¥${driveCost}（${parkingNote}，附近${parking.parkingCount}个停车场）`,
      available: true,
    });
  }

  // ── 公交地铁方案 ──
  if (transit) {
    const timeScore = (1 - transit.duration_minutes / maxDur) * 100;
    const costScore = (1 - transit.cost_yuan / maxCost) * 100;
    const parkingScore = 100;
    const weatherScore = isRainy ? 50 : isBad ? 30 : 70;
    let comfortScore = 80;
    if (transit.transfers >= 2) {
      comfortScore -= 20;
    }
    if (transit.walking_distance_meters > 1000) {
      comfortScore -= 15;
    }
    if (transit.nightflag) {
      comfortScore -= 10;
    }
    const total =
      timeScore * 0.3 +
      costScore * 0.25 +
      parkingScore * 0.2 +
      weatherScore * 0.15 +
      Math.max(0, comfortScore) * 0.1;
    const transferNote = transit.transfers === 0 ? "直达" : `换乘${transit.transfers}次`;
    modes.push({
      mode: "transit",
      label: "🚇 公交/地铁",
      score: Math.round(total),
      duration_minutes: transit.duration_minutes,
      cost_yuan: transit.cost_yuan,
      details: `预计${transit.duration_minutes}分钟，¥${transit.cost_yuan}，${transferNote}，步行${fmtDistance(transit.walking_distance_meters)}`,
      available: true,
    });
  }

  // ── 步行方案（仅3公里内） ──
  if (walking && distanceMeters <= 3000) {
    const timeScore = (1 - walking.duration_minutes / maxDur) * 100;
    const costScore = 100;
    const parkingScore = 100;
    const weatherScore = isBad ? 0 : isRainy ? 15 : 90;
    let comfortScore = distanceMeters <= 1000 ? 85 : distanceMeters <= 2000 ? 60 : 35;
    if (Number(weather?.temperature?.replace("°C", "") ?? 25) > 35) {
      comfortScore -= 20;
    }
    const total =
      timeScore * 0.3 +
      costScore * 0.25 +
      parkingScore * 0.2 +
      weatherScore * 0.15 +
      Math.max(0, comfortScore) * 0.1;
    modes.push({
      mode: "walk",
      label: "🚶 步行",
      score: Math.round(total),
      duration_minutes: walking.duration_minutes,
      cost_yuan: 0,
      details: `预计${walking.duration_minutes}分钟，${fmtDistance(walking.distance_meters)}，免费`,
      available: distanceMeters <= 3000,
    });
  }

  modes.sort((a, b) => b.score - a.score);
  return modes;
}

// ─── Tool 4: smart_trip — 智能出行决策 ────────────────────────────────────────

const SmartTripSchema = Type.Object({
  origin: Type.String({ description: "出发地，如 '翡翠城东门'、'我家'" }),
  destination: Type.String({ description: "目的地，如 '西湖银泰'、'省儿保'" }),
  city: Type.Optional(Type.String({ description: "城市名，如 '杭州'，帮助解析地址" })),
  arrival_time: Type.Optional(
    Type.String({
      description:
        "期望到达时间，如 '下午3点'、'明天上午9点半'。传入后系统会结合各方案时长自动计算建议出发时间。",
    }),
  ),
});

export function createSmartTripTool(): AnyAgentTool {
  return {
    name: "smart_trip",
    label: "Smart Trip Advisor",
    description: `智能出行决策工具——当用户提到"去某地"、"怎么去"、"出行"、"路线"等出行意图时，优先调用此工具。
该工具会自动：
1. 并行查询驾车、公交地铁、步行等全部出行方案
2. 查询目的地周边停车场数量和停车难度
3. 查询实时天气
4. 综合打分（耗时30%+费用25%+停车难度20%+天气15%+舒适度10%）
5. 给出最优推荐 + 替代方案 + 理由

【系统强制输出格式】收到此工具返回后，你必须严格按照以下5个区块输出，不得简化：

🧠 **智能推荐**
写推荐的出行方式（加粗），以及推荐理由（2-3条，来自 recommendation.reasons）

🚌/🚗/🚇 **推荐方案详情**
详细描述推荐方案：耗时、费用、换乘/路线、步行距离等具体信息（来自 recommendation.details 和 transit/walking 数据）

📊 **全方案对比**
列出所有方案（打车/自驾/公交地铁/步行），每个写清楚：耗时、费用、评分、适合什么情况
格式：1. 🚕 打车（评分XX分）：XXX  2. 🚗 自驾（评分XX分）：XXX  以此类推

🌤️ **天气提示**
写当前天气状况和对出行的影响（来自 weather 字段）

⏰ **出发建议**
结合推荐方案的耗时，给出建议出发时间和注意事项（如有 suggested_departure_time 字段则必须使用）

==== 以上5个区块缺一不可 ====

另外：如果最优方案是"驾车"或"打车"，完成以上文字输出后还需依次调用 maps_route + maps_navigation_image 生成导航地图（地图放在文字之后）。`,
    parameters: SmartTripSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("smart_trip: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key（AMAP_API_KEY）" });
      }

      const params = args as Record<string, unknown>;
      const originAddr = readStringParam(params, "origin", { required: true });
      const destAddr = readStringParam(params, "destination", { required: true });
      const city = typeof params.city === "string" ? params.city : "杭州";
      const arrivalTimeStr =
        typeof params.arrival_time === "string" ? params.arrival_time : undefined;
      const arrivalTs = arrivalTimeStr ? parseDepartureTime(arrivalTimeStr) : null;

      // 1. 解析起终点坐标
      const [originGeo, destGeo] = await Promise.all([
        geocode(originAddr, apiKey, city),
        geocode(destAddr, apiKey, city),
      ]);

      if (!originGeo) {
        return jsonResult({ error: `无法解析出发地"${originAddr}"，请提供更详细的地址` });
      }
      if (!destGeo) {
        return jsonResult({ error: `无法解析目的地"${destAddr}"，请提供更详细的地址` });
      }

      // 2. 并行查询所有数据
      type StepItem = {
        road: string;
        instruction: string;
        tmcs?: Array<{ distance: string; status: string }>;
      };
      const [driveData, transitData, walkData, weatherData, parkingData] = await Promise.all([
        (async () => {
          try {
            const driveParams: Record<string, string> = {
              origin: `${originGeo.lng},${originGeo.lat}`,
              destination: `${destGeo.lng},${destGeo.lat}`,
              key: apiKey,
              extensions: "all",
              strategy: "0",
              output: "json",
            };
            if (arrivalTs) {
              driveParams.departure_time = String(arrivalTs);
            }
            const data = (await amapGet("/v3/direction/driving", driveParams)) as {
              status: string;
              route?: {
                taxi_cost: string;
                paths: Array<{ distance: string; duration: string; steps: StepItem[] }>;
              };
            };
            if (data.status !== "1" || !data.route?.paths?.[0]) {
              return null;
            }
            const p = data.route.paths[0];
            const allTmcs = p.steps.flatMap((s) => s.tmcs ?? []);
            const traffic = aggregateTraffic(allTmcs);
            return {
              duration_minutes: Math.ceil(Number(p.duration) / 60),
              distance_meters: Number(p.distance),
              taxi_cost: Number(data.route.taxi_cost) || 0,
              traffic_level: traffic.level,
              traffic_tip: traffic.tip,
            };
          } catch {
            return null;
          }
        })(),
        transitRoute(originGeo.lng, originGeo.lat, destGeo.lng, destGeo.lat, city, apiKey),
        walkingRoute(originGeo.lng, originGeo.lat, destGeo.lng, destGeo.lat, apiKey),
        getAmapWeather(city, apiKey),
        assessParking(destGeo.lng, destGeo.lat, `${destAddr}${destGeo.formatted}`, apiKey),
      ]);

      // 3. 智能打分
      const drivingDistance = driveData?.distance_meters ?? 0;
      const modes = scoreModes({
        driving: driveData
          ? {
              duration_minutes: driveData.duration_minutes,
              taxi_cost: driveData.taxi_cost,
              traffic_level: driveData.traffic_level,
            }
          : null,
        transit: transitData,
        walking: walkData,
        parking: parkingData,
        weather: weatherData,
        distanceMeters: drivingDistance,
      });

      // 4. 生成推荐理由
      const best = modes[0];
      const reasons: string[] = [];
      if (best) {
        if (best.mode === "taxi") {
          if (parkingData.difficulty === "hard") {
            reasons.push("目的地停车困难");
          }
          if (parkingData.estimatedCostPerHour >= 15) {
            reasons.push(`停车费较贵（约¥${parkingData.estimatedCostPerHour}/小时）`);
          }
          if (weatherData?.isRainy) {
            reasons.push(`当前天气${weatherData.weather}，不宜步行`);
          }
          if (driveData && driveData.traffic_level !== "畅通") {
            reasons.push(`路况${driveData.traffic_level}`);
          }
        } else if (best.mode === "transit") {
          if (transitData && transitData.cost_yuan < (driveData?.taxi_cost ?? 999)) {
            reasons.push("费用最低");
          }
          if (transitData && transitData.transfers <= 1) {
            reasons.push("换乘方便");
          }
          if (parkingData.difficulty !== "easy") {
            reasons.push("目的地不太好停车");
          }
        } else if (best.mode === "drive") {
          if (parkingData.difficulty === "easy") {
            reasons.push("目的地停车方便");
          }
          if (driveData && driveData.traffic_level === "畅通") {
            reasons.push("路况畅通");
          }
        } else if (best.mode === "walk") {
          if (walkData && walkData.distance_meters <= 1500) {
            reasons.push("距离很近");
          }
          if (!weatherData?.isRainy) {
            reasons.push("天气适合步行");
          }
        }
      }

      // 5. 计算建议出发时间
      let suggestedDeparture: string | undefined;
      if (arrivalTs && best) {
        const bufferMin = best.mode === "drive" ? 20 : best.mode === "transit" ? 10 : 5;
        const totalMin = best.duration_minutes + bufferMin;
        const departTs = arrivalTs - totalMin * 60;
        const d = new Date(departTs * 1000);
        suggestedDeparture = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      }

      return jsonResult({
        origin: originGeo.formatted,
        destination: destGeo.formatted,
        weather: weatherData
          ? {
              condition: weatherData.weather,
              temperature: weatherData.temperature,
              wind: weatherData.wind,
              is_rainy: weatherData.isRainy,
            }
          : null,
        parking_assessment: {
          nearby_count: parkingData.parkingCount,
          difficulty:
            parkingData.difficulty === "hard"
              ? "困难"
              : parkingData.difficulty === "medium"
                ? "一般"
                : "轻松",
          estimated_cost_per_hour: `¥${parkingData.estimatedCostPerHour}`,
          parking_names: parkingData.parkingNames,
        },
        recommendation: best
          ? {
              mode: best.label,
              score: best.score,
              duration: `${best.duration_minutes}分钟`,
              cost: `¥${best.cost_yuan}`,
              reasons,
              details: best.details,
            }
          : null,
        all_modes: modes.map((m) => ({
          mode: m.label,
          score: m.score,
          duration: `${m.duration_minutes}分钟`,
          cost: `¥${m.cost_yuan}`,
          details: m.details,
        })),
        ...(suggestedDeparture ? { suggested_departure_time: suggestedDeparture } : {}),
        ...(arrivalTimeStr ? { target_arrival_time: arrivalTimeStr } : {}),
        traffic_status: driveData?.traffic_level ?? "未知",
        traffic_tip: driveData?.traffic_tip ?? "",
        _SYSTEM_NEXT_REQUIRED_ACTION:
          best?.mode === "taxi" || best?.mode === "drive"
            ? `⚡ 推荐方案是驾车/打车。你现在必须依次执行：① 调用 maps_route 工具（origin="${originAddr}", destination="${destAddr}", city="${city}"）；② maps_route 返回后立即调用 maps_navigation_image 工具生成地图。这两步都是强制要求，缺一不可。先看完数据再输出文字。`
            : `✅ 推荐方案是${best?.label ?? "步行或公交"}，无需导航地图。请直接用大白话向用户说明推荐理由和各方案对比。`,
      });
    },
  };
}
