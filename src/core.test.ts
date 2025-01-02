import { beforeEach, describe, expect, it } from "vitest";
import { initializeRaftKv } from "./core.js";
import { createMemoryStorage } from "./storage.js";
import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  KvCommand,
  LogEntry,
  MemoryState,
  RaftKvRpc,
  RequestVoteArgs,
  RequestVoteReply,
} from "./types.js";

interface MockRpcConfig {
  requestVoteResponse?: RequestVoteReply;
  appendEntriesResponse?:
    | AppendEntriesReply
    | ((args: AppendEntriesArgs) => AppendEntriesReply);
  requestVoteDelay?: number;
  appendEntriesDelay?: number;
  failureRate?: number;
  onAppendEntries?: (args: AppendEntriesArgs) => void;
  onRequestVote?: (args: RequestVoteArgs) => void;
}

const createMockRpc = (config: MockRpcConfig = {}): RaftKvRpc => {
  return {
    requestVote: async (args: RequestVoteArgs): Promise<RequestVoteReply> => {
      if (config.requestVoteDelay) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.requestVoteDelay),
        );
      }
      if (config.failureRate && Math.random() < config.failureRate) {
        throw new Error("Network error");
      }
      config.onRequestVote?.(args);
      return (
        config.requestVoteResponse ?? {
          term: args.term,
          voteGranted: true,
        }
      );
    },
    appendEntries: async (
      args: AppendEntriesArgs,
    ): Promise<AppendEntriesReply> => {
      if (config.appendEntriesDelay) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.appendEntriesDelay),
        );
      }
      if (config.failureRate && Math.random() < config.failureRate) {
        throw new Error("Network error");
      }
      config.onAppendEntries?.(args);
      if (typeof config.appendEntriesResponse === "function") {
        return config.appendEntriesResponse(args);
      }
      return (
        config.appendEntriesResponse ?? {
          term: args.term,
          success: true,
        }
      );
    },
  };
};

const createMockTimers = () => {
  let heartbeatCallback: (() => void) | null = null;
  let electionCallback: (() => void) | null = null;
  let electionTimeoutReset: (() => void) | null = null;

  return {
    heartbeatInterval: (cb: () => void) => {
      heartbeatCallback = cb;
    },
    electionTimeout: (cb: () => void) => {
      electionCallback = cb;
      electionTimeoutReset = () => {
        // Reset election timeout
      };
      return electionTimeoutReset;
    },
    electionRetrySleep: async () => {
      // Immediate return for testing
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    electionDuration: async () => {
      // Immediate return for testing
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    appendEntriesTimeout: async () => {
      // Immediate return for testing
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // Test helpers
    triggerHeartbeat: () => {
      if (heartbeatCallback) heartbeatCallback();
    },
    triggerElectionTimeout: () => {
      if (electionCallback) electionCallback();
    },
    resetElectionTimeout: () => {
      if (electionTimeoutReset) electionTimeoutReset();
    },
  };
};

describe("RaftKv", () => {
  // Previous sections (1-2) remain unchanged...

  // Section 3: Leader Heartbeat Tests
  describe("3. Leader Heartbeat", () => {
    it("3-1: leader should send periodic heartbeats", async () => {
      const storage = createMemoryStorage();
      const heartbeats: AppendEntriesArgs[] = [];

      const mockRpc = createMockRpc({
        onAppendEntries: (args) => heartbeats.push(args),
      });

      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [
          { id: "node2", rpc: mockRpc },
          { id: "node3", rpc: mockRpc },
        ],
        storage,
        timers,
      });

      // Become leader first
      timers.triggerElectionTimeout();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger heartbeat
      timers.triggerHeartbeat();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(heartbeats.length).toBe(2); // One heartbeat to each follower
      expect(heartbeats[0].entries).toHaveLength(0); // Empty entries for heartbeat
      expect(heartbeats[0].term).toBe(1); // Term should be 1 after election
    });

    it("3-2: leader should step down on higher term response", async () => {
      const storage = createMemoryStorage();
      const timers = createMockTimers();

      // One node will respond with higher term
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [
          {
            id: "node2",
            rpc: createMockRpc({
              appendEntriesResponse: { term: 2, success: false },
            }),
          },
          { id: "node3", rpc: createMockRpc() },
        ],
        storage,
        timers,
      });

      // Become leader first
      timers.triggerElectionTimeout();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger heartbeat which will receive higher term
      timers.triggerHeartbeat();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = await node.getNodeState();
      expect(state.role).toBe("follower");
      expect(state.term).toBe(2);
    });
  });

  // Section 4: Log Replication Tests
  describe("4. Log Replication", () => {
    it("4-1: should replicate client commands to followers", async () => {
      const storage = createMemoryStorage();
      const appendedEntries: AppendEntriesArgs[] = [];

      const mockRpc = createMockRpc({
        onAppendEntries: (args) => appendedEntries.push(args),
      });

      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [
          { id: "node2", rpc: mockRpc },
          { id: "node3", rpc: mockRpc },
        ],
        storage,
        timers,
      });

      // Become leader first
      timers.triggerElectionTimeout();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send client command
      const command: KvCommand = { op: "set", key: "test", value: "value" };
      await node.handleClientRequest([command]);

      // Check if command was replicated
      const relevantEntries = appendedEntries.filter(
        (args) => args.entries.length > 0,
      );
      expect(relevantEntries).toHaveLength(2); // Sent to both followers
      expect(relevantEntries[0].entries[0].command).toEqual(command);
    });

    it("4-2: should handle log inconsistency", async () => {
      const storage = createMemoryStorage();
      const appendedEntries: AppendEntriesArgs[] = [];

      // Simulate a follower that rejects first append due to log mismatch
      let firstAttempt = true;
      const mockRpc = createMockRpc({
        appendEntriesResponse: (
          args: AppendEntriesArgs,
        ): AppendEntriesReply => {
          if (firstAttempt) {
            firstAttempt = false;
            return { term: args.term, success: false };
          }
          return { term: args.term, success: true };
        },
        onAppendEntries: (args) => appendedEntries.push(args),
      });

      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [{ id: "node2", rpc: mockRpc }],
        storage,
        timers,
      });

      // Become leader and send command
      timers.triggerElectionTimeout();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const command: KvCommand = { op: "set", key: "test", value: "value" };
      await node.handleClientRequest([command]);

      // Should see multiple append attempts with decreasing prevLogIndex
      expect(appendedEntries.length).toBeGreaterThan(1);
      expect(appendedEntries[1].prevLogIndex).toBeLessThan(
        appendedEntries[0].prevLogIndex,
      );
    });

    it("4-4: should replicate no-op entry on leader election", async () => {
      const storage = createMemoryStorage();
      const appendedEntries: AppendEntriesArgs[] = [];

      const mockRpc = createMockRpc({
        onAppendEntries: (args) => appendedEntries.push(args),
      });

      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [
          { id: "node2", rpc: mockRpc },
          { id: "node3", rpc: mockRpc },
        ],
        storage,
        timers,
      });

      // Become leader
      timers.triggerElectionTimeout();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if no-op entry was replicated
      const noopEntries = appendedEntries.filter(
        (args) =>
          args.entries.length > 0 && args.entries[0].command.op === "noop",
      );
      expect(noopEntries).toHaveLength(2); // Sent to both followers
    });
  });

  // Let's continue with Section 5: Follower AppendEntries Tests
  describe("5. Follower AppendEntries", () => {
    it("5-1: should not apply logs beyond leaderCommit", async () => {
      const storage = createMemoryStorage();
      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [],
        storage,
        timers,
      });

      // Append entries with leaderCommit = 1
      await node.handleAppendEntries({
        term: 1,
        leaderId: "leader",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [
          { term: 1, command: { op: "set", key: "x", value: "1" } },
          { term: 1, command: { op: "set", key: "y", value: "2" } },
        ],
        leaderCommit: 1,
      });

      const state = await node.getNodeState();
      expect(state.commitIndex).toBe(1); // Should only commit up to leaderCommit
    });

    it("5-2: should reject AppendEntries with mismatched prevLogTerm", async () => {
      const storage = createMemoryStorage();
      await storage.appendLogEntries(0, [
        { term: 1, command: { op: "set", key: "x", value: "1" } },
      ]);

      const timers = createMockTimers();
      const node = await initializeRaftKv({
        nodeId: "node1",
        nodes: [],
        storage,
        timers,
      });

      // Try to append with wrong prevLogTerm
      const result = await node.handleAppendEntries({
        term: 2,
        leaderId: "leader",
        prevLogIndex: 0,
        prevLogTerm: 2, // Different from the actual term (1) at index 0
        entries: [],
        leaderCommit: 0,
      });

      expect(result.success).toBe(false);
    });

    // Section 6: Client Request Tests
    describe("6. Client Request", () => {
      it("6-1: follower should redirect client requests", async () => {
        const storage = createMemoryStorage();
        await storage.saveState({ term: 1, votedFor: "leader" });

        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [],
          storage,
          timers,
        });

        const result = await node.handleClientRequest([
          { op: "set", key: "x", value: "1" },
        ]);

        expect(result).toEqual({
          type: "redirect",
          redirect: "leader",
        });
      });

      it("6-2: candidate should return in-election for client requests", async () => {
        const storage = createMemoryStorage();
        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [{ id: "node2", rpc: createMockRpc() }],
          storage,
          timers,
        });

        // Trigger election but don't wait for completion
        timers.triggerElectionTimeout();

        const result = await node.handleClientRequest([
          { op: "set", key: "x", value: "1" },
        ]);

        expect(result).toEqual({ type: "in-election" });
      });

      it("6-3: leader should handle client requests successfully", async () => {
        const storage = createMemoryStorage();
        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [
            { id: "node2", rpc: createMockRpc() },
            { id: "node3", rpc: createMockRpc() },
          ],
          storage,
          timers,
        });

        // Become leader first
        timers.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const command: KvCommand = { op: "set", key: "x", value: "1" };
        const result = await node.handleClientRequest([command]);

        expect(result).toEqual({ type: "success" });

        // Verify the command was committed
        const state = await node.getNodeState();
        expect(state.commitIndex).toBeGreaterThan(0);
      });
    });

    // Section 7: Timeout/Retry Tests
    describe("7. Timeout and Retry", () => {
      it("7-1: should retry AppendEntries on timeout", async () => {
        const storage = createMemoryStorage();
        const appendEntryAttempts: AppendEntriesArgs[] = [];

        // First call times out, second succeeds
        let callCount = 0;
        const mockRpc = createMockRpc({
          appendEntriesResponse: (
            args: AppendEntriesArgs,
          ): AppendEntriesReply => {
            appendEntryAttempts.push(args);
            callCount++;
            if (callCount === 1) {
              // Simulate timeout by returning failure
              return { term: args.term, success: false };
            }
            return { term: args.term, success: true };
          },
          appendEntriesDelay: callCount === 1 ? 1000 : 0, // Add delay for first call
        });

        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [{ id: "node2", rpc: mockRpc }],
          storage,
          timers,
        });

        // Become leader and send command
        timers.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));

        await node.handleClientRequest([{ op: "set", key: "x", value: "1" }]);

        expect(appendEntryAttempts.length).toBeGreaterThan(1); // Should have retried
      });

      it("7-2: should retry election on timeout", async () => {
        const storage = createMemoryStorage();
        const voteRequests: RequestVoteArgs[] = [];

        const mockRpc = createMockRpc({
          requestVoteResponse: { term: 1, voteGranted: false },
          onRequestVote: (args) => voteRequests.push(args),
        });

        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [{ id: "node2", rpc: mockRpc }],
          storage,
          timers,
        });

        // Trigger multiple election timeouts
        timers.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));
        timers.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(voteRequests.length).toBeGreaterThan(1);
        expect(voteRequests[1].term).toBeGreaterThan(voteRequests[0].term);
      });
    });

    // Section 8: Network Partition Tests
    describe("8. Network Partition", () => {
      it("8-1: should handle leader crash and elect new leader", async () => {
        const storage1 = createMemoryStorage();
        const storage2 = createMemoryStorage();
        const storage3 = createMemoryStorage();

        const timers1 = createMockTimers();
        const timers2 = createMockTimers();
        const timers3 = createMockTimers();

        // Create three nodes
        const node1 = await initializeRaftKv({
          nodeId: "node1",
          nodes: [
            { id: "node2", rpc: createMockRpc() },
            { id: "node3", rpc: createMockRpc() },
          ],
          storage: storage1,
          timers: timers1,
        });

        const node2 = await initializeRaftKv({
          nodeId: "node2",
          nodes: [
            { id: "node1", rpc: createMockRpc() },
            { id: "node3", rpc: createMockRpc() },
          ],
          storage: storage2,
          timers: timers2,
        });

        const node3 = await initializeRaftKv({
          nodeId: "node3",
          nodes: [
            { id: "node1", rpc: createMockRpc() },
            { id: "node2", rpc: createMockRpc() },
          ],
          storage: storage3,
          timers: timers3,
        });

        // Make node1 leader
        timers1.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify node1 is leader
        const state1 = await node1.getNodeState();
        expect(state1.role).toBe("leader");

        // Simulate node1 crash by making others timeout
        timers2.triggerElectionTimeout();
        timers3.triggerElectionTimeout();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Either node2 or node3 should become leader
        const state2 = await node2.getNodeState();
        const state3 = await node3.getNodeState();
        expect(state2.role === "leader" || state3.role === "leader").toBe(true);
      });

      it("8-2: should resolve split-brain situation", async () => {
        const storage = createMemoryStorage();
        const timers = createMockTimers();

        // Create a node that thinks it's leader with term 2
        await storage.saveState({ term: 2, votedFor: "node1" });
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [
            {
              id: "node2",
              rpc: createMockRpc({
                appendEntriesResponse: { term: 3, success: false }, // Higher term
              }),
            },
          ],
          storage,
          timers,
        });

        // Trigger heartbeat which will receive higher term
        timers.triggerHeartbeat();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Node should step down
        const state = await node.getNodeState();
        expect(state.role).toBe("follower");
        expect(state.term).toBe(3);
      });
    });

    // Section 9: Storage/Lock Tests
    describe("9. Storage and Lock", () => {
      it("9-1: should handle concurrent requests with lock", async () => {
        const storage = createMemoryStorage();
        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [],
          storage,
          timers,
        });

        // Send multiple concurrent AppendEntries requests
        const results = await Promise.all([
          node.handleAppendEntries({
            term: 1,
            leaderId: "leader",
            prevLogIndex: 0,
            prevLogTerm: 0,
            entries: [
              { term: 1, command: { op: "set", key: "x", value: "1" } },
            ],
            leaderCommit: 0,
          }),
          node.handleAppendEntries({
            term: 1,
            leaderId: "leader",
            prevLogIndex: 0,
            prevLogTerm: 0,
            entries: [
              { term: 1, command: { op: "set", key: "y", value: "2" } },
            ],
            leaderCommit: 0,
          }),
        ]);

        // Both requests should complete without conflicts
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
      });

      it("9-2: should maintain storage consistency", async () => {
        const storage = createMemoryStorage();
        const timers = createMockTimers();
        const node = await initializeRaftKv({
          nodeId: "node1",
          nodes: [],
          storage,
          timers,
        });

        // Update term and votedFor
        await node.handleRequestVote({
          term: 2,
          candidateId: "node2",
          lastLogIndex: 0,
          lastLogTerm: 0,
        });

        // Verify storage state
        const state = await node.getNodeState();
        expect(state.term).toBe(2);
        expect(state.votedFor).toBe("node2");

        // Add some log entries
        await node.handleAppendEntries({
          term: 2,
          leaderId: "node2",
          prevLogIndex: 0,
          prevLogTerm: 0,
          entries: [{ term: 2, command: { op: "set", key: "x", value: "1" } }],
          leaderCommit: 1,
        });

        // Verify log entry was stored
        const lastEntry = await storage.getLastLogEntry();
        expect(lastEntry).toBeDefined();
        expect(lastEntry?.term).toBe(2);
        expect(lastEntry?.command.op).toBe("set");
      });
    });
  });
});
