import fs from "fs";
import path from "path";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { extractLocationMarkers } from "./outbound.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendLocationFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendCardFeishu,
} from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Resolve /media?file=<path> URLs (from agent tools) to bare local paths that loadWebMedia accepts */
function resolveMediaUrl(mediaUrl: string): string {
  if (mediaUrl.startsWith("/media?file=")) {
    return decodeURIComponent(mediaUrl.slice("/media?file=".length));
  }
  return mediaUrl;
}

/** Extract local markdown images from text and return cleaned text + media list */
function extractMarkdownLocalImages(text: string): {
  cleaned: string;
  mediaUrls: string[];
  mediaAlts: Array<{ title: string; noteUrl: string }>;
} {
  const localMediaRegex = /!\[(.*?)\]\(\/media\?file=([^\s)]+)\)/g;
  const mediaUrls: string[] = [];
  const mediaAlts: Array<{ title: string; noteUrl: string }> = [];
  const cleaned = text.replace(localMediaRegex, (_, alt: string, encoded: string) => {
    const localPath = decodeURIComponent(encoded);
    // Validate path is absolute and file exists
    if (path.isAbsolute(localPath) && fs.existsSync(localPath)) {
      // Alt may be "TITLE|||NOTE_URL" for XHS images
      const sepIdx = (alt || "").indexOf("|||");
      const title = sepIdx >= 0 ? alt.slice(0, sepIdx) : alt || "";
      const noteUrl = sepIdx >= 0 ? alt.slice(sepIdx + 3) : "";
      mediaUrls.push(localPath);
      mediaAlts.push({ title, noteUrl });
      // For XHS images: remove placeholder from text; for others: show [图片: alt]
      return localPath.includes("/xhs-") ? "" : `[图片: ${title || "附件"}]`;
    }
    // Keep original markdown if file doesn't exist
    return _;
  });
  return { cleaned, mediaUrls, mediaAlts };
}

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    streamText =
      mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    let pendingLocations: Array<{ title: string; lat: string; lng: string; address: string }> = [];
    if (streaming?.isActive()) {
      const { cleaned, locations } = extractLocationMarkers(streamText);
      pendingLocations = locations;
      let text = cleaned;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    // Send location cards after streaming card is finalized
    for (const loc of pendingLocations) {
      try {
        await sendLocationFeishu({
          cfg,
          to: chatId,
          title: loc.title,
          lat: loc.lat,
          lng: loc.lng,
          address: loc.address,
          replyToMessageId: sendReplyToMessageId,
          accountId,
        });
      } catch (err) {
        params.runtime.error?.(`feishu: failed to send location card: ${String(err)}`);
      }
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

        // Extract any local markdown images from text
        const {
          cleaned: textWithoutMarkdownImages,
          mediaUrls: extractedMediaUrls,
          mediaAlts: extractedMediaAlts,
        } = extractMarkdownLocalImages(text);

        const hasText = Boolean(textWithoutMarkdownImages.trim());
        const hasMedia = mediaList.length > 0 || extractedMediaUrls.length > 0;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (shouldDeliverText) {
          const useCard =
            renderMode === "card" ||
            (renderMode === "auto" && shouldUseCard(textWithoutMarkdownImages));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(textWithoutMarkdownImages, { mode: "delta" });
            }
            if (info?.kind === "final") {
              streamText = mergeStreamingText(streamText, textWithoutMarkdownImages);
              await closeStreaming();
              deliveredFinalTexts.add(text);
            }
            // Send all media (both from payload and extracted from markdown)
            for (const mediaUrl of mediaList) {
              await sendMediaFeishu({
                cfg,
                to: chatId,
                mediaUrl: resolveMediaUrl(mediaUrl),
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                accountId,
                mediaLocalRoots: ["/tmp"],
              });
            }
            for (const mediaPath of extractedMediaUrls) {
              await sendMediaFeishu({
                cfg,
                to: chatId,
                mediaUrl: mediaPath,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                accountId,
                mediaLocalRoots: ["/tmp"],
              });
            }
            return;
          }

          const { cleaned: cleanText, locations: pendingLocations } =
            extractLocationMarkers(textWithoutMarkdownImages);
          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              cleanText,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(cleanText, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          }
          // Send location cards after text delivery
          for (const loc of pendingLocations) {
            try {
              await sendLocationFeishu({
                cfg,
                to: chatId,
                title: loc.title,
                lat: loc.lat,
                lng: loc.lng,
                address: loc.address,
                replyToMessageId: sendReplyToMessageId,
                accountId,
              });
            } catch (err) {
              params.runtime.error?.(`feishu: failed to send location card: ${String(err)}`);
            }
          }
        }

        if (hasMedia) {
          // Send media from payload
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl: resolveMediaUrl(mediaUrl),
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
              mediaLocalRoots: ["/tmp"],
            });
          }
          // Send media extracted from markdown, with caption for XHS images
          for (let i = 0; i < extractedMediaUrls.length; i++) {
            const mediaPath = extractedMediaUrls[i];
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl: mediaPath,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
              mediaLocalRoots: ["/tmp"],
            });
            // For XHS images, send a caption card with title + link below the image
            if (mediaPath.includes("/xhs-")) {
              const meta = extractedMediaAlts[i];
              if (meta?.title) {
                const lines = [`**${meta.title}**`];
                if (meta.noteUrl) lines.push(`[🔗 查看小红书原帖](${meta.noteUrl})`);
                try {
                  await sendCardFeishu({
                    cfg,
                    to: chatId,
                    card: {
                      schema: "2.0",
                      config: { wide_screen_mode: false },
                      body: { elements: [{ tag: "markdown", content: lines.join("\n") }] },
                    },
                    replyToMessageId: sendReplyToMessageId,
                    accountId,
                  });
                } catch (err) {
                  params.runtime.error?.(`feishu: failed to send xhs caption: ${String(err)}`);
                }
              }
            }
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: true,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            queueStreamingUpdate(payload.text, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
