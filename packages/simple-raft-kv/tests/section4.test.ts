import { setTimeout } from "node:timers/promises";
import { set } from "valibot";
import { describe, expect, it } from "vitest";
import { createNNodes } from "./utils.js";

describe("4. ログの追随(レプリケーション)に関するテスト", () => {
  it("4-1: クライアントコマンドをリーダーに投げてレプリケーション", async () => {
    const nodes = createNNodes(["node1", "node2", "node3", "node4", "node5"]);
    const [node1, node2, node3, node4, node5] = nodes;

    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機
    expect(await node1.node.getNodeState()).toMatchObject({ role: "leader" });

    const committing = node1.node.handleClientRequest([
      { op: "set", key: "key1", value: "value1" },
      { op: "set", key: "key2", value: "value2" },
    ]);
    await setTimeout(1); //コミットまではされない時間
    const state1 = await node1.node.getNodeState();
    expect(node1.storage.internal.logEntries).toHaveLength(3);
    expect(state1.commitIndex).toBe(1);

    await committing;
    const state1_1 = await node1.node.getNodeState();
    expect(state1_1.commitIndex).toBe(3);
    expect(node1.storage.internal.kvStore.get("key1")).toBe("value1");
    expect(node1.storage.internal.kvStore.get("key2")).toBe("value2");

    // 過半数のフォロワーにログは伝播したが、まだコミットされていない
    expect(
      [node2, node3, node4, node5]
        .map((node) => node.storage.internal.logEntries)
        .filter((entries) => entries.length === 3).length,
    ).gte(2);
    expect(
      [node2, node3, node4, node5]
        .map((node) => node.storage.internal.kvStore.get("key1"))
        .filter((value) => value === undefined),
    ).toHaveLength(4);

    node1.timers.triggerHeartbeat();
    await setTimeout(100); //十分な時間待機

    // HeartbeatのleaderCommitでコミットされる
    const state2 = await node2.node.getNodeState();
    expect(state2.commitIndex).toBe(3);
    expect(node2.storage.internal.kvStore.get("key1")).toBe("value1");
    expect(node2.storage.internal.kvStore.get("key2")).toBe("value2");

    const state3 = await node3.node.getNodeState();
    expect(state3.commitIndex).toBe(3);
    expect(node3.storage.internal.kvStore.get("key1")).toBe("value1");
    expect(node3.storage.internal.kvStore.get("key2")).toBe("value2");
  });

  it("4-2: ログ不一致の修正", async () => {
    const nodes = createNNodes(["node1", "node2", "node3", "node4", "node5"]);
    const [node1, node2, node3, node4, node5] = nodes;

    // 一旦雑にオペレーションをばら撒く
    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機
    expect(await node1.node.getNodeState()).toMatchObject({ role: "leader" });

    await node1.node.handleClientRequest([
      { op: "set", key: "key1", value: "value1" },
      { op: "set", key: "key2", value: "value2" },
    ]);

    await setTimeout(100); //十分な時間待機

    // termも進める
    node2.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    const state2 = await node2.node.getNodeState();
    expect(state2).toMatchObject({ role: "leader", term: 2 });

    // node3 のログを削除する
    await node3.storage.clearLogEntries();
    expect(node3.storage.internal.logEntries).toHaveLength(0);

    // node2がHeartbeatで不整合を検知し、node3にログを再送
    node2.timers.triggerHeartbeat();
    await setTimeout(200); //十分な時間待機

    // node3にログが再送される
    // leader1:noop, set1, set2, leader2:noop => total 4
    expect(node3.storage.internal.logEntries).toHaveLength(4);
  });
});
