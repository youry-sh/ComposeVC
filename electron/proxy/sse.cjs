/**
 * OpenAI-compatible SSE helpers.
 */

function writeSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sendSse(res, payload) {
  if (res.writableEnded) return;
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`data: ${data}\n\n`);
}

function sendSseDone(res) {
  if (res.writableEnded) return;
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(text);
}

function sendOpenAIError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, {
    error: {
      message: String(message || "error"),
      type,
      param: null,
      code: null,
    },
  });
}

module.exports = {
  writeSseHeaders,
  sendSse,
  sendSseDone,
  sendJson,
  sendOpenAIError,
};
