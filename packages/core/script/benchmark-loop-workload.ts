import { OpenAIChat } from "@opencode/ai/protocols"
import { ToolDefinition } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect } from "effect"
import { Location } from "../src/location"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { SessionModelRequest } from "../src/session/model-request"
import { SessionModelTransport } from "../src/session/model-transport"
import { SessionRunnerModel } from "../src/session/runner/model"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import { PluginTestLayer } from "../test/plugin/fixture"
import { PluginHooks } from "../src/plugin/hooks"

// Offline CPU benchmarks of production request preparation; no model calls or user configuration.
const session = Session.Info.make({
  id: Session.ID.make("ses_benchmark"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "benchmark", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("benchmark must not call a provider") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const results: Array<{ workload: string; median_ms: number }> = []
const measure = (workload: string, run: () => void) => {
  for (let i = 0; i < 10; i++) run()
  const samples = Array.from({ length: 9 }, () => {
    const start = performance.now()
    for (let i = 0; i < 10; i++) run()
    return (performance.now() - start) / 10
  }).sort((a, b) => a - b)
  results.push({ workload, median_ms: Number(samples[4].toFixed(3)) })
}

await Effect.gen(function* () {
  const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
  const hooks = yield* PluginHooks.Service
  for (const count of [20, 200]) {
    const tools = {
      definitions: Array.from(
        { length: count },
        (_, index) =>
          new ToolDefinition({
            name: `tool_${index}`,
            description: "A tool in a direct MCP catalog",
            inputSchema: {
              type: "object",
              properties: Object.fromEntries(
                Array.from({ length: 32 }, (_, field) => [
                  `field_${field}`,
                  { type: "string", description: "An input field with documentation ".repeat(4) },
                ]),
              ),
            },
          }),
      ),
      execute: () => Effect.die("benchmark must not run tools"),
    }
    // Materialize the service once; measure only each request, not layer boot.
    const request = requests.primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [], tools })
    for (const hooked of [false, true]) {
      const registration = hooked
        ? yield* hooks.register("session", "context", (event) =>
            Effect.sync(() => {
              Object.keys(event.tools)
            }),
          )
        : undefined
      measure(`prepare ${count} tools, ${hooked ? "catalog" : "no"} hook`, () => {
        Effect.runSync(request)
      })
      if (registration) yield* registration.dispose
    }
  }
}).pipe(
  Effect.provideService(SessionModelTransport.Service, transport),
  Effect.provide(PluginTestLayer),
  Effect.scoped,
  Effect.runPromise,
)

for (const count of [1_000, 10_000]) {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_benchmark"),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: model.ref,
    content: Array.from({ length: count }, () =>
      SessionMessage.AssistantReasoning.make({ type: "reasoning", text: "Interrupted thought" }),
    ),
    error: { type: "aborted", message: "Step interrupted" },
    time: { created: DateTime.makeUnsafe(0) },
  })
  measure(`replay ${count} interrupted reasoning blocks`, () => {
    toLLMMessages([message], model.ref)
  })
}

console.table(results)
