import { countTokens as rawCountTokens } from "gpt-tokenizer";
import { ChatRequestMessage } from "../types";

function safeCountTokens(text: string): number {
  try {
    return rawCountTokens(text, { disallowedSpecial: new Set() });
  } catch {
    try {
      return rawCountTokens(text);
    } catch {
      return Math.ceil(String(text || "").length / 4);
    }
  }
}

const MESSAGE_OVERHEAD_TOKENS = 4;
const REPLY_PRIMING_TOKENS = 3;

export const SYSTEM_PROMPT_OVERHEAD_ESTIMATE = 400;

function stringifyForTokens(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Rough vision surcharge so image attachments inflate the context ring. */
function countImageTokens(message: ChatRequestMessage): number {
  let total = 0;
  const addUrl = (url: string) => {
    const u = String(url || "");
    if (!u) return;
    total += 85 + Math.min(2000, Math.ceil(u.length / 400));
  };
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url") addUrl(part.image_url?.url || "");
    }
  }
  if (Array.isArray(message.images)) {
    for (const img of message.images) {
      if (!img) continue;
      addUrl(img.url || img.dataUrl || "");
    }
  }
  return total;
}

export function countMessageTokens(message: ChatRequestMessage): number {
  if (!message) return MESSAGE_OVERHEAD_TOKENS;
  return (
    safeCountTokens(stringifyForTokens(message.content)) +
    safeCountTokens(message.role || "") +
    countImageTokens(message) +
    MESSAGE_OVERHEAD_TOKENS
  );
}

export function countMessagesTokens(messages: ChatRequestMessage[]): number {
  const total = messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
  return total + REPLY_PRIMING_TOKENS;
}

export { safeCountTokens as countTokens };
