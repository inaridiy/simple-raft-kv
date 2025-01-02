import { describe, expect, test, vi } from "vitest";
import { initializeRaftKv } from "./core.js";
import type {
  PersistedLogEntry,
  RaftKvRpc,
  RaftKvStorage,
  RequestVoteReply,
} from "./types.js";

const createMockTimers = () => ({
  heartbeatInterval: vi.fn(),
  electionTimeout: vi.fn().mockReturnValue(vi.fn()),
  electionRetrySleep: vi.fn().mockResolvedValue(undefined),
  electionDuration: vi.fn().mockResolvedValue(undefined),
  appendEntriesTimeout: vi.fn().mockResolvedValue(undefined),
});

describe("Raft Election Tests", () => {
  // Mock storage
  const createMockStorage = (initialTerm = 0): RaftKvStorage => {
    const loadState = vi
      .fn()
      .mockResolvedValue({ term: initialTerm, votedFor: null });
    const saveState = vi.fn().mockResolvedValue(undefined);
    const getLastLogEntry = vi.fn().mockResolvedValue(null);
    const getLogEntryByIndex = vi.fn().mockResolvedValue(null);
    const appendLogEntries = vi.fn().mockResolvedValue(undefined);
    const commitLogEntries = vi.fn().mockResolvedValue(undefined);

    return {
      loadState,
      saveState,
      getLastLogEntry,
      getLogEntryByIndex,
      appendLogEntries,
      commitLogEntries,
    };
  };

  // Mock RPC
  const createMockRpc = (voteResponse: RequestVoteReply): RaftKvRpc => {
    const requestVote = vi.fn().mockResolvedValue(voteResponse);
    const appendEntries = vi.fn().mockResolvedValue({ term: 0, success: true });

    return {
      requestVote,
      appendEntries,
    };
  };

  test("正常な選挙プロセス - 過半数の投票を得てリーダーになる", async () => {
    const storage = createMockStorage();
    const nodes = [
      { id: "node2", rpc: createMockRpc({ term: 1, voteGranted: true }) },
      { id: "node3", rpc: createMockRpc({ term: 1, voteGranted: true }) },
    ];

    const raft = await initializeRaftKv({
      nodeId: "node1",
      nodes,
      storage,
      timers: createMockTimers(),
    });

    // RequestVoteのハンドリングをテスト
    const reply = await raft.handleRequestVote({
      term: 2,
      candidateId: "node2",
      lastLogIndex: 0,
      lastLogTerm: 0,
    });

    expect(reply.voteGranted).toBe(true);
    expect(reply.term).toBe(2);
    expect(storage.saveState).toHaveBeenCalledWith({
      term: 2,
      votedFor: "node2",
    });
  });

  test("他の候補者のtermが大きい場合は投票を拒否", async () => {
    const storage = createMockStorage(3); // 現在のtermを3に設定

    const raft = await initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage,
      timers: createMockTimers(),
    });

    const reply = await raft.handleRequestVote({
      term: 2, // 小さいterm
      candidateId: "node2",
      lastLogIndex: 0,
      lastLogTerm: 0,
    });

    expect(reply.voteGranted).toBe(false);
    expect(reply.term).toBe(3);
  });

  test("既に投票済みの場合は新しい投票を拒否", async () => {
    const storage = createMockStorage();
    const state = { term: 1, votedFor: "node3" };
    storage.loadState = vi.fn().mockResolvedValue(state);

    const raft = await initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage,
      timers: createMockTimers(),
    });

    const reply = await raft.handleRequestVote({
      term: 1,
      candidateId: "node2",
      lastLogIndex: 0,
      lastLogTerm: 0,
    });

    expect(reply.voteGranted).toBe(false);
    expect(reply.term).toBe(1);
  });

  test("候補者のログが古い場合は投票を拒否", async () => {
    const storage = createMockStorage();
    const lastLogEntry: PersistedLogEntry = {
      index: 2,
      term: 2,
      command: { op: "set", key: "test", value: "test" },
    };
    storage.getLastLogEntry = vi.fn().mockResolvedValue(lastLogEntry);

    const raft = await initializeRaftKv({
      nodeId: "node1",
      nodes: [],
      storage,
      timers: createMockTimers(),
    });

    const reply = await raft.handleRequestVote({
      term: 2,
      candidateId: "node2",
      lastLogIndex: 1, // 古いindex
      lastLogTerm: 1, // 古いterm
    });

    expect(reply.voteGranted).toBe(false);
    expect(reply.term).toBe(2);
  });
});
