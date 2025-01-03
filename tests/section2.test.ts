import { setTimeout } from "node:timers/promises";
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

  it("2-5: 投票拒否の条件(ログが古い, すでに投票済み)", async () => {
    const [node1, node2] = createThreeNodes(["node1", "node2", "node3"]);

    // node1のログを進める (term=1, index=1)
    await node1.storage.saveState({ term: 1, votedFor: null });
    await node1.storage.appendLogEntries(0, [
      { term: 1, command: { op: "set", key: "x", value: "1" } },
    ]);

    // node2のログは古い (term=1, index=0)
    await node2.storage.saveState({ term: 1, votedFor: null });

    // node2が選挙を開始
    node2.timers.triggerElectionTimeout();
    await setTimeout(0);

    // node1はnode2のログが古いため投票を拒否
    const state1 = await node1.node.getNodeState();
    expect(state1.votedFor).toBe(null); // node2への投票は行われない

    // 同じtermで既に投票済みの場合のテスト
    await node1.storage.saveState({ term: 1, votedFor: "node3" });

    // node2が同じtermで再度選挙を試みる
    node2.timers.triggerElectionTimeout();
    await setTimeout(0);

    // node1は既にnode3に投票済みのため、node2への投票を拒否
    const state2 = await node1.node.getNodeState();
    expect(state2.votedFor).toBe("node3"); // 投票先は変わらない
  });

  it("2-6: タイムアウト時の再選挙", async () => {
    const [node1, node2, node3] = createThreeNodes(["node1", "node2", "node3"]);

    // node3をダウンさせる想定 (応答しない)
    node3.timers.triggerElectionTimeout();
    await setTimeout(0);

    // node1が選挙を開始
    node1.timers.triggerElectionTimeout();
    await setTimeout(0);

    // 最初の選挙でnode1はcandidateになりterm=1
    const state1 = await node1.node.getNodeState();
    expect(state1.role).toBe("candidate");
    expect(state1.term).toBe(1);

    // 選挙タイムアウト発生 (過半数が得られない)
    await node1.timers
      .electionDuration()
      .then(() => ({ type: "timeout" as const }));

    // node1は再度選挙を開始し、termが増加
    const state2 = await node1.node.getNodeState();
    expect(state2.term).toBe(2);
    expect(state2.role).toBe("candidate");
  });
});
