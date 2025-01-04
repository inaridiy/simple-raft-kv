import { promises as fs } from "node:fs";
import * as nodeUtils from "node:util";
import { serve } from "@hono/node-server";
import { vValidator } from "@hono/valibot-validator";
import {
  type DirectRpc,
  type MemoryStorage,
  type RaftKvNode,
  type SimplestTimers,
  createDirectRpc,
  createMemoryStorage,
  createSimplestTimers,
  initializeRaftKv,
} from "@simple-raft-kv/core";
import { Hono } from "hono";
import * as v from "valibot";

const configSchema = v.object({
  electionTimeout: v.tuple([v.number(), v.number()]),
  heartbeatInterval: v.number(),
  appendEntiresTimeout: v.number(),
  nodes: v.array(v.string()),
});

const { values } = nodeUtils.parseArgs({
  options: {
    port: { type: "string", defaultValue: "3000" },
    config: { type: "string" },
  },
});
const { config: configPath, port } = values;
if (!port) throw new Error("port is required");
if (!configPath) throw new Error("config is required");
const configJson = await fs.readFile(configPath, "utf-8");
const config = v.parse(configSchema, JSON.parse(configJson));

type Node = {
  nodeId: string;
  runtime: RaftKvNode | null;
  storage: MemoryStorage;
  timers: SimplestTimers;
};

const rpcs = new Map<string, DirectRpc>();
const nodes = new Map<string, Node>();
const logs = new Map<string, string[]>();

const initNode = async (nodeId: string) => {
  const rpc = rpcs.get(nodeId);
  if (!rpc) throw new Error(`rpc not found for node ${nodeId}`);

  const peers = config.nodes
    .filter((id) => id !== nodeId)
    .map((id) => {
      const rpc = rpcs.get(id);
      if (!rpc) throw new Error(`rpc not found for node ${id}`);
      return { id, rpc: rpc.rpc };
    });

  const existingNode = nodes.get(nodeId);

  const storage = existingNode?.storage || createMemoryStorage();
  const timers = createSimplestTimers(
    config.electionTimeout,
    config.heartbeatInterval,
    config.appendEntiresTimeout,
  );
  const runtime = await initializeRaftKv({
    nodeId: nodeId,
    storage,
    logger: (msg) => {
      const log = logs.get(nodeId) || [];
      log.push(msg);
      logs.set(nodeId, log);
    },
    nodes: peers,
    timers,
  });
  nodes.set(nodeId, { nodeId, runtime, storage, timers });
  rpc.setNode(runtime);
};

for (const nodeId of config.nodes) rpcs.set(nodeId, createDirectRpc([5, 20]));
for (const nodeId of config.nodes) await initNode(nodeId);

const topPageTemplate = async (nodes: Map<string, Node>) => {
  const fullStates = await Promise.all(
    Array.from(nodes.entries()).map(async ([nodeId, node]) => ({
      nodeId,
      isActive: !!node.runtime,
      node,
      state: await node.runtime?.getNodeState(),
      leaderState: await node.runtime?.getLeaderState(),
    })),
  );

  let markdown = "# Raft KV Cluster Status\n\n";

  // Summary table
  markdown += "## Node Summary\n\n";
  markdown +=
    "| Node ID | Role | Term | Voted For | LogEntry Length | Commit Index | Toggle Power |\n";
  markdown +=
    "|---------|------|------|-----------|-----------------|--------------|--------------|\n";
  for (const { nodeId, state, node } of fullStates) {
    if (state)
      markdown += `| ${nodeId} | ${state.role} | ${state.term} | ${state.votedFor || "-"} | ${
        node.storage.internal.logEntries.length
      } |${state.commitIndex} | [Shutdown](http://localhost:${port}/toggle-power?nodeId=${nodeId}) |\n`;
    else
      markdown += `| ${nodeId} | - | - | - | - | - | [Start](http://localhost:${port}/toggle-power?nodeId=${nodeId}) |\n`;
  }
  markdown += "\n";

  // Detailed state for each node
  markdown += "## Node Details\n\n";
  for (const { nodeId, state, leaderState, node } of fullStates) {
    markdown += `### Node ${nodeId}\n\n`;
    markdown += "#### State\n\n";
    markdown += "```json\n";
    markdown += JSON.stringify(state, null, 2);
    markdown += "\n```\n\n";

    markdown += "#### Actions\n\n";
    markdown += `[Set random Value to KV](http://localhost:${port}/set-random-values?nodeId=${nodeId})\n\n`;

    markdown += "#### Log Entries\n\n";
    markdown += "| Index | Term | Command |\n";
    markdown += "|-------|------|---------|\n";
    for (const entry of node.storage.internal.logEntries) {
      markdown += `| ${entry.index} | ${entry.term} | ${JSON.stringify(entry.command)} |\n`;
    }
    markdown += "\n\n";

    if (leaderState) {
      markdown += "#### Leader State\n\n";
      markdown += "| Node | Next Index | Match Index |\n";
      markdown += "|------|------------|-------------|\n";
      for (const [peerId, nextIdx] of leaderState.nextIndex.entries()) {
        const matchIdx = leaderState.matchIndex.get(peerId) || 0;
        markdown += `| ${peerId} | ${nextIdx} | ${matchIdx} |\n`;
      }
      markdown += "\n";
    }

    markdown += "Kv Store\n\n";
    markdown += "```json\n";
    markdown += JSON.stringify(
      Object.fromEntries(node.storage.internal.kvStore.entries()),
      null,
      2,
    );
    markdown += "\n```\n\n";
  }

  return markdown;
};

await fs.mkdir("console", { recursive: true });

setInterval(async () => {
  const markdown = await topPageTemplate(nodes);
  await fs.writeFile("console/status.md", markdown);
  for (const nodeId of nodes.keys()) {
    const log = logs.get(nodeId) || [];
    await fs.writeFile(`console/${nodeId}.log`, log.join("\n"));
  }
}, 100);

const app = new Hono();

app.get(
  "/set-random-values",
  vValidator(
    "query",
    v.object({
      nodeId: v.string(),
    }),
  ),
  async (c) => {
    const { nodeId } = c.req.valid("query");
    const node = nodes.get(nodeId);
    if (!node?.runtime) return c.text("Node not found or not running", 404);

    const state = await node.runtime.getNodeState();
    if (state.role !== "leader") {
      return c.text("Not a leader", 400);
    }

    const commands = [
      { op: "set" as const, key: "foo", value: Math.random().toString() },
      { op: "set" as const, key: "bar", value: Math.random().toString() },
    ];
    await node.runtime.handleClientRequest(commands);

    return c.text("OK");
  },
);

app.get(
  "/toggle-power",
  vValidator(
    "query",
    v.object({
      nodeId: v.string(),
    }),
  ),
  async (c) => {
    const { nodeId } = c.req.valid("query");
    const rpc = rpcs.get(nodeId);
    const node = nodes.get(nodeId);
    if (!node || !rpc) return c.text("Node not found", 404);

    if (node.runtime) {
      node.timers.kill();
      rpc.setNode(null);
      nodes.set(nodeId, { ...node, runtime: null });
    } else {
      await initNode(nodeId);
    }

    return c.text("OK");
  },
);

serve({ fetch: app.fetch, port: Number.parseInt(port) }, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
