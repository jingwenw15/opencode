import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).not.toContain("${OPENCODE_WORKFLOW_GUIDANCE}")
  expect(prompt.match(/# Working efficiently/g)).toHaveLength(1)
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})
