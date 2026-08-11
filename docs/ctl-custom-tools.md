# Custom tools — ПАПКА = ТУЛА

Кастомные тулы живут в **app userData** (рядом с чатами), **не в open project** и не в `electron/tools/`.

```
<userData>/custom-tools/<name>/
  tool.json
  main.js          # или main.py / main.ps1
  …
```

**Default:** folder tool = обычный код. Runtime: stdin `{args,ctx}` → stdout JSON.

Агент создаёт через:

```
custom_tool action=add name=… code=… runtime=node inputSchema={…} description=…
```

После add — **по имени** как first-class tool. Путь только под `userData/custom-tools/<name>/`.

## Когда folder / CTL / built-in

| Запрос | Что делать |
|--------|------------|
| «сделай тул / кастом тул / тулу / multi-step» | `custom_tool action=add` → **folder** (code/files) |
| thin legacy chain | optional `body={kind:pipeline\|script\|call}` |
| «добавь built-in в runtime ComposeVC» | явно → `electron/tools` |
| один вызов read_file/anti | custom tool не нужен |

**Запрещено:** писать тулы в project tree; `electron/tools/*.cjs` + `registry.cjs` без явного запроса runtime.

## Контракт entry

- cwd = папка тула
- stdin JSON: `{ "args": {…}, "ctx": { toolDir, rootPath, userDataPath, … } }`
- stdout JSON, exit 0
- runtimes: node, python, powershell, bash, …

```
custom_tool action=run name=my_tool args={…}
custom_tool action=write_file|read_file|list_files|path name=my_tool …
```

## Kinds

### pipeline — линейная цепочка

```json
{
  "kind": "pipeline",
  "steps": [
    { "id": "api", "tool": "http", "input": { "url": "$args.url" } },
    { "id": "data", "op": "json", "value": "$steps.api.text" },
    { "id": "items", "op": "get", "from": "$steps.data", "path": "items" }
  ],
  "return": "$steps.items"
}
```

Шаг может быть:
- `tool` + `input` — вызов built-in / другого custom tool
- `op` — inline data/http/wait (без registry)

### script — ветки, циклы, try

```json
{
  "kind": "script",
  "body": [
    { "op": "http", "as": "res", "url": "$args.url", "method": "GET" },
    {
      "op": "if",
      "when": { "$expr": "$vars.res.status == 200" },
      "then": [
        { "op": "json", "as": "data", "value": "$vars.res.text" },
        { "op": "return", "value": "$vars.data" }
      ],
      "else": [{ "op": "throw", "message": "HTTP failed" }]
    }
  ]
}
```

### call — тонкая обёртка

```json
{
  "kind": "call",
  "tool": "http",
  "input": { "url": "$args.url", "method": "GET" },
  "return": "$result.json"
}
```

## Переменные

| Ref | Значение |
|-----|----------|
| `$args.x` | аргументы вызова |
| `$steps.id` | результат pipeline step |
| `$vars.y` | set / as |
| `$last` / `$result` | последний результат |
| `$env.rootPath` | корень проекта |
| `${args.x}` | интерполяция в строке |

## HTTP

Built-in tool **`http`** (и op `http` в script/pipeline):

```json
{
  "tool": "http",
  "input": {
    "url": "https://api.example.com/v1/x",
    "method": "POST",
    "headers": { "Authorization": "Bearer ${args.token}" },
    "json": { "q": "$args.query" },
    "timeout_ms": 30000
  }
}
```

Ответ: `{ ok, status, headers, text, json, url, method }`.

- Для **JSON API** → `http`, не `web_fetch` (web_fetch режет non-HTML).
- Для **HTML статьи** → `web_fetch`.

## Data ops (pipeline step `op` / script `op`)

`json`, `stringify`, `pick`, `omit`, `get`, `set_path`, `merge`, `object`, `array`, `concat`, `flatten`, `unique`, `sort`, `pluck`, `group`, `keys`, `values`, `entries`, `length`, `slice`, `join`, `split`, `lower`, `upper`, `trim`, `match`, `replace`, `coalesce`, `number`, `bool`, `clone`, `now`, `env`

Пример merge двух API:

```json
{
  "kind": "script",
  "body": [
    { "op": "http", "as": "a", "url": "$args.urlA" },
    { "op": "http", "as": "b", "url": "$args.urlB" },
    { "op": "json", "as": "ja", "value": "$vars.a.text" },
    { "op": "json", "as": "jb", "value": "$vars.b.text" },
    { "op": "merge", "as": "out", "a": "$vars.ja", "b": "$vars.jb", "deep": true },
    { "op": "return", "value": "$vars.out" }
  ]
}
```

## Управление потоком (script)

- `set` / `let`
- `call` / `tool` — любой built-in
- `http`, `wait`
- `if` / `then` / `else`
- `each` / `foreach` (max 30)
- `while` (max 30)
- `try` / `catch`
- `return`, `throw`, `log`

## inputSchema

Всегда задавай schema с `required`, иначе модель вызовет тул без args:

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "API URL" }
  },
  "required": ["url"]
}
```

## Полный add

```json
{
  "action": "add",
  "name": "fetch_todo_title",
  "description": "GET JSON todo and return title",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "todo id" }
    },
    "required": ["id"]
  },
  "body": {
    "kind": "pipeline",
    "steps": [
      {
        "id": "api",
        "tool": "http",
        "input": {
          "url": "https://jsonplaceholder.typicode.com/todos/${args.id}"
        }
      },
      { "id": "data", "op": "json", "value": "$steps.api.text" },
      { "id": "title", "op": "get", "from": "$steps.data", "path": "title" }
    ],
    "return": "$steps.title"
  },
  "tags": ["http", "demo"]
}
```

## Готовые примеры (import)

Файл `docs/ctl-examples.json` — pack из 4 тулов:

| name | Что делает |
|------|------------|
| `http_get_json` | GET → parse JSON |
| `merge_two_apis` | два GET → deep merge |
| `http_with_fallback` | try/catch HTTP |
| `pluck_api_field` | GET array → pluck field |

Импорт:

```
custom_tool action=import path=docs/ctl-examples.json mode=skip
```

или `text`/`pack` с содержимым JSON.

## Тесты runtime

```
node --test tests/ctl/folderTools-runtime.test.mjs
node --test tests/ctl/customTools-runtime.test.mjs
```

Folder: scaffold, execute JSON, add default folder, path under userData, remove dir.  
Legacy CTL: data ops, httpRequest, script/pipeline, try/catch.
