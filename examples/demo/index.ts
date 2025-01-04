import { promises as fs } from "node:fs";
import * as nodeUtils from "node:util";
import {
  type DirectRpc,
  type MemoryStorage,
  type RaftKvNode,
  createDirectRpc,
  createMemoryStorage,
  createTimers,
  initializeRaftKv,
} from "@simple-raft-kv/core";
import * as v from "valibot";

const configSchema = v.object({
  electionTimeout: v.tuple([v.number(), v.number()]),
  heartbeatInterval: v.number(),
  appendEntiresTimeout: v.number(),
  nodes: v.array(v.object({ id: v.string(), url: v.string() })),
});

const { values } = nodeUtils.parseArgs({
  options: {
    config: { type: "string" },
  },
});
const { config: configPath } = values;
if (!configPath) throw new Error("config is required");
const configJson = await fs.readFile(configPath, "utf-8");
const config = v.parse(configSchema, JSON.parse(configJson));

type Node = {
  nodeId: string;
  runtime: RaftKvNode;
  storage: MemoryStorage;
};

const rpcs = new Map<string, DirectRpc>();
const nodes = new Map<string, Node>();

for (const node of config.nodes) rpcs.set(node.id, createDirectRpc([5, 20]));

for (const node of config.nodes) {
  const storage = createMemoryStorage();
  const rpc = rpcs.get(node.id);
  if (!rpc) throw new Error(`rpc not found for node ${node.id}`);

  const peers = config.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => {
      const rpc = rpcs.get(n.id);
      if (!rpc) throw new Error(`rpc not found for node ${n.id}`);
      return { id: n.id, rpc: rpc.rpc };
    });

  const runtime = await initializeRaftKv({
    nodeId: node.id,
    storage,
    nodes: peers,
    timers: createTimers(
      config.electionTimeout,
      config.heartbeatInterval,
      config.appendEntiresTimeout,
    ),
  });
  nodes.set(node.id, { nodeId: node.id, runtime, storage });
  rpc.setNode(runtime);
}

const topPageTemplate = async (nodes: Map<string, Node>) => {
  const fullStates = await Promise.all(
    Array.from(nodes.entries()).map(async ([nodeId, node]) => ({
      nodeId,
      node,
      state: await node.runtime.getNodeState(),
      leaderState: await node.runtime.getLeaderState(),
    })),
  );

  let markdown = "# Raft KV Cluster Status\n\n";

  // Summary table
  markdown += "## Node Summary\n\n";
  markdown +=
    "| Node ID | Role | Term | Voted For | LogEntry Length | Commit Index  |\n";
  markdown +=
    "|---------|------|------|-----------|-----------------|---------------|\n";
  for (const { nodeId, state, node } of fullStates) {
    markdown += `| ${nodeId} | ${state.role} | ${state.term} | ${state.votedFor || "-"} | ${
      node.storage.internal.logEntries.length
    } |${state.commitIndex} |\n`;
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
    markdown += JSON.stringify(node.storage.internal.kvStore, null, 2);
    markdown += "\n```\n\n";
  }

  return markdown;
};

setInterval(async () => {
  const markdown = await topPageTemplate(nodes);
  await fs.writeFile("status.md", markdown);
}, 100);
