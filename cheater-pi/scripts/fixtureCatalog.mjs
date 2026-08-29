import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const base = (source, verify) => ({
  files: {
  "package.json": JSON.stringify({ type: "module", private: true, scripts: { test: "node verify.mjs" } }, null, 2) + "\n",
    "src/index.mjs": source,
    "verify.mjs": verify,
  },
});

const project = (packageJson, files) => ({
  files: {
    "package.json": JSON.stringify(packageJson, null, 2) + "\n",
    ...files,
  },
});

export const FIXTURES = {
  "task-01-cli-validation": base(
    `export function parseConfig(raw) { const input = raw ?? {}; if (typeof input.port !== "number" || input.port < 1 || input.port > 65535) throw new Error("port must be 1..65535"); if (input.mode !== "dev" && input.mode !== "prod") throw new Error("mode must be dev or prod"); return { port: input.port, mode: input.mode }; }\n`,
    `import assert from "node:assert/strict"; import { parseConfig } from "./src/index.mjs"; assert.deepEqual(parseConfig({port:0,mode:"dev"}), null);`,
  ),
  "task-02-http-retry": base(
    `export function backoff({ attempts = 0, baseMs = 100, maxMs = 1000 } = {}) { const out=[]; for (let i=0;i<attempts;i++) out.push(Math.min(maxMs, baseMs * 2 ** (i + 1))); return out; }\n`,
    `import assert from "node:assert/strict"; import { backoff } from "./src/index.mjs"; assert.deepEqual(backoff({attempts:4,baseMs:100,maxMs:350}),[100,200,350,350]);`,
  ),
  "task-03-cache-invalidation": base(
    `export function updateCache(cache, key, value) { if (!cache.has(key)) cache.set(key, value); return cache; } export function readCache(cache,key){ return cache.get(key); }\n`,
    `import assert from "node:assert/strict"; import { updateCache, readCache } from "./src/index.mjs"; const c=new Map([["x",1]]); updateCache(c,"x",2); assert.equal(readCache(c,"x"),2); updateCache(c,"y",3); assert.equal(readCache(c,"y"),3);`,
  ),
  "task-04-parser-edge": base(
    `export function parseList(text) { return text.split(",").map((x) => x.trim()); }\n`,
    `import assert from "node:assert/strict"; import { parseList } from "./src/index.mjs"; assert.deepEqual(parseList("a,b,"),["a","b"]); assert.deepEqual(parseList(""),[]);`,
  ),
  "task-05-concurrency-race": base(
    `export async function settleWithCancel(work, signal) { const value = await work(); if (signal?.aborted) throw new Error("cancelled"); return value; }\n`,
    `import assert from "node:assert/strict"; import { settleWithCancel } from "./src/index.mjs"; const c=new AbortController(); c.abort(); let calls=0; await assert.rejects(settleWithCancel(async()=>{calls++; return 7;},c.signal),/cancelled/); assert.equal(calls,0);`,
  ),
  "task-06-schema-migration": base(
    `export function migrate(value) { return { version: 2, endpoint: value.endpoint, model: value.model }; }\n`,
    `import assert from "node:assert/strict"; import { migrate } from "./src/index.mjs"; assert.deepEqual(migrate({baseUrl:"http://x",mainModel:"m"}),{version:2,endpoint:"http://x",model:"m"}); assert.deepEqual(migrate({version:2,endpoint:"x",model:"m"}),{version:2,endpoint:"x",model:"m"});`,
  ),
  "task-07-path-security": base(
    `export function inside(root, candidate) { return candidate.startsWith(root); }\n`,
    `import assert from "node:assert/strict"; import { inside } from "./src/index.mjs"; assert.equal(inside("/app","/app/file"),true); assert.equal(inside("/app","/app2/file"),false); assert.equal(inside("/app","/app/../secret"),false);`,
  ),
  "task-08-stream-decoding": base(
    `export function frames(chunks) { return chunks.flatMap((chunk)=>chunk.split("\\n\\n")).filter(Boolean); }\n`,
    `import assert from "node:assert/strict"; import { frames } from "./src/index.mjs"; assert.deepEqual(frames(["data: {\\"x\\":1}\\n","\\ndata: {\\"x\\":2}\\n\\n"]),["data: {\\"x\\":1}","data: {\\"x\\":2}"]);`,
  ),
  "task-09-timeout-cleanup": base(
    `export function withTimeout(work, ms) { return Promise.resolve(work()); }\n`,
    `import assert from "node:assert/strict"; import { withTimeout } from "./src/index.mjs"; await assert.rejects(withTimeout(()=>new Promise(r=>setTimeout(r,30)),5),/timeout/); const v=await withTimeout(()=>Promise.resolve(3),30); assert.equal(v,3);`,
  ),
  "task-10-json-roundtrip": base(
    `export function encode(value) { return JSON.stringify(value, (_,v)=>v || undefined); } export function decode(text){return JSON.parse(text);}\n`,
    `import assert from "node:assert/strict"; import { encode, decode } from "./src/index.mjs"; const x={enabled:false,count:0,name:""}; assert.deepEqual(decode(encode(x)),x);`,
  ),
  "task-11-cli-help": base(
    `export function help(options) { return ["Usage: app", ...(options ?? []).sort().map((x)=>` + "`  --${x}`" + `)].join("\\n"); }\n`,
    `import assert from "node:assert/strict"; import { help } from "./src/index.mjs"; assert.match(help(["verbose","config"]),/--verbose[\\s\\S]*--config/);`,
  ),
  "task-12-error-cause": base(
    `export function wrap(error) { return new Error("operation failed"); }\n`,
    `import assert from "node:assert/strict"; import { wrap } from "./src/index.mjs"; const cause=new Error("root"); assert.equal(wrap(cause).cause,cause);`,
  ),
  "task-13-sql-filter": base(
    `export function matches(row, filter) { return Object.entries(filter).every(([k,v])=>row[k] === v || !(k in row)); }\n`,
    `import assert from "node:assert/strict"; import { matches } from "./src/index.mjs"; assert.equal(matches({a:null},{}),true); assert.equal(matches({a:null},{a:null}),true); assert.equal(matches({}, {a:null}),false);`,
  ),
  "task-14-event-replay": base(
    `export function replay(state, events) { for (const event of events) state.count += event.delta; return state; }\n`,
    `import assert from "node:assert/strict"; import { replay } from "./src/index.mjs"; assert.deepEqual(replay({count:0},[{id:1,delta:2},{id:1,delta:2}]),{count:2});`,
  ),
  "task-15-config-precedence": base(
    `export function resolve(project, user, env) { return {...user,...project,...env}; }\n`,
    `import assert from "node:assert/strict"; import { resolve } from "./src/index.mjs"; assert.deepEqual(resolve({x:1},{x:2,y:2},{x:undefined}),{x:1,y:2});`,
  ),
  "task-16-tool-arguments": base(
    `export function parseArgs(text) { return JSON.parse(text).text; }\n`,
    `import assert from "node:assert/strict"; import { parseArgs } from "./src/index.mjs"; const raw=JSON.stringify({text:'quote " and unicode ✓'}); assert.deepEqual(parseArgs(raw),{text:'quote " and unicode ✓'});`,
  ),
  "task-17-pagination": base(
    `export async function allPages(fetchPage, size=2) { const out=[]; for(let page=0;;page++){ const rows=await fetchPage(page,size); out.push(...rows); if(rows.length<=size) break; } return out; }\n`,
    `import assert from "node:assert/strict"; import { allPages } from "./src/index.mjs"; let calls=0; const rows=await allPages(async(p)=>{calls++; return p===0?[1,2]:p===1?[3]:[];}); assert.deepEqual(rows,[1,2,3]); assert.equal(calls,2);`,
  ),
  "task-18-log-rotation": base(
    `export function rotate(lines, max) { return lines.slice(-max); }\n`,
    `import assert from "node:assert/strict"; import { rotate } from "./src/index.mjs"; assert.deepEqual(rotate(["a","b","c"],2),["b","c"]); assert.deepEqual(rotate(["a","b"],0),[]);`,
  ),
  "task-19-file-atomicity": base(
    `export function nextName(path) { return path + ".tmp"; }\n`,
    `import assert from "node:assert/strict"; import { nextName } from "./src/index.mjs"; assert.equal(nextName("a.txt"),"a.txt.tmp.1"); assert.equal(nextName("a.txt.tmp"),"a.txt.tmp.1");`,
  ),
  "task-20-metrics": base(
    `export function sumTimings(items) { return items.reduce((a,x)=>a+x.totalMs,0); }\n`,
    `import assert from "node:assert/strict"; import { sumTimings } from "./src/index.mjs"; assert.equal(sumTimings([{totalMs:5},{promptMs:2}]),5);`,
  ),
  "task-21-auth-header": base(
    `export function headers(apiKey, extra={}) { return {...extra,authorization:` + "`Bearer ${apiKey || 'default'}`" + `}; }\n`,
    `import assert from "node:assert/strict"; import { headers } from "./src/index.mjs"; assert.equal(headers("secret",{authorization:"Bearer custom"}).authorization,"Bearer custom");`,
  ),
  "task-22-template-controls": base(
    `export function request(options={}) { return {model:options.model, ...(options.thinking !== undefined ? {chat_template_kwargs:{enable_thinking:true}} : {})}; }\n`,
    `import assert from "node:assert/strict"; import { request } from "./src/index.mjs"; assert.deepEqual(request({model:"m",thinking:false}),{model:"m",chat_template_kwargs:{enable_thinking:false}}); assert.deepEqual(request({model:"m",thinking:true}),{model:"m",chat_template_kwargs:{enable_thinking:true}});`,
  ),
  "task-23-batch-limits": base(
    `export function validate({context,batch,ubatch}) { if(batch>context) throw new Error("batch"); return true; }\n`,
    `import assert from "node:assert/strict"; import { validate } from "./src/index.mjs"; assert.throws(()=>validate({context:100,batch:101,ubatch:20}),/batch/); assert.throws(()=>validate({context:100,batch:50,ubatch:60}),/ubatch/); assert.equal(validate({context:100,batch:50,ubatch:20}),true);`,
  ),
  "task-24-model-switch": base(
    `export function cacheKey(model, prompt) { return prompt; }\n`,
    `import assert from "node:assert/strict"; import { cacheKey } from "./src/index.mjs"; assert.notEqual(cacheKey("a","x"),cacheKey("b","x"));`,
  ),
  "task-25-tool-permissions": base(
    `export function allowed(name, denied=[]) { return !denied.includes(name); }\n`,
    `import assert from "node:assert/strict"; import { allowed } from "./src/index.mjs"; assert.equal(allowed("write",["write"]),false); assert.equal(allowed("WRITE",["write"]),false); assert.equal(allowed("writeFile",["write"]),false);`,
  ),
  "task-26-repair-loop": base(
    `export function shouldRepair(checks) { return checks.some((x)=>x.ok); }\n`,
    `import assert from "node:assert/strict"; import { shouldRepair } from "./src/index.mjs"; assert.equal(shouldRepair([{ok:true},{ok:true}]),false); assert.equal(shouldRepair([{ok:false}]),true);`,
  ),
  "task-27-desktop-ipc": base(
    `export function parseFrame(text) { return JSON.parse(text); }\n`,
    `import assert from "node:assert/strict"; import { parseFrame } from "./src/index.mjs"; assert.deepEqual(parseFrame('{"ok":true}'),{ok:true}); assert.deepEqual(parseFrame('garbage'),{error:"invalid frame"});`,
  ),
  "task-28-package-paths": base(
    `export function joinRoot(root, child) { return root + "/" + child; }\n`,
    `import assert from "node:assert/strict"; import { joinRoot } from "./src/index.mjs"; assert.equal(joinRoot("C:/out","file.zip"),"C:/out/file.zip"); assert.equal(joinRoot("C:/out/","file.zip"),"C:/out/file.zip");`,
  ),
  "task-29-doc-contract": base(
    `export function describe(runtime) { return runtime.managed ? "verified" : "verified"; }\n`,
    `import assert from "node:assert/strict"; import { describe } from "./src/index.mjs"; assert.equal(describe({managed:false}),"sent-only"); assert.equal(describe({managed:true}),"verified");`,
  ),
  "task-30-cleanroom": base(
    `export function cleanName(value) { return value.trim().toLowerCase(); }\n`,
    `import assert from "node:assert/strict"; import { cleanName } from "./src/index.mjs"; assert.equal(cleanName("  Hello World  "),"hello-world"); assert.equal(cleanName("A/B"),"a-b");`,
  ),
  "task-31-python-order-service": project(
    { private: true, scripts: { test: "python verify.py" } },
    {
      "src/__init__.py": "",
      "src/catalog.py": "PRODUCTS = {'book': 1200, 'pen': 300}\n\ndef price_for(sku):\n    return PRODUCTS.get(sku, 0)\n",
      "src/discounts.py": "def apply_discount(cents, code):\n    if code == 'SAVE10':\n        return cents - 10\n    return cents\n",
      "src/order.py": "from .catalog import price_for\nfrom .discounts import apply_discount\n\ndef total_for_order(items, coupon=None):\n    subtotal = sum(price_for(item['sku']) * item['qty'] for item in items)\n    return apply_discount(subtotal, coupon)\n",
      "src/cli.py": "import json\nimport sys\nfrom .order import total_for_order\n\ndef main():\n    payload = json.loads(sys.stdin.read())\n    total = total_for_order(payload['items'], payload.get('coupon_code'))\n    print(json.dumps({'totalCents': total}))\n\nif __name__ == '__main__':\n    main()\n",
      "verify.py": "import json\nimport subprocess\nimport sys\nfrom src.order import total_for_order\n\nitems = [{'sku': 'book', 'qty': 2}, {'sku': 'pen', 'qty': 1}]\nassert total_for_order(items, 'SAVE10') == 2430\ntry:\n    total_for_order([{'sku': 'missing', 'qty': 1}], None)\nexcept ValueError:\n    pass\nelse:\n    raise AssertionError('unknown SKU must be rejected')\nproc = subprocess.run([sys.executable, '-m', 'src.cli'], input=json.dumps({'items': items, 'coupon_code': 'SAVE10'}), text=True, capture_output=True, check=True)\nassert json.loads(proc.stdout) == {'totalCents': 2430}\n",
    },
  ),
  "task-32-typescript-workflow": project(
    { type: "module", private: true, scripts: { test: "node --experimental-strip-types verify.ts" } },
    {
      "src/queue.ts": "export type Job = { id: string; payload: string; attempts?: number };\n\nexport class Queue {\n  private pending: Job[] = [];\n  enqueue(job: Job) { this.pending.unshift(job); }\n  next(): Job | undefined { return this.pending.shift(); }\n}\n",
      "src/worker.ts": "import { Queue, type Job } from './queue.ts';\n\nexport async function drain(queue: Queue, handler: (job: Job) => Promise<void>, maxAttempts = 2) {\n  const completed: string[] = [];\n  let job: Job | undefined;\n  while ((job = queue.next())) {\n    try { await handler(job); completed.push(job.id); }\n    catch (error) {\n      const attempts = (job.attempts ?? 0) + 1;\n      if (attempts >= maxAttempts) throw new Error(`job ${job.id} failed after ${attempts} attempts`, { cause: error });\n      queue.enqueue({ ...job, attempts });\n    }\n  }\n  return completed;\n}\n",
      "src/index.ts": "import { Queue, type Job } from './queue.ts';\nimport { drain } from './worker.ts';\n\nexport async function runWorkflow(jobs: Job[], handler: (job: Job) => Promise<void>, maxAttempts = 2) {\n  const queue = new Queue();\n  for (const job of jobs) queue.enqueue(job);\n  return { completed: await drain(queue, handler, maxAttempts) };\n}\n",
      "verify.ts": "import assert from 'node:assert/strict';\nimport { runWorkflow } from './src/index.ts';\n\nconst attempts = new Map<string, number>();\nconst result = await runWorkflow([{ id: 'a', payload: 'A' }, { id: 'b', payload: 'B' }, { id: 'c', payload: 'C' }], async (job) => {\n  const count = (attempts.get(job.id) ?? 0) + 1; attempts.set(job.id, count);\n  if (job.id === 'b' && count === 1) throw new Error('transient');\n});\nassert.deepEqual(result.completed, ['a', 'c', 'b']);\nassert.equal(attempts.get('b'), 2);\nawait assert.rejects(() => runWorkflow([{ id: 'x', payload: 'X' }], async () => { throw new Error('permanent'); }, 1), /job x/);\n",
    },
  ),
};

export async function materializeFixture(id, root) {
  const fixture = FIXTURES[id];
  if (!fixture) throw new Error(`unknown fixture: ${id}`);
  for (const [relative, content] of Object.entries(fixture.files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
