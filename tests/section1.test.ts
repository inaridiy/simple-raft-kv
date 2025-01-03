import { describe, expect, it } from "vitest";
import { createMemoryStorage, initializeRaftKv } from "../src/index.js";
import { createMockTimers } from "./utils.js";

describe("1. ノードの初期状態に関するテスト", () => {
  it("1-1: フォロワーとして初期化されるべき", async () => {
    const node = initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage: createMemoryStorage(),
      timers: createMockTimers(),
    });

    const state = await node.getNodeState();
    expect(state.role).toBe("follower");
    expect(state.commitIndex).toBe(0);
    expect(state.term).toBe(0);
    expect(state.votedFor).toBe(null);
  });

  it("1-2: `storage` にデータがあった場合の初期化", async () => {
    const storage = createMemoryStorage({
      persistentState: { term: 1, votedFor: "node1" },
      logEntries: [
        { index: 1, term: 1, command: { op: "noop" } },
        {
          index: 2,
          term: 1,
          command: { op: "set", key: "key1", value: "value1" },
        },
      ],
      lastApplied: 2,
      kvStore: new Map([["key1", "value1"]]),
    });

    const node = initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage,
      timers: createMockTimers(),
    });

    const state = await node.getNodeState();
    expect(state.role).toBe("follower");
    expect(state.term).toBe(1);
    expect(state.votedFor).toBe("node1");
  });
});
