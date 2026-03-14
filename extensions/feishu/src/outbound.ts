import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendLocationFeishu,
  sendCardFeishu,
} from "./send.js";

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

// Parse [[LOC:{"title":"...","lat":"...","lng":"...","address":"..."}]] markers
export function extractLocationMarkers(text: string): {
  cleaned: string;
  locations: Array<{ title: string; lat: string; lng: string; address: string }>;
} {
  const locRegex = /\[\[LOC:(.*?)\]\]/gs;
  const locations: Array<{ title: string; lat: string; lng: string; address: string }> = [];
  const cleaned = text.replace(locRegex, (_, json: string) => {
    try {
      const loc = JSON.parse(json) as {
        title?: string;
        lat?: string;
        lng?: string;
        address?: string;
      };
      if (loc.title && loc.lat && loc.lng) {
        locations.push({
          title: loc.title,
          lat: loc.lat,
          lng: loc.lng,
          address: loc.address ?? "",
        });
      }
    } catch {
      // ignore malformed markers
    }
    return "";
  });
  return { cleaned: cleaned.trim(), locations };
}

// Parse [[XHS_IMG:{"path":"...","title":"...","likes":"...","url":"..."}]] markers
export function extractXhsImageMarkers(text: string): {
  cleaned: string;
  xhsImages: Array<{ path: string; title: string; likes: string; url: string }>;
} {
  const xhsRegex = /\[\[XHS_IMG:(.*?)\]\]/gs;
  const xhsImages: Array<{ path: string; title: string; likes: string; url: string }> = [];
  const cleaned = text.replace(xhsRegex, (_, json: string) => {
    try {
      const img = JSON.parse(json) as {
        path?: string;
        title?: string;
        likes?: string;
        url?: string;
      };
      if (img.path) {
        xhsImages.push({
          path: img.path,
          title: img.title ?? "",
          likes: img.likes ?? "",
          url: img.url ?? "",
        });
      }
    } catch {
      // ignore malformed markers
    }
    return "";
  });
  return { cleaned: cleaned.trim(), xhsImages };
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  let { cfg, to, text, accountId, replyToMessageId } = params;

  // Extract XHS image markers before any other processing
  const { cleaned: textWithoutXhs, xhsImages } = extractXhsImageMarkers(text);
  text = textWithoutXhs;

  // Extract location card markers before any other processing
  const { cleaned: textWithoutLoc, locations } = extractLocationMarkers(text);
  text = textWithoutLoc;

  // Extract inline markdown images (HTTP/HTTPS URLs) and send as separate media
  const httpImageRegex = /!\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g;
  const httpMatches = [...text.matchAll(httpImageRegex)];
  for (const match of httpMatches) {
    const imageUrl = match[2];
    try {
      await sendMediaFeishu({
        cfg,
        to,
        mediaUrl: imageUrl,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    } catch (err) {
      console.error(`[feishu] failed to send inline markdown image: ${imageUrl}`, err);
    }
  }
  if (httpMatches.length > 0) {
    text = text.replace(httpImageRegex, (_, alt) => `[图片: ${alt || "附件"}]`);
  }

  // Extract inline markdown images using /media?file=<local-path> scheme (amap-tool generated maps)
  const localMediaRegex = /!\[(.*?)\]\(\/media\?file=([^\s)]+)\)/g;
  const localMatches = [...text.matchAll(localMediaRegex)];
  for (const match of localMatches) {
    const localPath = decodeURIComponent(match[2]);
    if (path.isAbsolute(localPath) && fs.existsSync(localPath)) {
      try {
        await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localPath,
          accountId: accountId ?? undefined,
          replyToMessageId,
          mediaLocalRoots: ["/tmp"],
        });
      } catch (err) {
        console.error(`[feishu] failed to send local media image: ${localPath}`, err);
      }
    }
  }
  if (localMatches.length > 0) {
    text = text.replace(localMediaRegex, (_, alt) => `[图片: ${alt || "附件"}]`);
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  let result: Awaited<ReturnType<typeof sendMessageFeishu>>;
  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    result = await sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  } else {
    result = await sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  // Send XHS image cards (image + title + link) after main text
  for (const xhs of xhsImages) {
    try {
      const localPath = xhs.path;
      if (path.isAbsolute(localPath) && fs.existsSync(localPath)) {
        await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localPath,
          accountId: accountId ?? undefined,
          replyToMessageId,
          mediaLocalRoots: ["/tmp"],
        });
      }
      // Send caption card with title and link
      const lines: string[] = [];
      if (xhs.title) lines.push(`**${xhs.title}**`);
      if (xhs.url) lines.push(`[🔗 查看小红书原帖](${xhs.url})`);
      if (lines.length > 0) {
        const captionCard = {
          schema: "2.0",
          config: { wide_screen_mode: false },
          body: { elements: [{ tag: "markdown", content: lines.join("\n") }] },
        };
        await sendCardFeishu({
          cfg,
          to,
          card: captionCard,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
      }
    } catch (err) {
      console.error(`[feishu] failed to send xhs image card: ${xhs.title}`, err);
    }
  }

  // Send location cards after the main text message
  for (const loc of locations) {
    try {
      await sendLocationFeishu({
        cfg,
        to,
        title: loc.title,
        lat: loc.lat,
        lng: loc.lng,
        address: loc.address,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    } catch (err) {
      console.error(`[feishu] failed to send location card: ${loc.title}`, err);
    }
  }

  return result;
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaLocalRoots,
    replyToId,
    threadId,
  }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Send text first if provided
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
};
