import exp from "node:constants";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createMockRpc, createThreeNodesWithMockRpc } from "./utils.js";

describe("3. ハートビートに関するテスト", () => {
  it("3-1: リーダーが定期的にハートビートを送る", async () => {
    const node2Heartbeat = vi.fn();
    const node3Heartbeat = vi.fn();

    const node1 = createThreeNodesWithMockRpc("node1", [
      ["node2", createMockRpc({ onAppendEntries: node2Heartbeat })],
      ["node3", createMockRpc({ onAppendEntries: node3Heartbeat })],
    ]);

    node1.timers.triggerElectionTimeout();
    await setTimeout(50); //十分な時間待機

    expect(node2Heartbeat).toHaveBeenCalledOnce();
    expect(node3Heartbeat).toHaveBeenCalledOnce();

    //リーダー選出時のno-opエントリ
    expect(node2Heartbeat).toHaveBeenLastCalledWith({
      term: 1,
      leaderId: "node1",
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [{ command: { op: "noop" }, term: 1 }],
      leaderCommit: 0,
    });

    node1.timers.triggerHeartbeat();
    await setTimeout(50); //十分な時間待機
    expect(node2Heartbeat).toHaveBeenCalledTimes(2);
    expect(node3Heartbeat).toHaveBeenCalledTimes(2);

    expect(node2Heartbeat).toHaveBeenLastCalledWith({
      term: 1,
      leaderId: "node1",
      prevLogIndex: 1,
      prevLogTerm: 1,
      entries: [],
      leaderCommit: 1,
    });
  });

  it("3-2: リーダーがハートビートに対してレスポンスの term が高い場合、フォロワーに降格", async () => {
    // TODO:s
  });

  it("3-3: フォロワーはハートビートを受け取ると、electionTimeoutがリセットされる", async () => {
    // TODO:s
  });
});
