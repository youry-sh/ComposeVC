const assert = require("assert");
const { inferActionFromInput } = require("../electron/tools/customTool.cjs");

function infer(input) {
  return inferActionFromInput(input);
}

assert.equal(infer({}).action, "list");
assert.equal(infer({ action: "" }).action, "list");
assert.equal(infer({ action: "." }).action, "list");
assert.equal(infer({ action: " " }).action, "list");
assert.equal(infer({ op: "ls" }).action, "list");
assert.equal(infer({ command: "create" }).action, "add");
assert.equal(infer({ action: "delete" }).action, "remove");
assert.equal(infer({ action: "exec" }).action, "run");

assert.equal(infer({ query: "telegram video" }).action, "search");
assert.equal(infer({ name: "weather" }).action, "get");
assert.equal(infer({ name: "weather", args: { city: "x" } }).action, "run");
assert.equal(infer({ name: "weather", code: "module.exports=1" }).action, "add");

const write = infer({ name: "main.js", content: "console.log(1)" });
assert.equal(write.action, "write_file");
assert.equal(write.input.file, "main.js");
assert.equal(write.input.name, undefined);

const read = infer({ name: "main.js" });
assert.equal(read.action, "read_file");
assert.equal(read.input.file, "main.js");

const explicit = infer({ action: "write_file", name: "my_tool", file: "main.js", content: "x" });
assert.equal(explicit.action, "write_file");
assert.equal(explicit.inferred, false);
assert.equal(explicit.input.name, "my_tool");

const keepAdd = infer({ action: "add", name: "main.js", code: "x" });
assert.equal(keepAdd.action, "add");
assert.equal(keepAdd.input.name, "main.js");

console.log("custom-tool-action-infer: ok");
