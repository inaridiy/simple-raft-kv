import * as v from "valibot";

// この実装用の定義

export const RaftKvOptionsSchema = v.object({});

export type RaftKvOptionsInput = v.InferInput<typeof RaftKvOptionsSchema>;
export type RaftKvOptions = v.InferOutput<typeof RaftKvOptionsSchema>;

export type RaftKvStorage = {
  loadState: () => Promise<PersistentState>;
  saveState: (state: PersistentState) => Promise<void>;
  // 不正なLogEntryを上書きながら追加する [from, startIndex + entries.length)の範囲のLogEntryを追加する
  // 追加した最後のLogEntryのindexを返す。indexは1から始まる
  appendLogEntries: (from: number, entries: LogEntry[]) => Promise<number>;
  getLastLogEntry: () => Promise<PersistedLogEntry | null>;
  getLogEntryByIndex: (index: number) => Promise<PersistedLogEntry | null>;
  // [lastCommitIndex, endIndex)の範囲のLogEntryをKVストアに適用する
  commitLogEntries: (endIndex: number) => Promise<void>;
};

export type RaftKvRpc = {
  requestVote: (args: RequestVoteArgs) => Promise<RequestVoteReply>;
  appendEntries: (args: AppendEntriesArgs) => Promise<AppendEntriesReply>;
};

export type MemoryState = {
  role: NodeRole;
  commitIndex: number;
};

export type ElectionResult =
  | { type: "win" }
  | { type: "lose"; term: number }
  | { type: "timeout" };

// 論文に書かれている定義

export type NodeRole = "follower" | "candidate" | "leader";

export const PersistentStateSchema = v.object({
  term: v.number(),
  votedFor: v.union([v.string(), v.null()]),
});

export type PersistentState = v.InferOutput<typeof PersistentStateSchema>;

export const KvCommandSchema = v.union([
  v.object({ op: v.literal("set"), key: v.string(), value: v.string() }),
  v.object({ op: v.literal("delete"), key: v.string() }),
  v.object({ op: v.literal("noop") }),
]);

export type KvCommand = v.InferOutput<typeof KvCommandSchema>;

export const LogEntrySchema = v.object({
  term: v.number(),
  command: KvCommandSchema,
});

export type LogEntry = v.InferOutput<typeof LogEntrySchema>;

export const PersistedLogEntrySchema = v.object({
  index: v.number(),
  term: v.number(),
  command: KvCommandSchema,
});

export type PersistedLogEntry = v.InferOutput<typeof PersistedLogEntrySchema>;

export const AppendEntriesArgsSchema = v.object({
  term: v.number(),
  leaderId: v.string(),
  prevLogIndex: v.number(),
  prevLogTerm: v.number(),
  entries: v.array(LogEntrySchema),
  leaderCommit: v.number(),
});

export type AppendEntriesArgs = v.InferOutput<typeof AppendEntriesArgsSchema>;

export const AppendEntriesReplySchema = v.object({
  term: v.number(),
  success: v.boolean(),
});

export type AppendEntriesReply = v.InferOutput<typeof AppendEntriesReplySchema>;

export const RequestVoteArgsSchema = v.object({
  term: v.number(),
  candidateId: v.string(),
  lastLogIndex: v.number(),
  lastLogTerm: v.number(),
});

export type RequestVoteArgs = v.InferOutput<typeof RequestVoteArgsSchema>;

export const RequestVoteReplySchema = v.object({
  term: v.number(),
  voteGranted: v.boolean(),
});

export type RequestVoteReply = v.InferOutput<typeof RequestVoteReplySchema>;
