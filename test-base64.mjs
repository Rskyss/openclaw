import fs from "fs";

async function run() {
  const { sanitizeContentBlocksImages } = await import("./dist/plugin-sdk/tool-images-DAjfqhyI.js");
  const buf = fs.readFileSync("/tmp/openclaw/xhs-1772599696530-2.webp");

  const block = {
    type: "image",
    data: buf.toString("base64"),
    mimeType: "image/webp",
  };

  const sanitized = await sanitizeContentBlocksImages([block], "test");
  console.log(
    "Sanitized result:",
    sanitized[0].type,
    "text" in sanitized[0] ? sanitized[0].text : "base64 size: " + sanitized[0].data.length,
  );
}

run().catch(console.error);
