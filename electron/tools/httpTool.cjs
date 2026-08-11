const { httpRequest } = require("../ctl/httpRequest.cjs");

module.exports = {
  name: "http",
  description:
    "HTTP client for APIs and raw responses (JSON/text). Prefer this over web_fetch for JSON APIs " +
    "and over bash+curl inside folder custom tools. Returns { ok, status, headers, text, json, url }.\n" +
    "Args: url (required), method (GET|POST|…), headers, query, body|json|form, timeout_ms, parse, throw_http.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http(s) URL" },
      method: { type: "string", description: "HTTP method (default GET)" },
      headers: { type: "object", description: "Request headers map" },
      query: {
        type: "object",
        description: "Query string params object (also accepts string)",
      },
      params: { type: "object", description: "Alias of query" },
      body: { description: "Raw body string/object (object → JSON)" },
      json: { description: "JSON body object/array (sets Content-Type)" },
      data: { description: "Alias of body" },
      form: { type: "object", description: "application/x-www-form-urlencoded fields" },
      timeout_ms: { type: "number", description: "Timeout ms (default 30000, max 180000)" },
      max_chars: { type: "number", description: "Max response text chars returned" },
      parse: { type: "string", description: "json | text (default auto)" },
      as: { type: "string", description: "Alias of parse" },
      throw_http: {
        type: "boolean",
        description: "If true, throw on non-2xx status (default false)",
      },
      redirect: { type: "string", description: "follow | manual (default follow)" },
    },
    required: ["url"],
  },
  async execute(input = {}) {
    return httpRequest(input || {});
  },
};
