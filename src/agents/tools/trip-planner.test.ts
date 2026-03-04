import { describe, it, expect } from "vitest";
import { createTripPlannerTool } from "./amap-tool.js";

describe("trip_planner tool", () => {
  it("should have correct tool definition", () => {
    const tool = createTripPlannerTool();
    expect(tool.name).toBe("trip_planner");
    expect(tool.label).toBe("Trip Planner");
    expect(tool.description).toContain("当地行程规划");
    expect(tool.execute).toBeTypeOf("function");
    expect(tool.parameters).toBeDefined();
  });

  it("should have correct parameter schema", () => {
    const tool = createTripPlannerTool();
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("location");
    expect(props).toHaveProperty("city");
    expect(props).toHaveProperty("interests");
    expect(props).toHaveProperty("places");
    expect(props).toHaveProperty("duration");
    expect(props).toHaveProperty("transport");
  });

  it("should require location parameter", async () => {
    const tool = createTripPlannerTool();
    await expect(tool.execute("test-call", {})).rejects.toThrow(/location required/i);
  });

  it("should return error when AMAP_API_KEY is not set", async () => {
    const originalKey = process.env.AMAP_API_KEY;
    delete process.env.AMAP_API_KEY;
    try {
      const tool = createTripPlannerTool();
      const result = tool.execute("test-call", { location: "西湖" });
      const resolved = await result;
      const text = (resolved as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(text).toContain("AMAP_API_KEY");
    } finally {
      if (originalKey) {
        process.env.AMAP_API_KEY = originalKey;
      }
    }
  });
});
