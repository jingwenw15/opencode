import path from "path"
import { tmpdir } from "../test/fixture/tmpdir"

// Isolate storage before importing Core, just as script/test.ts does for unit tests.
await using directory = await tmpdir("opencode-loop-bench-")
const child = Bun.spawn({
  cmd: [
    process.execPath,
    path.join(
      import.meta.dir,
      ["io", "search"].includes(process.argv[2]) ? "benchmark-io-workload.ts" : "benchmark-loop-workload.ts",
    ),
    process.argv[2] ?? "loop",
  ],
  env: {
    ...process.env,
    OPENCODE_TEST_HOME: directory.path,
    OPENCODE_CONFIG_DIR: path.join(directory.path, "config"),
    XDG_CONFIG_HOME: path.join(directory.path, "config"),
    XDG_DATA_HOME: path.join(directory.path, "data"),
    XDG_STATE_HOME: path.join(directory.path, "state"),
    XDG_CACHE_HOME: path.join(directory.path, "cache"),
  },
  stdout: "inherit",
  stderr: "inherit",
})
process.exitCode = await child.exited
