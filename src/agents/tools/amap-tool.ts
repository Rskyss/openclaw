import { Type } from "@sinclair/typebox";
import { logWarn } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readStringArrayParam } from "./common.js";

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
    description: `使用高德地图规划驾车路线，获取预估耗时、主要道路和路况等。
通常在 smart_trip 分析后、用户需要驾车详情时调用。也可在用户明确要求驾车路线时直接调用。

获取路线后，紧接着调用 maps_navigation_image 生成导航地图。
回复时使用返回的真实数据（起终点、距离、耗时、路况、主要道路），不要编造。
严禁在回复中暴露英文字段名或 key=value 格式，必须用自然中文表达。`,
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
  walking_origin_lng: Type.Optional(
    Type.String({ description: "步行路线起点经度（用于在地图上叠加绿色步行路线）" }),
  ),
  walking_origin_lat: Type.Optional(Type.String({ description: "步行路线起点纬度" })),
  walking_dest_lng: Type.Optional(Type.String({ description: "步行路线终点经度" })),
  walking_dest_lat: Type.Optional(Type.String({ description: "步行路线终点纬度" })),
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

      const originGeo = await geocode(origin, apiKey, city);
      if (!originGeo) {
        return jsonResult({ error: `无法解析出发地"${origin}"的坐标` });
      }
      const destGeo = await geocode(destination, apiKey, city);
      if (!destGeo) {
        return jsonResult({ error: `无法解析目的地"${destination}"的坐标` });
      }

      const wOLng =
        typeof params.walking_origin_lng === "string" ? params.walking_origin_lng : undefined;
      const wOLat =
        typeof params.walking_origin_lat === "string" ? params.walking_origin_lat : undefined;
      const wDLng =
        typeof params.walking_dest_lng === "string" ? params.walking_dest_lng : undefined;
      const wDLat =
        typeof params.walking_dest_lat === "string" ? params.walking_dest_lat : undefined;
      const walkingLeg =
        wOLng && wOLat && wDLng && wDLat
          ? { originLng: wOLng, originLat: wOLat, destLng: wDLng, destLat: wDLat }
          : undefined;

      const mapResult = await generateNavMap(originGeo, destGeo, apiKey, walkingLeg);
      if (!mapResult) {
        return jsonResult({ error: "地图图片生成失败" });
      }

      return jsonResult({
        _SYSTEM_IMAGE_INSTRUCTION: `✅ 导航地图已生成（已缩小为缩略图）。请你先写完所有的出行方案分析文字，然后在回复的【最后一行】放上地图：\n![导航路线图](/media?file=${mapResult.image_path})\n\n注意：地图必须放在全部文字之后，不要放在开头。不要使用 MEDIA 标签，不要使用 HTML 标签。`,
        ...mapResult,
      });
    },
  };
}

// ─── 内部辅助函数：生成导航地图 ────────────────────────────────────────────────

interface NavMapResult {
  image_path: string;
  parking_info: string;
  parking_names: string[];
  map_description: string;
}

async function generateNavMap(
  originGeo: { lng: string; lat: string },
  destGeo: { lng: string; lat: string },
  apiKey: string,
  walkingLeg?: { originLng: string; originLat: string; destLng: string; destLat: string },
): Promise<NavMapResult | null> {
  try {
    type StepItem = { polyline: string };

    // 获取驾车路线 polyline（蓝色）
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
        routePolyline = driveData.route.paths[0].steps
          .map((s) => s.polyline)
          .filter(Boolean)
          .join(";");
      }
    } catch {
      // 路线获取失败不阻塞
    }

    // 获取步行路线 polyline（绿色），仅在 walkingLeg 传入时请求
    let walkingPolyline = "";
    if (walkingLeg) {
      try {
        const walkData = (await amapGet("/v3/direction/walking", {
          origin: `${walkingLeg.originLng},${walkingLeg.originLat}`,
          destination: `${walkingLeg.destLng},${walkingLeg.destLat}`,
          key: apiKey,
          output: "json",
        })) as {
          status: string;
          route?: { paths?: Array<{ steps: StepItem[] }> };
        };
        if (walkData.status === "1" && walkData.route?.paths?.[0]) {
          walkingPolyline = walkData.route.paths[0].steps
            .map((s) => s.polyline)
            .filter(Boolean)
            .join(";");
        }
      } catch {
        // 步行路线获取失败不阻塞
      }
    }

    // 搜索目的地附近停车场
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
        sortrule: "0",
      })) as { status: string; pois?: PoiItem[] };
      if (searchData.status === "1" && searchData.pois?.length) {
        parkingSpots = searchData.pois.slice(0, 3);
      }
    } catch {
      // 停车场搜索失败不阻塞
    }

    // 拼接高德静态地图 URL
    const markers: string[] = [];
    markers.push(`large,0x00CC00,起:${originGeo.lng},${originGeo.lat}`);
    markers.push(`large,0xFF0000,终:${destGeo.lng},${destGeo.lat}`);
    for (const p of parkingSpots) {
      markers.push(`mid,0x0000FF,P:${p.location}`);
    }

    const staticUrl = new URL(`${AMAP_BASE}/v3/staticmap`);
    staticUrl.searchParams.set("key", apiKey);
    staticUrl.searchParams.set("size", "800*600");
    staticUrl.searchParams.set("scale", "2");
    staticUrl.searchParams.set("markers", markers.join("|"));

    if (routePolyline) {
      let points = routePolyline.split(";");
      if (points.length > 200) {
        const step = Math.ceil(points.length / 200);
        const sampled: string[] = [];
        for (let i = 0; i < points.length; i += step) {
          const pt = points[i];
          if (pt) {
            sampled.push(pt);
          }
        }
        const lastPt = points[points.length - 1];
        if (lastPt && sampled[sampled.length - 1] !== lastPt) {
          sampled.push(lastPt);
        }
        points = sampled;
      }
      staticUrl.searchParams.set("paths", `6,0x0088FF,1,,:${points.join(";")}`);
    }

    // 步行路线叠加（绿色线）
    if (walkingPolyline) {
      let wPoints = walkingPolyline.split(";");
      if (wPoints.length > 200) {
        const step = Math.ceil(wPoints.length / 200);
        const sampled: string[] = [];
        for (let i = 0; i < wPoints.length; i += step) {
          const pt = wPoints[i];
          if (pt) {
            sampled.push(pt);
          }
        }
        const lastPt = wPoints[wPoints.length - 1];
        if (lastPt && sampled[sampled.length - 1] !== lastPt) {
          sampled.push(lastPt);
        }
        wPoints = sampled;
      }
      staticUrl.searchParams.append("paths", `5,0x00BB44,1,,:${wPoints.join(";")}`);
    }

    // 下载图片
    const imgRes = await fetch(staticUrl.toString());
    if (!imgRes.ok) {
      return null;
    }
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());

    const fs = await import("node:fs/promises");
    const tmpDir = "/tmp/openclaw";
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpPath = `${tmpDir}/nav-map-${Date.now()}.png`;
    // 使用 sharp 缩小为 500px 宽的缩略图
    try {
      const sharp = (await import("sharp")).default;
      const resized = await sharp(imgBuf).resize({ width: 350 }).png({ quality: 80 }).toBuffer();
      await fs.writeFile(tmpPath, resized);
    } catch {
      // sharp 失败时保留原图
      await fs.writeFile(tmpPath, imgBuf);
    }

    const parkingDesc = parkingSpots.length
      ? parkingSpots
          .map((p, i) => `${i + 1}. ${p.name}（${p.address || "详见地图蓝色P标注"}）`)
          .join("\n")
      : "未找到附近停车场";

    const mapDesc = [
      "图中绿色标注为出发地，红色标注为目的地，蓝色P标注为附近停车场",
      routePolyline ? "，蓝色线为推荐驾车路线" : "",
      walkingPolyline ? "，绿色线为步行路线" : "",
      "。",
    ].join("");

    return {
      image_path: tmpPath,
      parking_info: parkingDesc,
      parking_names: parkingSpots.map((p) => p.name),
      map_description: mapDesc,
    };
  } catch {
    return null;
  }
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
          const from = line.departure_stop?.name ?? "";
          const to = line.arrival_stop?.name ?? "";
          const stops = line.via_num || "?";
          const stationInfo =
            from && to ? `（${from}上车 → ${to}下车，${stops}站）` : `（${stops}站）`;
          segments.push(`${line.name}${stationInfo}`);
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

// ─── 内部辅助函数：小红书实时情报搜索 ──────────────────────────────────────────

interface XhsSearchResult {
  title: string;
  likes: string;
  comments: string;
  cover_url: string;
}

const XHS_MCP_URL = "http://127.0.0.1:18060/mcp";
const XHS_TIMEOUT_MS = 15000;

async function searchXiaohongshu(
  destination: string,
  rawKeyword?: string,
): Promise<XhsSearchResult[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), XHS_TIMEOUT_MS);

    try {
      // 1. 初始化 MCP 会话
      const initRes = await fetch(XHS_MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smart-trip", version: "1.0" },
          },
          id: 1,
        }),
        signal: controller.signal,
      });

      if (!initRes.ok) {
        return null;
      }
      const sessionId = initRes.headers.get("mcp-session-id");
      if (!sessionId) {
        return null;
      }

      // 2. 搜索小红书（rawKeyword 为直接搜索，否则拼接出行相关关键词）
      const keyword = rawKeyword || `${destination} 攻略 停车`;
      const searchRes = await fetch(XHS_MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "search_feeds",
            arguments: { keyword },
          },
          id: 2,
        }),
        signal: controller.signal,
      });

      if (!searchRes.ok) {
        return null;
      }
      const data = (await searchRes.json()) as {
        result?: { content?: Array<{ text?: string }> };
        error?: { message: string };
      };

      if (data.error || !data.result?.content?.[0]?.text) {
        return null;
      }

      // 3. 解析搜索结果
      const feedsText = data.result.content[0].text;
      const feedsData = JSON.parse(feedsText) as {
        feeds?: Array<{
          noteCard?: {
            displayTitle?: string;
            interactInfo?: {
              likedCount?: string;
              commentCount?: string;
            };
            cover?: {
              urlDefault?: string;
            };
          };
        }>;
      };

      if (!feedsData.feeds?.length) {
        return null;
      }

      return feedsData.feeds.slice(0, 5).map((f) => ({
        title: f.noteCard?.displayTitle || "",
        likes: f.noteCard?.interactInfo?.likedCount || "0",
        comments: f.noteCard?.interactInfo?.commentCount || "0",
        cover_url: f.noteCard?.cover?.urlDefault || "",
      }));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 小红书MCP未启动/超时/出错，静默降级
    return null;
  }
}

// ─── Tool 4: smart_trip — 多模式出行数据工具 ───────────────────────────────────

const SmartTripSchema = Type.Object({
  origin: Type.String({ description: "出发地，如 '翡翠城东门'" }),
  destination: Type.String({ description: "目的地，如 '西湖银泰'" }),
  city: Type.Optional(Type.String({ description: "城市名，如 '杭州'" })),
  arrival_time: Type.Optional(Type.String({ description: "期望到达时间，如 '下午3点'、'16:00'" })),
});

export function createSmartTripTool(): AnyAgentTool {
  return {
    name: "smart_trip",
    label: "Smart Trip Advisor",
    description: `多模式出行数据工具 — 当用户询问出行相关问题时调用。
并行获取驾车、公交/地铁、步行的路线数据 + 实时天气 + 目的地附近停车场信息 + 小红书网友实时情报。
返回原始数据，由 AI 综合判断推荐最适合的出行方式。

注意事项：
- 此工具只提供数据，不做推荐判断。请你根据数据智能分析最优方案。
- 如果目的地涉及活动（灯会/演唱会/展览等），请同时调用 event_search 工具获取实时活动信息。
- 如果需要驾车详情，再调用 maps_route；如需地图，maps_navigation_image 已内置生成。

三层决策框架（分析时请参考）：
第1层-安全性检查：有无交通管制/封路/恶劣天气等安全风险
第2层-可行性判断：各出行方式是否可行、停车有无大问题、时间是否来得及
第3层-体验优化：哪个路线体验更好、有没有省钱省时技巧、有没有值得顺路的推荐

小红书情报处理：
- 如果返回了 xiaohongshu_tips，请提炼与出行相关的有用信息（停车/路况/避坑/周边推荐）
- 融入出行建议中，用自然语言标注来源如"近期有网友提到"
- 信息冲突时优先级：安全信息 > 官方数据 > 网友经验
- 不要原样列出帖子标题，提炼有价值信息即可`,
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
        return jsonResult({ error: `无法解析出发地"${originAddr}"` });
      }
      if (!destGeo) {
        return jsonResult({ error: `无法解析目的地"${destAddr}"` });
      }

      // 2. 并行获取所有路线数据 + 天气 + 停车
      type StepItem = {
        road: string;
        instruction: string;
        tmcs?: Array<{ distance: string; status: string }>;
      };
      const [driveData, transitData, walkData, weatherData, parkingData, xhsData] =
        await Promise.all([
          // 驾车
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
              const roads = [
                ...new Set(
                  p.steps.map((s) => s.road?.trim()).filter((r): r is string => Boolean(r)),
                ),
              ].slice(0, 6);
              return {
                duration_min: Math.ceil(Number(p.duration) / 60),
                distance_m: Number(p.distance),
                taxi_cost: Number(data.route.taxi_cost) || 0,
                traffic_level: traffic.level,
                traffic_tip: traffic.tip,
                main_roads: roads,
              };
            } catch {
              return null;
            }
          })(),
          transitRoute(originGeo.lng, originGeo.lat, destGeo.lng, destGeo.lat, city, apiKey),
          walkingRoute(originGeo.lng, originGeo.lat, destGeo.lng, destGeo.lat, apiKey),
          getAmapWeather(city, apiKey),
          // 停车场数量
          (async () => {
            try {
              const data = (await amapGet("/v3/place/around", {
                location: `${destGeo.lng},${destGeo.lat}`,
                keywords: "停车场",
                radius: "500",
                key: apiKey,
                output: "json",
                offset: "10",
              })) as { status: string; pois?: Array<{ name: string }> };
              if (data.status === "1" && data.pois) {
                return {
                  nearby_count: data.pois.length,
                  names: data.pois.slice(0, 3).map((p) => p.name),
                };
              }
              return { nearby_count: 0, names: [] };
            } catch {
              return { nearby_count: 0, names: [] };
            }
          })(),
          // 小红书网友实时情报（并行查询，不阻塞主流程）
          searchXiaohongshu(destAddr),
        ]);

      // 3. 计算建议出发时间（仅在有到达时间时）
      const suggestedDepartures: Record<string, string> = {};
      if (arrivalTs) {
        const modes = [
          { key: "driving", min: driveData?.duration_min, buffer: 20 },
          { key: "transit", min: transitData?.duration_minutes, buffer: 10 },
          { key: "walking", min: walkData?.duration_minutes, buffer: 5 },
        ];
        for (const m of modes) {
          if (m.min) {
            const ts = arrivalTs - (m.min + m.buffer) * 60;
            const d = new Date(ts * 1000);
            suggestedDepartures[m.key] =
              `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
          }
        }
      }

      // 4. 生成导航地图
      const mapResult = await generateNavMap(originGeo, destGeo, apiKey);

      return jsonResult({
        current_time: new Date().toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        }),
        origin: originGeo.formatted,
        destination: destGeo.formatted,
        driving: driveData ?? null,
        transit: transitData
          ? {
              duration_min: transitData.duration_minutes,
              walking_m: transitData.walking_distance_meters,
              cost: transitData.cost_yuan,
              transfers: transitData.transfers,
              segments_desc: transitData.segments_desc,
              nightflag: transitData.nightflag,
            }
          : null,
        walking: walkData
          ? { duration_min: walkData.duration_minutes, distance_m: walkData.distance_meters }
          : null,
        weather: weatherData
          ? {
              condition: weatherData.weather,
              temperature: weatherData.temperature,
              wind: weatherData.wind,
              is_rainy: weatherData.isRainy,
            }
          : null,
        parking: parkingData,
        ...(xhsData
          ? {
              xiaohongshu_tips: xhsData,
              _xhs_note:
                "以上是小红书近期热帖摘要，请提炼与出行相关的有用信息（停车/路况/避坑/推荐），融入出行建议中。",
            }
          : {}),
        ...(arrivalTimeStr ? { target_arrival_time: arrivalTimeStr } : {}),
        ...(Object.keys(suggestedDepartures).length > 0
          ? { suggested_departure_by_mode: suggestedDepartures }
          : {}),
        ...(mapResult
          ? { image_path: mapResult.image_path, map_description: mapResult.map_description }
          : {}),
        _note: mapResult
          ? `✅ 导航地图已生成（已缩小为缩略图）。请先写完所有出行方案文字，然后在回复的【最后一行】放上地图：\n![导航路线图](/media?file=${mapResult.image_path})\n\n注意：地图必须放在全部文字之后，不要放在开头。不要使用 MEDIA 标签或 HTML 标签。`
          : "",
      });
    },
  };
}

// ─── Tool 5.5: xhs_image_search — 小红书图片搜索 ──────────────────────────────

const XhsImageSearchSchema = Type.Object({
  keyword: Type.String({ description: "搜索关键词，如 '西溪湿地灯会 实拍'" }),
  count: Type.Optional(
    Type.Number({ description: "下载图片数量（默认3，最多5）", minimum: 1, maximum: 5 }),
  ),
});

async function downloadXhsImage(url: string, index: number): Promise<string | null> {
  if (!url) {
    return null;
  }
  try {
    const res = await fetch(url, {
      headers: {
        Referer: "https://www.xiaohongshu.com",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      return null;
    } // 太小的图片可能是错误页面
    const fs = await import("node:fs/promises");
    const tmpDir = "/tmp/openclaw";
    await fs.mkdir(tmpDir, { recursive: true });
    const outPath = `${tmpDir}/xhs-${Date.now()}-${index}.webp`;
    // 使用 sharp 缩小为 300px 宽的缩略图
    try {
      const sharp = (await import("sharp")).default;
      const resized = await sharp(buf).resize({ width: 180 }).webp({ quality: 75 }).toBuffer();
      await fs.writeFile(outPath, resized);
    } catch {
      // sharp 失败时保留原图
      await fs.writeFile(outPath, buf);
    }
    return outPath;
  } catch {
    return null;
  }
}

export function createXhsImageSearchTool(): AnyAgentTool {
  return {
    name: "xhs_image_search",
    label: "Xiaohongshu Image Search",
    description: `小红书图片搜索工具 — 当用户想看某个地方或活动的实拍照片时调用。
搜索小红书热门帖子并下载封面图到本地，返回本地图片路径。

使用场景：用户说"有没有XX的照片/实拍/图片"、"给我看看XX长什么样"等。
返回结果包含多张图片路径，你必须用 MEDIA:<路径> 的格式展示每张图片（每张图独占一行）。
展示图片时请附上简短的图片说明（来源帖子标题），让用户知道图片内容。`,
    parameters: XhsImageSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const keyword = readStringParam(params, "keyword", { required: true });
      const count = Math.min(typeof params.count === "number" ? params.count : 3, 5);

      // 搜索小红书
      const results = await searchXiaohongshu(keyword, keyword);
      if (!results || results.length === 0) {
        return jsonResult({
          error: "未搜索到相关小红书内容，小红书 MCP 服务可能未启动",
          suggestion: "请确认小红书 MCP 服务已启动（端口 18060）",
        });
      }

      // 筛选有封面图的帖子
      const withCover = results.filter((r) => r.cover_url);
      if (withCover.length === 0) {
        return jsonResult({
          error: "搜索到帖子但未找到可用图片",
          posts: results.map((r) => r.title),
        });
      }

      // 并行下载图片
      const toDownload = withCover.slice(0, count);
      const downloadResults = await Promise.all(
        toDownload.map((r, i) => downloadXhsImage(r.cover_url, i)),
      );

      const images: Array<{ image_path: string; caption: string; likes: string }> = [];
      for (let i = 0; i < toDownload.length; i++) {
        const path = downloadResults[i];
        const post = toDownload[i];
        if (path && post) {
          images.push({
            image_path: path,
            caption: post.title,
            likes: post.likes,
          });
        }
      }

      if (images.length === 0) {
        return jsonResult({
          error: "图片下载失败（可能是小红书防盗链限制）",
          posts: results.map((r) => r.title),
        });
      }

      const { sanitizeToolResultImages } = await import("../../agents/tool-images.js");
      const content: Array<{ type: string; text: string }> = [];

      content.push({
        type: "text",
        text:
          `✅ 成功为您找到 ${images.length} 张现场照片（已缩为缩略图）。\n` +
          `【排版指令】请你在适当位置展示图片。图片已经被缩小为缩略图，请把下面这一行 Markdown 代码原样粘贴到你的回复中（所有图片必须放在同一行，中间用空格隔开，这样它们会横排显示）：\n\n` +
          images.map((img) => `![${img.caption}](/media?file=${img.image_path})`).join(" ") +
          `\n\n不要使用 MEDIA: 标签，不要使用 HTML 标签。上面的 Markdown 图片代码必须完全放在同一行。\n\n` +
          `图片信息：\n` +
          images.map((img, i) => `照片${i + 1}：${img.caption}（${img.likes}赞）`).join("\n"),
      });

      const result = {
        content,
        details: {
          source: "小红书网友实拍",
          images: images.map((img) => ({ caption: img.caption, likes: img.likes })),
        },
      };
      return await sanitizeToolResultImages(
        result as Parameters<typeof sanitizeToolResultImages>[0],
        "xhs-images",
      );
    },
  };
}

// ─── Tool 6: event_search ─────────────────────────────────────────────────────

const EventSearchSchema = Type.Object({
  destination: Type.String({ description: "活动目的地名称，如 '西溪湿地'" }),
  user_query: Type.String({ description: "用户的原始问题全文，如 '今晚去西溪湿地看灯会怎么走'" }),
});

export function createEventSearchTool(options?: { geminiApiKey?: string }): AnyAgentTool {
  return {
    name: "event_search",
    label: "Event Search",
    description: `活动实时信息搜索 — 当目的地涉及特定活动或事件时调用（灯会、演唱会、展览、庙会、花展等）。
使用联网搜索获取：活动实际入口/地址、停车限制、交通管制、人流预测、最新公告等信息。
同时返回活动的精确地点（可能和地图默认地址不同，如"西溪湿地北门"而非"西溪湿地"）。

⚠️ 如果搜索结果显示活动地点与 smart_trip 解析的目的地不同，以此工具返回的 suggested_destination 为准重新规划路线。`,
    parameters: EventSearchSchema,
    execute: async (_toolCallId, args) => {
      const geminiApiKey = options?.geminiApiKey;
      if (!geminiApiKey) {
        return jsonResult({ error: "未配置 Gemini API Key，无法搜索活动信息" });
      }

      const params = args as Record<string, unknown>;
      const destination = readStringParam(params, "destination", { required: true });
      const userQuery = readStringParam(params, "user_query", { required: true });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;

      // 让 Gemini 自己决定搜索维度，不硬编码
      const searchPrompt = `用户问题：「${userQuery}」
目的地：${destination}

请联网搜索关于「${destination}」相关活动的最新信息，重点回答：
1. 活动的具体位置/入口（是否在景区特定区域/门口）
2. 是否有停车限制或交通管制
3. 目前的开放时间和人流情况
4. 游客需要注意的事项

请基于真实搜索结果回答，明确标注信息来源时间。如果无法确认某项信息，直接说明。`;

      async function geminiSearch(prompt: string): Promise<string | null> {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              tools: [{ google_search: {} }],
            }),
            signal: AbortSignal.timeout(20000),
          });
          if (!res.ok) {
            return null;
          }
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          return (
            data.candidates?.[0]?.content?.parts
              ?.map((p) => p.text)
              .filter(Boolean)
              .join("\n") ?? null
          );
        } catch {
          return null;
        }
      }

      const searchResult = await geminiSearch(searchPrompt);
      if (!searchResult) {
        return jsonResult({
          error: "活动信息搜索失败",
          note: "⚠️ 无法获取活动实时信息。请告知用户你无法确认当前活动状态，建议查询官方渠道。不要编造任何活动信息。",
        });
      }

      // 提取精确活动地点
      const locationPrompt = `根据以下活动信息，提取出最适合导航的【活动入口地点名称】（5-10个字，如"西溪湿地北门"）。
只返回一个地点名，不加引号，不加解释。如果无法确定，返回：${destination}

活动信息：
${searchResult}`;

      const suggestedDest = await geminiSearch(locationPrompt);
      const cleanDest = suggestedDest?.trim().replace(/["'"]/g, "");
      const finalSuggested =
        cleanDest && cleanDest !== destination && cleanDest.length <= 20 ? cleanDest : undefined;

      return jsonResult({
        search_results: searchResult,
        ...(finalSuggested ? { suggested_destination: finalSuggested } : {}),
        note: "⚠️ 以上是联网搜索的真实活动信息。只能使用 search_results 中明确包含的信息，不得补充或推断未提及的细节。注意结合 current_time 判断活动是否仍在进行。",
      });
    },
  };
}

// ─── 辅助函数：Haversine 球面距离 ────────────────────────────────────────────

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // 地球半径（米）
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── 辅助函数：贪心最近点路线优化 ──────────────────────────────────────────────

interface GeoPoint {
  name: string;
  lng: number;
  lat: number;
  address: string;
  type?: string;
  rating?: string;
  business_hours?: string;
  tel?: string;
}

function optimizeRouteGreedy(start: { lng: number; lat: number }, points: GeoPoint[]): GeoPoint[] {
  const remaining = [...points];
  const ordered: GeoPoint[] = [];
  let current = start;

  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      const dist = haversineDistance(current.lat, current.lng, p.lat, p.lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    const next = remaining.splice(nearestIdx, 1)[0];
    ordered.push(next);
    current = { lng: next.lng, lat: next.lat };
  }
  return ordered;
}

// ─── 辅助函数：解析时间段 ──────────────────────────────────────────────────────

function parseDurationHours(input: string): number {
  const s = input.trim();
  // "3小时" "3h" "3hours"
  const hourMatch = s.match(/(\d+)\s*(?:小时|h|hours?)/i);
  if (hourMatch) {
    return parseInt(hourMatch[1], 10);
  }
  // "半天" → 4h
  if (s.includes("半天")) {
    return 4;
  }
  // "一整天" "全天" → 8h
  if (s.includes("一整天") || s.includes("全天") || s.includes("一天")) {
    return 8;
  }
  // "2天" → 16h（两天有效游览时间）
  const dayMatch = s.match(/(\d+)\s*天/);
  if (dayMatch) {
    return parseInt(dayMatch[1], 10) * 8;
  }
  // 默认 4 小时
  return 4;
}

// ─── 辅助函数：POI 类型推荐停留时间（分钟）──────────────────────────────────────

function suggestedStayMinutes(poiType: string): number {
  if (/风景|景区|公园|寺|庙|塔|湖|山|古镇|遗址/.test(poiType)) {
    return 60;
  }
  if (/餐饮|美食|饭|菜|火锅|烧烤|小吃|面|粉/.test(poiType)) {
    return 45;
  }
  if (/购物|商场|市场|步行街|商业/.test(poiType)) {
    return 30;
  }
  if (/博物|展览|美术|科技馆|纪念/.test(poiType)) {
    return 60;
  }
  if (/咖啡|茶|酒吧|甜品/.test(poiType)) {
    return 30;
  }
  return 40;
}

// ─── 辅助函数：高德 POI 类型编码映射 ────────────────────────────────────────────

function interestsToTypes(interests: string): string {
  const mapping: Array<[RegExp, string]> = [
    [/景点|风景|自然|公园|古迹|历史|文化/, "110000"], // 风景名胜
    [/美食|吃|餐|饭|小吃/, "050000"], // 餐饮服务
    [/购物|买|商场|特产/, "060000"], // 购物服务
    [/娱乐|玩|游乐|KTV|电影/, "080000"], // 休闲娱乐
    [/博物|展览|美术|科技/, "140000"], // 科教文化
  ];
  const types: string[] = [];
  for (const [pattern, code] of mapping) {
    if (pattern.test(interests)) {
      types.push(code);
    }
  }
  // 未匹配到则默认搜景点+美食
  return types.length > 0 ? types.join("|") : "110000|050000";
}

// ─── 辅助函数：生成多点标注地图 ──────────────────────────────────────────────

async function generateMultiPointMap(
  points: Array<{ name: string; lng: number; lat: number; order: number }>,
  apiKey: string,
): Promise<{ image_path: string; map_description: string } | null> {
  try {
    const markers: string[] = [];
    const colors = [
      "0xFF4444",
      "0x4488FF",
      "0x44BB44",
      "0xFF8800",
      "0xAA44FF",
      "0x00BBCC",
      "0xFF44AA",
      "0x888888",
    ];
    for (const p of points) {
      const color = colors[(p.order - 1) % colors.length] ?? "0xFF4444";
      markers.push(`large,${color},${p.order}:${p.lng},${p.lat}`);
    }

    const staticUrl = new URL(`${AMAP_BASE}/v3/staticmap`);
    staticUrl.searchParams.set("key", apiKey);
    staticUrl.searchParams.set("size", "800*600");
    staticUrl.searchParams.set("scale", "2");
    staticUrl.searchParams.set("markers", markers.join("|"));

    const imgRes = await fetch(staticUrl.toString());
    if (!imgRes.ok) {
      return null;
    }
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());

    const fs = await import("node:fs/promises");
    const tmpDir = "/tmp/openclaw";
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpPath = `${tmpDir}/trip-map-${Date.now()}.png`;
    try {
      const sharp = (await import("sharp")).default;
      const resized = await sharp(imgBuf).resize({ width: 350 }).png({ quality: 80 }).toBuffer();
      await fs.writeFile(tmpPath, resized);
    } catch {
      await fs.writeFile(tmpPath, imgBuf);
    }

    const desc = points.map((p) => `${p.order}. ${p.name}`).join("、");
    return {
      image_path: tmpPath,
      map_description: `地图标注了 ${points.length} 个地点：${desc}。编号越小越先到达。`,
    };
  } catch {
    return null;
  }
}

// ─── Tool 7: trip_planner — 当地行程规划工具 ────────────────────────────────────

const TripPlannerSchema = Type.Object({
  location: Type.String({
    description:
      "当前所在位置或目的地城市/区域，如 '西湖' '春熙路' '南京路步行街' '我在灵隐寺附近'",
  }),
  city: Type.Optional(
    Type.String({
      description: "城市名，如 '杭州'、'成都'。可从 location 自动推断",
    }),
  ),
  interests: Type.Optional(
    Type.String({
      description: "兴趣偏好，如 '美食' '历史文化' '自然风景' '购物' '娱乐'。可组合多个",
    }),
  ),
  places: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "想去的地点列表，如 ['灵隐寺', '河坊街', '南宋御街']。提供此参数时进入路线优化模式",
    }),
  ),
  duration: Type.Optional(
    Type.String({
      description: "可用时间，如 '半天' '3小时' '一整天'",
    }),
  ),
  transport: Type.Optional(
    Type.String({
      description: "交通方式偏好：'步行'（默认）、'驾车'、'公交'",
    }),
  ),
});

export function createTripPlannerTool(): AnyAgentTool {
  return {
    name: "trip_planner",
    label: "Trip Planner",
    description: `当地行程规划工具 — 用户到达一个地方后，进行当地游玩/美食/行程规划时调用。

两种模式：
1. 推荐模式：用户只说了当前位置（无 places），搜索周边景点/美食/娱乐，按评分和距离排序推荐
2. 规划模式：用户给了多个想去的地点（places），自动优化游览顺序，编排带时间节点的行程表

数据融合：高德 POI（评分、营业时间、距离）+ 小红书网友实拍和推荐
返回结构化数据，由 AI 综合组织回复。

注意事项：
- 推荐模式下，根据 interests 参数筛选类型（景点/美食/购物/娱乐）
- 规划模式下，使用贪心最近点算法优化路线顺序
- 结合营业时间和用餐时段安排行程
- 如果有地图生成，回复第一行使用 MEDIA 标签展示`,
    parameters: TripPlannerSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = process.env.AMAP_API_KEY;
      if (!apiKey) {
        logWarn("trip_planner: AMAP_API_KEY not set");
        return jsonResult({ error: "未配置高德地图 API Key（AMAP_API_KEY）" });
      }

      const params = args as Record<string, unknown>;
      const locationStr = readStringParam(params, "location", { required: true });
      const city = typeof params.city === "string" ? params.city : undefined;
      const interests = typeof params.interests === "string" ? params.interests : undefined;
      const places = readStringArrayParam(params, "places");
      const durationStr = typeof params.duration === "string" ? params.duration : undefined;
      const transport = typeof params.transport === "string" ? params.transport : "步行";

      // 1. 解析当前位置坐标
      const locationGeo = await geocode(locationStr, apiKey, city);
      if (!locationGeo) {
        return jsonResult({ error: `无法识别位置"${locationStr}"，请提供更具体的地址` });
      }
      const resolvedCity = city ?? locationGeo.formatted.match(/^(.{2,3}(?:市|省))/)?.[1] ?? "未知";

      // 2. 获取天气（并行，不阻塞主逻辑）
      const weatherPromise = getAmapWeather(resolvedCity, apiKey);

      if (places && places.length > 0) {
        // ─── 规划模式：多点路线优化 ─────────────────────────────

        // 解析所有地点坐标
        const geoResults = await Promise.all(
          places.map(async (name) => {
            const geo = await geocode(name, apiKey, city ?? resolvedCity);
            if (!geo) {
              return null;
            }
            return {
              name,
              lng: parseFloat(geo.lng),
              lat: parseFloat(geo.lat),
              address: geo.formatted,
            };
          }),
        );

        const validPoints: GeoPoint[] = [];
        const failedPlaces: string[] = [];
        for (let i = 0; i < places.length; i++) {
          const result = geoResults[i];
          if (result) {
            validPoints.push(result);
          } else {
            failedPlaces.push(places[i]);
          }
        }

        if (validPoints.length === 0) {
          return jsonResult({ error: "所有地点都无法识别，请检查地点名称" });
        }

        // 为每个点补充 POI 详情（评分、营业时间、类型）
        const enrichedPoints = await Promise.all(
          validPoints.map(async (point) => {
            try {
              const data = (await amapGet("/v3/place/text", {
                keywords: point.name,
                city: city ?? resolvedCity,
                key: apiKey,
                output: "json",
                offset: "1",
                extensions: "all",
              })) as {
                status: string;
                pois?: Array<{
                  name: string;
                  type: string;
                  biz_ext?: { rating?: string; opentime?: string };
                  tel: string | [];
                }>;
              };
              const poi = data.status === "1" ? data.pois?.[0] : undefined;
              return {
                ...point,
                type: poi?.type?.split(";")[0] ?? "",
                rating:
                  poi?.biz_ext?.rating && poi.biz_ext.rating !== "0"
                    ? poi.biz_ext.rating
                    : undefined,
                business_hours: poi?.biz_ext?.opentime || undefined,
                tel: poi?.tel && !Array.isArray(poi.tel) ? poi.tel : undefined,
              };
            } catch {
              return point;
            }
          }),
        );

        // 贪心路线优化
        const startPoint = { lng: parseFloat(locationGeo.lng), lat: parseFloat(locationGeo.lat) };
        const optimized = optimizeRouteGreedy(startPoint, enrichedPoints);

        // 获取各段实际路线耗时
        const segments: Array<{ distance_m: number; duration_min: number }> = [];
        let prevLng = locationGeo.lng;
        let prevLat = locationGeo.lat;
        for (const point of optimized) {
          const routeFn =
            transport === "驾车"
              ? async () => {
                  const data = (await amapGet("/v3/direction/driving", {
                    origin: `${prevLng},${prevLat}`,
                    destination: `${point.lng},${point.lat}`,
                    key: apiKey,
                    strategy: "0",
                    output: "json",
                  })) as {
                    status: string;
                    route?: { paths: Array<{ distance: string; duration: string }> };
                  };
                  const p = data.status === "1" ? data.route?.paths?.[0] : undefined;
                  return p
                    ? {
                        distance_m: Number(p.distance),
                        duration_min: Math.ceil(Number(p.duration) / 60),
                      }
                    : null;
                }
              : async () => {
                  const result = await walkingRoute(
                    prevLng,
                    prevLat,
                    String(point.lng),
                    String(point.lat),
                    apiKey,
                  );
                  return result
                    ? { distance_m: result.distance_meters, duration_min: result.duration_minutes }
                    : null;
                };

          try {
            const seg = await routeFn();
            segments.push(seg ?? { distance_m: 0, duration_min: 0 });
          } catch {
            segments.push({ distance_m: 0, duration_min: 0 });
          }
          prevLng = String(point.lng);
          prevLat = String(point.lat);
        }

        // 时间编排
        const durationHours = durationStr ? parseDurationHours(durationStr) : 8;
        const now = new Date();
        let currentMinutes = now.getHours() * 60 + now.getMinutes();
        const endMinutes = currentMinutes + durationHours * 60;

        const itinerary: Array<{
          order: number;
          name: string;
          address: string;
          type: string;
          rating?: string;
          business_hours?: string;
          arrive_time: string;
          suggested_stay: string;
          to_next?: string;
        }> = [];

        let totalDistanceM = 0;
        for (let i = 0; i < optimized.length; i++) {
          const point = optimized[i];
          const seg = segments[i];
          currentMinutes += seg.duration_min;
          totalDistanceM += seg.distance_m;

          const arriveHour = Math.floor(currentMinutes / 60) % 24;
          const arriveMin = currentMinutes % 60;
          const arriveTime = `${arriveHour.toString().padStart(2, "0")}:${arriveMin.toString().padStart(2, "0")}`;

          const stayMin = suggestedStayMinutes(point.type ?? "");

          const nextSeg = i < segments.length - 1 ? segments[i + 1] : undefined;
          const toNext = nextSeg
            ? `${transport}${fmtDuration(nextSeg.duration_min * 60)}/${fmtDistance(nextSeg.distance_m)}`
            : undefined;

          itinerary.push({
            order: i + 1,
            name: point.name,
            address: point.address,
            type: point.type ?? "",
            rating: point.rating,
            business_hours: point.business_hours,
            arrive_time: arriveTime,
            suggested_stay: `${stayMin}分钟`,
            to_next: toNext,
          });

          currentMinutes += stayMin;
        }

        const timeWarning =
          currentMinutes > endMinutes
            ? `⚠️ 预计总时长超出可用时间约${Math.ceil((currentMinutes - endMinutes) / 60)}小时，建议精简行程`
            : undefined;

        // 并行：天气、小红书情报、地图
        const [weatherData, xhsData, mapResult] = await Promise.all([
          weatherPromise,
          searchXiaohongshu(optimized[0]?.name ?? locationStr),
          generateMultiPointMap(
            optimized.map((p, i) => ({ name: p.name, lng: p.lng, lat: p.lat, order: i + 1 })),
            apiKey,
          ),
        ]);

        return jsonResult({
          mode: "itinerary",
          current_time: new Date().toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
          location: locationGeo.formatted,
          city: resolvedCity,
          transport,
          weather: weatherData
            ? {
                condition: weatherData.weather,
                temperature: weatherData.temperature,
                wind: weatherData.wind,
                is_rainy: weatherData.isRainy,
              }
            : null,
          itinerary,
          total_distance: fmtDistance(totalDistanceM),
          total_duration: fmtDuration(
            currentMinutes * 60 - now.getHours() * 3600 - now.getMinutes() * 60,
          ),
          ...(failedPlaces.length > 0
            ? { failed_places: failedPlaces, _fail_note: "以上地点无法识别，已跳过" }
            : {}),
          ...(timeWarning ? { time_warning: timeWarning } : {}),
          ...(xhsData
            ? {
                xiaohongshu_tips: xhsData,
                _xhs_note:
                  "提炼小红书网友与这些景点相关的有用信息（避坑/推荐/注意事项），融入行程建议中。",
              }
            : {}),
          ...(mapResult
            ? {
                image_path: mapResult.image_path,
                map_description: mapResult.map_description,
                _note: `✅ 行程地图已生成。回复第一行必须是：\n![行程路线图](/media?file=${mapResult.image_path})\n\n不要使用 MEDIA 标签或 HTML 标签。`,
              }
            : {}),
        });
      } else {
        // ─── 推荐模式：搜索周边 POI 推荐 ─────────────────────

        const types = interests ? interestsToTypes(interests) : "110000|050000";

        // 并行搜索 POI + 天气 + 小红书
        const [poiData, weatherData, xhsData] = await Promise.all([
          (async () => {
            try {
              const data = (await amapGet("/v3/place/around", {
                location: `${locationGeo.lng},${locationGeo.lat}`,
                types,
                radius: "3000",
                key: apiKey,
                output: "json",
                offset: "20",
                extensions: "all",
                sortrule: "weight",
              })) as {
                status: string;
                pois?: Array<{
                  name: string;
                  address: string | [];
                  location: string;
                  distance: string;
                  type: string;
                  tel: string | [];
                  biz_ext?: { rating?: string; opentime?: string; cost?: string };
                }>;
              };
              return data.status === "1" ? (data.pois ?? []) : [];
            } catch {
              return [];
            }
          })(),
          weatherPromise,
          searchXiaohongshu(`${locationStr} ${interests ?? "推荐"}`),
        ]);

        // 按评分排序（有评分的优先，评分高的靠前）
        const sortedPois = poiData
          .filter((p) => p.name && p.location)
          .toSorted((a, b) => {
            const rA = parseFloat(a.biz_ext?.rating ?? "0");
            const rB = parseFloat(b.biz_ext?.rating ?? "0");
            if (rA !== rB) {
              return rB - rA;
            }
            return Number(a.distance) - Number(b.distance);
          })
          .slice(0, 10);

        // 分类整理
        const recommendations = sortedPois.map((p) => {
          const typeName = p.type?.split(";")[0] ?? "";
          let category = "其他";
          if (/风景|景区|公园|寺|庙|古镇/.test(typeName)) {
            category = "景点";
          } else if (/餐饮|美食|饭|菜|火锅|小吃/.test(typeName)) {
            category = "美食";
          } else if (/购物|商场|步行街/.test(typeName)) {
            category = "购物";
          } else if (/娱乐|游乐|KTV|电影/.test(typeName)) {
            category = "娱乐";
          } else if (/博物|展览|美术/.test(typeName)) {
            category = "文化";
          }

          return {
            name: p.name,
            category,
            rating: p.biz_ext?.rating && p.biz_ext.rating !== "0" ? p.biz_ext.rating : undefined,
            distance: fmtDistance(Number(p.distance)),
            address: Array.isArray(p.address) ? "" : p.address,
            business_hours: p.biz_ext?.opentime || undefined,
            avg_cost:
              p.biz_ext?.cost && p.biz_ext.cost !== "0" ? `人均${p.biz_ext.cost}元` : undefined,
            tel: Array.isArray(p.tel) ? undefined : p.tel || undefined,
          };
        });

        // 生成推荐地点的地图
        const mapResult =
          recommendations.length > 0
            ? await generateMultiPointMap(
                recommendations.slice(0, 8).map((r, i) => {
                  const poi = sortedPois.find((p) => p.name === r.name);
                  const [lng, lat] = poi?.location?.split(",") ?? ["0", "0"];
                  return { name: r.name, lng: parseFloat(lng), lat: parseFloat(lat), order: i + 1 };
                }),
                apiKey,
              )
            : null;

        return jsonResult({
          mode: "recommend",
          current_time: new Date().toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
          location: locationGeo.formatted,
          city: resolvedCity,
          interests: interests ?? "景点+美食",
          weather: weatherData
            ? {
                condition: weatherData.weather,
                temperature: weatherData.temperature,
                wind: weatherData.wind,
                is_rainy: weatherData.isRainy,
              }
            : null,
          recommendations,
          ...(recommendations.length === 0
            ? { _empty_note: "未找到匹配的推荐，建议换个关键词或扩大搜索范围" }
            : {}),
          ...(xhsData
            ? {
                xiaohongshu_tips: xhsData,
                _xhs_note: "提炼小红书网友关于这些地方的推荐和避坑建议，融入推荐介绍中。",
              }
            : {}),
          ...(mapResult
            ? {
                image_path: mapResult.image_path,
                map_description: mapResult.map_description,
                _note: `✅ 推荐地图已生成。回复第一行必须是：\n![推荐地点地图](/media?file=${mapResult.image_path})\n\n不要使用 MEDIA 标签或 HTML 标签。`,
              }
            : {}),
        });
      }
    },
  };
}
