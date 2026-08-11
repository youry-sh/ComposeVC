module.exports = {
  name: "ask_user",
  description:
    "Ask the human a clear question and wait for their answer before continuing. " +
    "Use when a choice is required (package manager, approach A vs B, confirm a destructive action, missing preference) " +
    "and guessing would be wrong. Prefer 2–5 short options when possible; allow free text for open answers.\n\n" +
    "Do NOT use for things you can decide from the codebase. Do NOT spam multiple questions — batch related choices " +
    "into one ask when you can. The UI blocks until the user answers.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Short, concrete question shown to the user.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional choices (2–6 short labels). User can pick one or more depending on multi_select.",
      },
      multi_select: {
        type: "boolean",
        description: "If true, user may select multiple options. Default false.",
      },
      allow_free_text: {
        type: "boolean",
        description: "If true (default), user can type a custom answer instead of/in addition to options.",
      },
    },
    required: ["question"],
  },
  async execute(input, context = {}) {
    const question = String(input.question || "").trim();
    if (!question) throw new Error("'question' is required");

    const options = Array.isArray(input.options)
      ? input.options.map((o) => String(o || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    const multiSelect = input.multi_select === true;
    const allowFreeText = input.allow_free_text !== false;

    if (!context.askUser || typeof context.askUser !== "function") {
      throw new Error("ask_user is not available in this session");
    }

    const answer = await context.askUser({
      toolCallId: context.toolCallId,
      question,
      options,
      multiSelect,
      allowFreeText,
    });

    return {
      question,
      selected: Array.isArray(answer?.selected) ? answer.selected : [],
      answer: String(answer?.answer || "").trim(),
      multiSelect,
    };
  },
};
