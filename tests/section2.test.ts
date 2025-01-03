import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createMemoryStorage, initializeRaftKv } from "../src/index.js";
import { createMockTimers, createThreeNodes } from "./utils.js";

describe("2. 選挙に関するテスト", () => {
  it("2-1: タイムアウトによりフォロワーが候補者に昇格", async () => {
    const [node1] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(0);
    const state = await node1.node.getNodeState();

    expect(state.role).toBe("candidate");
    expect(state.term).toBe(1);
    expect(state.votedFor).toBe("node1");
  });

  it("2-2: 単一ノードの場合、自動でリーダに昇格", async () => {
    const timers = createMockTimers();
    const node = await initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage: createMemoryStorage(),
      timers,
    });

    timers.triggerElectionTimeout();
    await setTimeout(0);
    const state = await node.getNodeState();

    expect(state.role).toBe("leader");
    expect(state.term).toBe(1);
    expect(state.votedFor).toBe("node1");
  });
});
