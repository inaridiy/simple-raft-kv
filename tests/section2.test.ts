import { setTimeout } from "node:timers/promises";
import { set } from "valibot";
import { describe, expect, it } from "vitest";
import { createMemoryStorage, initializeRaftKv } from "../src/index.js";
import { createMockTimers, createThreeNodes } from "./utils.js";

describe("2. 選挙に関するテスト", () => {
  it("2-1: 単一ノードの場合、自動でリーダに昇格", async () => {
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

  it("2-2: タイムアウトによりフォロワーが候補者に昇格", async () => {
    const [node1] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(0);
    const state = await node1.node.getNodeState();

    expect(state.role).toBe("candidate");
    expect(state.term).toBe(1);
    expect(state.votedFor).toBe("node1");
  });

  it("2-3: 過半数の投票を得た候補者がリーダに昇格", async () => {
    const [node1] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    const state = await node1.node.getNodeState();
    expect(state.role).toBe("leader");
    expect(state.term).toBe(1);
    expect(state.votedFor).toBe("node1");
  });

  it("2-4: ほかのノードがより高い term で選挙した場合、フォロワーに降格", async () => {
    const [node1, node2] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(0);
    const state = await node1.node.getNodeState();

    expect(state.role).toBe("candidate");

    // node2 が node1 よりも高い term で選挙
    await node2.storage.saveState({ term: 2, votedFor: null });
    node2.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    const state1 = await node1.node.getNodeState();
    expect(state1.role).toBe("follower");
  });

  it("2-5: 同時に複数の候補者が出た場合、片方がリーダーに収束する", async () => {
    const [node1, node2, node3] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    node2.timers.triggerElectionTimeout();
    node3.timers.triggerElectionTimeout();
    await setTimeout(0); //十分な時間待機

    const state1 = await node1.node.getNodeState();
    const state2 = await node2.node.getNodeState();
    const state3 = await node3.node.getNodeState();
    expect(state1.role).toBe("leader"); //まだリーダーだと思っている
    expect(state2.role).toBe("candidate"); //候補者になっている
    expect(state3.role).toBe("candidate"); //候補者になっている

    await setTimeout(600); //十分な時間待機

    const state1_2 = await node1.node.getNodeState();
    const state2_2 = await node2.node.getNodeState();
    const state3_2 = await node3.node.getNodeState();
    //どちらかのみリーダーになる
    expect(
      [state1_2.role, state2_2.role, state3_2.role].filter(
        (r) => r === "leader",
      ).length,
    ).toBe(1);
  });

  it("2-6-1: 投票拒否の条件1(ログが古い)", async () => {
    const [node1, node2, node3] = createThreeNodes(["node1", "node2", "node3"]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    // node1のログを進める (term=1, index=1)
    await node1.storage.saveState({ term: 1, votedFor: null });
    await node1.storage.appendLogEntries(1, [
      { term: 1, command: { op: "set", key: "x", value: "1" } },
    ]);

    // node2のログを消去
    await node2.storage.clearLogEntries();

    // node2が選挙を開始
    node2.timers.triggerElectionTimeout();
    await setTimeout(150); //十分な時間待機

    // node1はnode2のログが古いため投票を拒否
    const state1 = await node1.node.getNodeState();
    expect(state1.votedFor).toBe(null); // node2への投票は行われない

    node3.timers.triggerElectionTimeout();
    await setTimeout(150); //十分な時間待機
    const state3 = await node3.node.getNodeState();
    expect(state3.role).toBe("leader"); // node3がリーダーになる
  });

  it("2-6-2: 投票拒否の条件2(同じログ長でログが古い)", async () => {
    //TODO:
  });
});
