// Serve local media files (images) to the webchat UI.
// Only files within ALLOWED_ROOTS are served to prevent path-traversal attacks.

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MEDIA_PATH = "/media";

// 只允许从这些目录读取文件
const ALLOWED_ROOTS = ["/tmp"];

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * Handle GET /media?file=<path> requests.
 * Returns true if the request was handled, false otherwise.
 */
export function handleMediaServeRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== MEDIA_PATH) {
    return false;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const filePath = url.searchParams.get("file");
  if (!filePath) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Missing file parameter");
    return true;
  }

  // Resolve to absolute path to prevent path traversal
  const resolved = path.resolve(filePath);
  const isAllowed = ALLOWED_ROOTS.some(
    (root) => resolved.startsWith(root + path.sep) || resolved === root,
  );
  if (!isAllowed) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const data = fs.readFileSync(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", data.length);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(data);
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }

  return true;
}
