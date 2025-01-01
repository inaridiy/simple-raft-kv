import * as v from "valibot";

export const RaftKvOptionsSchema = v.object({});

export type RaftKvOptionsInput = v.InferInput<typeof RaftKvOptionsSchema>;
export type RaftKvOptions = v.InferOutput<typeof RaftKvOptionsSchema>;

export const KvCommandSchema = v.object({});

export const LogEntrySchema = v.object({
  term: v.number(),
  command: KvCommandSchema,
});

export const AppendEntriesArgsSchema = v.object({
  term: v.number(),
  leaderId: v.string(),
  prevLogIndex: v.number(),
  prevLogTerm: v.number(),
  entries: v.array(LogEntrySchema),
  leaderCommit: v.number(),
});

export const AppendEntriesReplySchema = v.object({
  term: v.number(),
  success: v.boolean(),
});

export const RequestVoteArgsSchema = v.object({
  term: v.number(),
  candidateId: v.string(),
  lastLogIndex: v.number(),
  lastLogTerm: v.number(),
});

export const RequestVoteReplySchema = v.object({
  term: v.number(),
  voteGranted: v.boolean(),
});
