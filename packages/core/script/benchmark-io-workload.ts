import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Config } from "../src/config"
import { Environment } from "../src/environment"
import { FileAccess } from "../src/file-access"
import { FileMutation } from "../src/file-mutation"
import { FileWrite } from "../src/file-write"
import { Flag } from "../src/flag"
import { Formatter } from "../src/formatter"
import { Location } from "../src/location"
import { Permission } from "../src/permission"
import { makeDaemonTransport } from "../src/persistent-pty/daemon"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { Tool } from "../src/tool"
import { EditTool } from "../src/tool/plugin/edit"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { location } from "../test/fixture/location"
import { tmpdir } from "../test/fixture/tmpdir"
import { permissionLayer } from "../test/lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../test/lib/tool"

// Run with benchmark-loop.ts io to isolate storage. Uses actual tools and daemon transport, with no provider calls.
await using directory = await tmpdir("opencode-io-bench-")
const edit = makeLocationNode({
  name: "benchmark/edit",
  layer: Layer.effectDiscard(registerToolPlugin(EditTool.Plugin)),
  deps: [
    Tool.node,
    FileWrite.node,
    FileMutation.node,
    Environment.node,
    Location.node,
    Permission.node,
    Config.node,
    Flag.node,
  ],
})
const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, edit]), [
  Location.node.replace(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory.path) }))),
  ),
  Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  Config.node.replace(Config.testLayer()),
])
const rows: Array<{ workload: string; milliseconds: number; helperStarts?: number; rssMiB?: number }> = []
await Effect.gen(function* () {
  const registry = yield* Tool.Service
  const before = "first\n" + "unchanged\n".repeat(12_000)
  const after = "changed\n" + before.slice("first\n".length)
  yield* Effect.promise(() => fs.writeFile(path.join(directory.path, "large.txt"), before))
  const start = performance.now()
  const result = yield* executeTool(registry, {
    sessionID: Session.ID.make("ses_benchmark"),
    ...toolIdentity,
    call: {
      type: "tool-call",
      id: "edit-benchmark",
      name: "edit",
      input: { path: "large.txt", oldString: before, newString: after },
    },
  })
  const milliseconds = performance.now() - start
  if (
    result.status !== "completed" ||
    (yield* Effect.promise(() => Bun.file(path.join(directory.path, "large.txt")).text())) !== after
  )
    throw new Error("Benchmark edit did not produce the expected file")
  rows.push({
    workload: "edit 12,000-line LF region",
    milliseconds: Math.round(milliseconds),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  })
  yield* Effect.promise(() => fs.writeFile(path.join(directory.path, "whitespace.txt"), "same  \n".repeat(4_000)))
  const searchStart = performance.now()
  const searched = yield* executeTool(registry, {
    sessionID: Session.ID.make("ses_benchmark"),
    ...toolIdentity,
    call: {
      type: "tool-call",
      id: "whitespace-benchmark",
      name: "edit",
      input: { path: "whitespace.txt", oldString: "same\n".repeat(2_000), newString: "changed\n", replaceAll: true },
    },
  })
  const searchMs = performance.now() - searchStart
  if (
    searched.status !== "completed" ||
    (yield* Effect.promise(() => Bun.file(path.join(directory.path, "whitespace.txt")).text())) !== "changed\nchanged\n"
  )
    throw new Error("Whitespace benchmark did not produce the expected file")
  rows.push({ workload: "edit 4,000 repeated whitespace lines", milliseconds: Math.round(searchMs) })
}).pipe(Effect.provide(layer), Effect.provideService(Flag.Overrides, undefined), Effect.scoped, Effect.runPromise)

if (process.platform !== "win32" && process.argv[2] !== "search") {
  // An unavailable helper that registers an unreachable socket reproduces the reported startup timeout.
  const binary = path.join(directory.path, "unavailable-daemon")
  await fs.writeFile(
    binary,
    [
      "#!/bin/sh",
      'mkdir -p "$3/$5"',
      `printf '{"instance_id":"benchmark","pid":%s,"protocol":9,"socket":"%s/missing.sock","token":"t","features":[]}' $$ "$3" > "$3/$5/service.json"`,
      "exec sleep 30",
    ].join("\n"),
    { mode: 0o755 },
  )
  await Effect.gen(function* () {
    let starts = 0
    const transport = yield* makeDaemonTransport(path.join(directory.path, "runtime"), "daemon", () => {
      starts++
      return Promise.resolve(binary)
    })
    for (const call of [1, 2]) {
      const start = performance.now()
      const error = yield* transport.request({ op: "list" }, true).pipe(Effect.flip)
      if (error.kind !== "connect") throw new Error(`Unexpected daemon failure: ${error.kind}`)
      rows.push({
        workload: `unavailable PTY request ${call}`,
        milliseconds: Math.round(performance.now() - start),
        helperStarts: starts,
      })
    }
  }).pipe(Effect.scoped, Effect.runPromise)
}

console.table(rows)
