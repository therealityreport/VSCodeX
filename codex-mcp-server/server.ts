import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod/v4";
import { spawn } from "node:child_process";

// ---------- Types shared with ChatGPT (via structuredContent) ----------

type TestsStatus = "all_passed" | "some_failed" | "not_run";

interface CodexCommandSummary {
  command: string;
  exit_code: number | null;
}

interface CodexReport {
  taskId: string;
  summary: string;
  filesChanged: string[];
  commands: CodexCommandSummary[];
  testsStatus: TestsStatus;
  rawEventsCount: number;
}

// ---------- Codex runner ----------

async function runCodexExec(taskId: string, codexPrompt: string): Promise<CodexReport> {
  const workspace = process.env.CODEX_WORKSPACE || process.cwd();

  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--full-auto",
      "--json",
      `${codexPrompt}\n\n(You are executing task ${taskId}.)`,
    ];

    const proc = spawn("codex", args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"], // stdout = JSONL, stderr = live logs
    });

    const events: any[] = [];
    let buffer = "";
    let exitCode: number | null = null;

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          events.push(evt);
        } catch {
          // ignore non-JSON noise
        }
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      exitCode = typeof code === "number" ? code : null;
      const report = summarizeCodexEvents(events, taskId, exitCode);
      resolve(report);
    });
  });
}

function summarizeCodexEvents(
  events: any[],
  taskId: string,
  exitCode: number | null
): CodexReport {
  const filesChanged = new Set<string>();
  const commands: CodexCommandSummary[] = [];
  let finalAgentMessage: string | null = null;

  for (const evt of events) {
    // Final agent message
    if (
      evt?.type === "item.completed" &&
      evt.item?.type === "agent_message" &&
      typeof evt.item.text === "string"
    ) {
      finalAgentMessage = evt.item.text;
    }

    // Command executions
    if (evt?.item?.type === "command_execution") {
      const cmd = String(evt.item.command ?? "");
      const cmdExit =
        typeof evt.item.exit_code === "number" ? evt.item.exit_code : null;
      commands.push({ command: cmd, exit_code: cmdExit });
    }

    // File changes
    if (evt?.item?.type === "file_change") {
      const p = evt.item.path ?? evt.item.file ?? evt.item.filename ?? null;
      if (typeof p === "string") filesChanged.add(p);
    }
  }

  // Infer tests status from commands
  let testsStatus: TestsStatus = "not_run";
  if (commands.length) {
    const testCommands = commands.filter((c) => /test/i.test(c.command));
    if (testCommands.length) {
      const anyFailed = testCommands.some(
        (c) => c.exit_code !== null && c.exit_code !== 0
      );
      const anyUnknown = testCommands.some((c) => c.exit_code === null);
      if (anyFailed) testsStatus = "some_failed";
      else if (!anyUnknown) testsStatus = "all_passed";
    }
  }

  let summary =
    finalAgentMessage ??
    "Codex run completed but no final agent summary message was found.";
  if (exitCode !== null && exitCode !== 0) {
    summary += ` (codex exited with code ${exitCode})`;
  }

  return {
    taskId,
    summary,
    filesChanged: Array.from(filesChanged),
    commands,
    testsStatus,
    rawEventsCount: events.length,
  };
}

// ---------- MCP server + HTTP transport ----------

const server = new McpServer({
  name: "codex-runner",
  version: "1.0.0",
});

// Tool: run_codex_task
server.registerTool(
  "run_codex_task",
  {
    title: "Run a Codex task in the local repo",
    description:
      "Executes a single implementation task via Codex CLI in the configured CODEX_WORKSPACE repository.",
    inputSchema: {
      taskId: z
        .string()
        .describe("Task identifier from your plan (e.g. 'task-3')."),
      codexPrompt: z
        .string()
        .describe(
          "Full natural-language instructions for Codex, including acceptance criteria and which tests/commands to run."
        ),
    },
    outputSchema: {
      taskId: z.string(),
      outcome: z.enum(["success", "failed", "unknown"]),
      summary: z.string(),
      filesChanged: z.array(z.string()),
      testsStatus: z.enum(["all_passed", "some_failed", "not_run"]),
      commands: z.array(
        z.object({
          command: z.string(),
          exit_code: z.number().nullable(),
        })
      ),
    },
  },
  async ({ taskId, codexPrompt }) => {
    const report = await runCodexExec(taskId, codexPrompt);

    const outcome: "success" | "failed" | "unknown" =
      report.testsStatus === "some_failed"
        ? "failed"
        : report.testsStatus === "all_passed"
        ? "success"
        : "unknown";

    const structured = {
      taskId: report.taskId,
      outcome,
      summary: report.summary,
      filesChanged: report.filesChanged,
      testsStatus: report.testsStatus,
      commands: report.commands,
    };

    return {
      structuredContent: structured,
      content: [
        {
          type: "text",
          text:
            `Codex completed task ${report.taskId} with outcome ${outcome}.\n` +
            `Summary: ${report.summary}\n` +
            `Files changed: ${report.filesChanged.join(", ") || "(none)"}\n` +
            `Tests status: ${report.testsStatus}`,
        },
      ],
    };
  }
);

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT || "3000", 10);
app
  .listen(port, () => {
    const url = `http://localhost:${port}/mcp`;
    console.log(`Codex MCP Server running on ${url}`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
