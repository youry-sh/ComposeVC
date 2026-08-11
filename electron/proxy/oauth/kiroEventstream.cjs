/**
 * AWS EventStream binary framing for Kiro (OmniRoute parity, CJS).
 */

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.headOffset = 0;
    this.length = 0;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peekUint32BE(offset = 0) {
    if (this.length < offset + 4) return null;
    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = (value << 8) | this.byteAt(offset + i);
    }
    return value >>> 0;
  }

  read(length) {
    if (length < 0 || this.length < length) return null;
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[0];
      const available = head.length - this.headOffset;
      const take = Math.min(available, length - written);
      output.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;
      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return output;
  }

  byteAt(offset) {
    let remaining = offset;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      if (remaining < available) return chunk[start + remaining];
      remaining -= available;
    }
    return 0;
  }
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);
    const preludeCRC = view.getUint32(8, false);
    if (preludeCRC !== crc32(data.slice(0, 8))) return null;

    const headers = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;
    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;
      const name = TEXT_DECODER.decode(data.subarray(offset, offset + nameLen));
      offset += nameLen;
      const headerType = data[offset];
      offset++;
      if (headerType === 7) {
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;
        headers[name] = TEXT_DECODER.decode(data.subarray(offset, offset + valueLen));
        offset += valueLen;
      } else {
        break;
      }
    }

    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4;
    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = TEXT_DECODER.decode(data.subarray(payloadStart, payloadEnd));
      if (payloadStr && payloadStr.trim()) {
        try {
          payload = JSON.parse(payloadStr);
        } catch {
          payload = { raw: payloadStr };
        }
      }
    }
    return { headers, payload, totalLength };
  } catch {
    return null;
  }
}

/**
 * Convert Kiro EventStream body into an OpenAI-compatible SSE ReadableStream-like async source.
 * Returns a Response-like object with body that yields UTF-8 SSE text chunks.
 */
async function transformEventStreamToSseResponse(upstream, model) {
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const state = {
    startEmitted: false,
    finishEmitted: false,
    hasToolCalls: false,
    toolCallIndex: 0,
    seenToolIds: new Map(),
    toolArgsBuffered: new Map(),
    toolArgsEmitted: new Map(),
  };

  const { Readable } = require("stream");
  const queue = new ByteQueue();
  let leftover = Buffer.alloc(0);
  let closed = false;

  function encodeSse(obj) {
    return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, "utf8");
  }

  function emitStart(push) {
    if (state.startEmitted) return;
    state.startEmitted = true;
    push(
      encodeSse({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })
    );
  }

  function flushToolArgs(push) {
    for (const [toolCallId, info] of state.toolArgsBuffered) {
      const already = state.toolArgsEmitted.get(toolCallId) || "";
      if (info.canonical && info.canonical !== already) {
        push(
          encodeSse({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: info.toolIndex,
                      function: { arguments: info.canonical },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        );
        state.toolArgsEmitted.set(toolCallId, info.canonical);
      }
    }
    state.toolArgsBuffered.clear();
  }

  function emitFinish(push) {
    if (state.finishEmitted) return;
    state.finishEmitted = true;
    flushToolArgs(push);
    push(
      encodeSse({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: state.hasToolCalls ? "tool_calls" : "stop",
          },
        ],
      })
    );
  }

  function handleFrame(event, push) {
    if (!event) return;
    emitStart(push);
    const eventType = event.headers[":event-type"] || "";
    const payload = event.payload || {};

    // Native reasoning
    if (eventType === "reasoningContentEvent" || payload.reasoningText !== undefined) {
      const rt = payload.reasoningText;
      let text = "";
      if (rt && typeof rt === "object") {
        text = typeof rt.text === "string" ? rt.text : typeof rt.Text === "string" ? rt.Text : "";
      } else if (typeof rt === "string") text = rt;
      else if (typeof payload.text === "string") text = payload.text;
      if (text) {
        push(
          encodeSse({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
          })
        );
      }
      return;
    }

    if (eventType === "assistantResponseEvent") {
      const content = typeof payload.content === "string" ? payload.content : "";
      if (!content) return;
      push(
        encodeSse({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })
      );
      return;
    }

    if (eventType === "codeEvent" && payload.content) {
      push(
        encodeSse({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: String(payload.content) }, finish_reason: null }],
        })
      );
      return;
    }

    if (eventType === "toolUseEvent" && payload) {
      state.hasToolCalls = true;
      const toolUses = Array.isArray(payload) ? payload : [payload];
      for (const tu of toolUses) {
        const toolCallId = tu.toolUseId || `call_${Date.now()}`;
        const toolName = tu.name || "";
        const toolInput = tu.input;
        let toolIndex;
        const isNew = !state.seenToolIds.has(toolCallId);
        if (isNew) {
          toolIndex = state.toolCallIndex++;
          state.seenToolIds.set(toolCallId, toolIndex);
          push(
            encodeSse({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: toolCallId,
                        type: "function",
                        function: { name: toolName, arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })
          );
        } else {
          toolIndex = state.seenToolIds.get(toolCallId);
        }

        if (toolInput != null) {
          if (typeof toolInput === "string") {
            push(
              encodeSse({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: toolIndex, function: { arguments: toolInput } }],
                    },
                    finish_reason: null,
                  },
                ],
              })
            );
            state.toolArgsEmitted.set(
              toolCallId,
              (state.toolArgsEmitted.get(toolCallId) || "") + toolInput
            );
          } else if (typeof toolInput === "object") {
            // Buffer growing objects; flush on finish
            try {
              const canonical = JSON.stringify(toolInput);
              state.toolArgsBuffered.set(toolCallId, { toolIndex, canonical });
            } catch {
              /* */
            }
          }
        }
      }
      return;
    }

    if (
      eventType === "messageMetadataEvent" ||
      eventType === "messageStopEvent" ||
      eventType === "assistantResponseEnd" ||
      eventType === "end" ||
      payload?.stopReason ||
      payload?.type === "message_stop"
    ) {
      emitFinish(push);
    }
  }

  const out = new Readable({
    read() {},
  });

  const push = (buf) => {
    if (!closed) out.push(buf);
  };

  (async () => {
    try {
      const body = upstream.body;
      if (!body) {
        emitFinish(push);
        out.push(null);
        return;
      }

      const processBytes = (u8) => {
        queue.push(u8);
        let iterations = 0;
        while (queue.length >= 16 && iterations < 2000) {
          iterations++;
          const totalLength = queue.peekUint32BE(0);
          if (!totalLength || totalLength < 16 || totalLength > queue.length) break;
          const eventData = queue.read(totalLength);
          if (!eventData) break;
          handleFrame(parseEventFrame(eventData), push);
        }
      };

      if (typeof body.getReader === "function") {
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) processBytes(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } else if (typeof body[Symbol.asyncIterator] === "function") {
        for await (const chunk of body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          processBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        }
      } else if (typeof upstream.arrayBuffer === "function") {
        const ab = await upstream.arrayBuffer();
        processBytes(new Uint8Array(ab));
      }

      emitFinish(push);
      closed = true;
      out.push(null);
    } catch (e) {
      closed = true;
      out.destroy(e);
    }
  })();

  // Fake fetch Response with Node readable body for consumeUpstreamSse
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null),
    },
    body: out,
  };
}

module.exports = {
  ByteQueue,
  parseEventFrame,
  transformEventStreamToSseResponse,
  TEXT_ENCODER,
  TEXT_DECODER,
};
