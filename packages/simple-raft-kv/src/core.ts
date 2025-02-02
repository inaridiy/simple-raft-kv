import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  ElectionResult,
  KvCommand,
  LogEntry,
  MemoryState,
  NodeRole,
  PersistentState,
  RaftKvRpc,
  RaftKvStorage,
  RequestVoteArgs,
  RequestVoteReply,
} from "./types.js";
import { createLock } from "./utils.js";

export interface RaftKvParams {
  nodeId: string;
  nodes: { id: string; rpc: RaftKvRpc }[];
  storage: RaftKvStorage;
  logger?: ((message: string) => void) | null;
  // 本来はelectionRetrySleepとelectionDurationは必要ないが、テストし易くするために分割している
  timers: {
    // (cb: ハートビートハンドラー) => void
    heartbeatInterval: (cb: () => void) => void;
    // (cb: タイムアウトハンドラー) => リセット関数
    electionTimeout: (cb: () => void) => () => void;
    // ランダムな時間のSleep
    electionRetrySleep: () => Promise<void>;
    //固定値のSleep
    electionDuration: () => Promise<void>;
    appendEntriesTimeout: () => Promise<void>;
  };
}

export const initializeRaftKv = (params: RaftKvParams) => {
  const { nodeId, nodes, storage, timers, logger } = params;

  // ログ出力関数
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${nodeId}] [${level.toUpperCase()}]`;
    const logMessage = context
      ? `${prefix} ${message} ${JSON.stringify(context)}`
      : `${prefix} ${message}`;
    if (logger) {
      logger(logMessage);
    }
  };

  let role = "follower" as NodeRole;
  let commitIndex = 0;
  let nextIndex = new Map<string, number>();
  let matchIndex = new Map<string, number>();

  const _becomeFollower = async (term: number) => {
    log("info", "Node transitioning to follower state", { term });
    role = "follower";
    const newState = { term, votedFor: null };
    await storage.saveState(newState);
    _resetElectionTimeout();
  };

  const _becomeLeader = async () => {
    log("info", "Node transitioning to leader state");
    role = "leader";

    //1. リーダー用の変数を初期化
    nextIndex = new Map<string, number>();
    matchIndex = new Map<string, number>();

    const lastLogEntry = await storage.getLastLogEntry();
    for (const node of nodes) {
      // 2. リーダーのログの次のエントリーを追加する
      nextIndex.set(node.id, (lastLogEntry?.index ?? 0) + 1);
      matchIndex.set(node.id, 0);
    }

    void _appendAndCommitCommands([{ op: "noop" }]);
  };

  const _startElection = async () => {
    if (role === "leader") return;
    log("info", "Starting election");

    // 1. 自分のtermを1増やして候補者になる
    const state = await storage.loadState();
    role = "candidate";
    const term = state.term + 1;
    const votedFor = nodeId;
    await storage.saveState({ term, votedFor });

    const votesNeeded = Math.floor(nodes.length / 2) + 1;
    log("debug", "Election details", { term, votesNeeded });

    const lastLogEntry = await storage.getLastLogEntry();
    const requestVoteArgs = {
      term,
      candidateId: nodeId,
      lastLogIndex: lastLogEntry?.index ?? 0,
      lastLogTerm: lastLogEntry?.term ?? 0,
    };
    log("debug", "Requesting votes with args", requestVoteArgs);

    const voteResultWaiting = new Promise<ElectionResult>((resolve) => {
      if (nodes.length === 0) resolve({ type: "win" });

      let votesReceived = 1;
      const promises = nodes.map((node) =>
        node.rpc.requestVote(requestVoteArgs).then((result) => {
          log("debug", "Received vote result", {
            from: node.id,
            result,
            votesReceived,
            votesNeeded,
          });
          if (result === null) return;

          // 2. 他の候補者のtermが自分のtermより大きい場合は、即時にフォロワーになる
          if (result.term > term) resolve({ type: "lose", term: result.term });
          if (result.voteGranted) votesReceived++;
          // 3. 過半数の投票を受け取った場合はリーダーになる
          if (votesReceived >= votesNeeded) resolve({ type: "win" });
        }),
      );

      //過半数以上からvoteGrated:falseを受け取った場合、失敗扱いでいいのか？
      Promise.all(promises).then(() => resolve({ type: "timeout" }));
    });
    const voteResult = await Promise.race([
      voteResultWaiting,
      timers.electionDuration().then(() => ({ type: "timeout" as const })),
    ]);

    // 別のノードからAppendEntriesが来てrole=followerとなった場合、選挙を中止する
    if (role !== "candidate") return;

    if (voteResult.type === "win") {
      await _becomeLeader();
    } else if (voteResult.type === "lose") {
      await _becomeFollower(voteResult.term);
    } else {
      // 4. タイムアウトした場合は再選挙
      await timers.electionRetrySleep();
      _resetElectionTimeout();
      if (role === "candidate") await _startElection();
    }
  };

  const _sendHeartbeat = async () => {
    if (role !== "leader") return;
    const state = await storage.loadState();
    const lastLogEntry = await storage.getLastLogEntry();

    const heartbeatArgs = {
      term: state.term,
      leaderId: nodeId,
      prevLogIndex: lastLogEntry?.index ?? 0,
      prevLogTerm: lastLogEntry?.term ?? 0,
      entries: [],
      leaderCommit: commitIndex,
    };
    log("debug", "Sending heartbeat", {
      lastLogEntry,
      term: state.term,
      leaderCommit: commitIndex,
    });

    //TODO: heartbeatが詰まる可能性に対処
    for (const node of nodes) _sendAppendEntriesExclusive(node, heartbeatArgs);
  };

  const _sendAppendEntries = async (
    node: { id: string; rpc: RaftKvRpc },
    args: AppendEntriesArgs,
  ) => {
    if (role !== "leader") return;

    log("debug", "Sending appendEntries", {
      to: node.id,
      entries: args.entries.length,
      prevLogIndex: args.prevLogIndex,
      term: args.term,
    });

    const result = await Promise.race([
      node.rpc.appendEntries(args),
      timers.appendEntriesTimeout().then(() => null),
    ]);

    if (result === null) {
      log("warn", "AppendEntries timed out", { to: node.id });
    } else {
      log("debug", "Received appendEntries result", {
        from: node.id,
        success: result.success,
        term: result.term,
      });
    }
    // タイムアウトした場合はリトライ
    if (!result) {
      await timers.appendEntriesTimeout();
      return await _sendAppendEntries(node, args);
    }

    // 既にリーダーでない場合は即時フォロワー降格
    if (result.term > args.term) {
      await _becomeFollower(result.term);

      return;
    }

    // 成功した場合は終了
    if (result.success) {
      nextIndex.set(node.id, args.prevLogIndex + args.entries.length + 1);
      matchIndex.set(node.id, args.prevLogIndex + args.entries.length);
      return;
    }

    // 以後appendEntriesに失敗した = ログが不整合に対処する
    const nextIndexValue = (nextIndex.get(node.id) ?? 0) - 1;
    if (nextIndexValue < 1) throw new Error("WTF: nextIndexValue < 1");
    nextIndex.set(node.id, nextIndexValue);

    const nextIndexLogEntry = await storage.getLogEntryByIndex(nextIndexValue);
    const prevLogEntry = await storage.getLogEntryByIndex(nextIndexValue - 1);
    if (!nextIndexLogEntry)
      throw new Error("WTF: nextIndexLogEntry is undefined");

    const appendEntriesArgs = {
      term: args.term,
      leaderId: nodeId,
      prevLogIndex: prevLogEntry?.index ?? 0,
      prevLogTerm: prevLogEntry?.term ?? 0,
      entries: [nextIndexLogEntry],
      leaderCommit: commitIndex,
    };

    await _sendAppendEntries(node, appendEntriesArgs);
    await _sendAppendEntries(node, args);
  };

  const _sendAppendEntriesLock = createLock();
  const _sendAppendEntriesExclusive = async (
    node: { id: string; rpc: RaftKvRpc },
    args: AppendEntriesArgs,
  ) => {
    // nodeごとに排他制御を行う
    const { unlock, queueLength } = await _sendAppendEntriesLock(node.id);
    try {
      // スタックしたハートビートをスキップ
      if (args.entries.length === 0 && queueLength > 0) return;
      await _sendAppendEntries(node, args);
    } finally {
      unlock();
    }
  };

  const _appendAndCommitCommands = async (commands: KvCommand[]) => {
    const state = await storage.loadState();
    const lastLogEntry = await storage.getLastLogEntry();
    const newLogEntries: LogEntry[] = commands.map((command, i) => ({
      term: state.term,
      command,
    }));

    await storage.appendLogEntries(
      (lastLogEntry?.index ?? 0) + 1,
      newLogEntries,
    );

    const applyNeeded = Math.floor(nodes.length / 2) + 1;

    const appendEntriesArgs = {
      term: state.term,
      leaderId: nodeId,
      prevLogIndex: lastLogEntry?.index ?? 0,
      prevLogTerm: lastLogEntry?.term ?? 0,
      entries: newLogEntries,
      leaderCommit: commitIndex,
    };

    const isAppendSuccess = await new Promise<boolean>((resolve) => {
      if (nodes.length === 0) resolve(true);

      let successCount = 1;
      const promises = nodes.map((node) =>
        _sendAppendEntriesExclusive(node, appendEntriesArgs).then(() => {
          successCount++;
          if (successCount >= applyNeeded) resolve(true);
        }),
      );

      Promise.all(promises).then(() => resolve(false));
    });

    if (!isAppendSuccess) throw new Error("WTF: isAppendSuccess is false");

    commitIndex += newLogEntries.length;
    void storage.commitLogEntries(commitIndex);
  };

  const handleRequestLock = createLock();
  const handleAppendEntries = async (
    args: AppendEntriesArgs,
  ): Promise<AppendEntriesReply> => {
    const { unlock } = await handleRequestLock();
    try {
      const state = await storage.loadState();
      log("debug", "Handling appendEntries request", {
        currentTerm: state.term,
        leaderTerm: args.term,
        prevLogIndex: args.prevLogIndex,
        entriesCount: args.entries.length,
        leaderCommit: args.leaderCommit,
      });

      // 1. リーダーのtermが自分のtermより小さい場合は拒否
      if (args.term < state.term) {
        log("warn", "Rejecting appendEntries - leader term is behind", {
          leaderTerm: args.term,
          currentTerm: state.term,
        });
        return { term: state.term, success: false };
      }

      // 2. リーダーのtermが自分のtermより大きい場合はフォロワーになる
      if (args.term > state.term) {
        log("info", "Newer term detected in appendEntries", {
          currentTerm: state.term,
          leaderTerm: args.term,
        });
        await _becomeFollower(args.term);
      }
      _resetElectionTimeout();

      // 3. prevLogIndexの位置にprevLogTermと一致するエントリがログにない場合、falseを返す (§5.3)
      const prevLogEntry = await storage.getLogEntryByIndex(args.prevLogIndex);
      if (
        args.prevLogIndex > 0 && // 0の場合は初めのエントリーなので無視
        (!prevLogEntry || prevLogEntry.term !== args.prevLogTerm)
      )
        return { term: args.term, success: false };

      await storage.appendLogEntries(args.prevLogIndex + 1, args.entries);

      // 4. leaderCommitまでState Machineに適用する。lastAppliedはKV内で保持される
      commitIndex = Math.min(
        args.leaderCommit,
        args.prevLogIndex + args.entries.length,
      );
      // 適用は非同期で行う
      void storage.commitLogEntries(commitIndex);

      return { term: args.term, success: true };
    } finally {
      unlock();
    }
  };

  const handleRequestVote = async (
    args: RequestVoteArgs,
  ): Promise<RequestVoteReply> => {
    const { unlock } = await handleRequestLock();
    try {
      let state = await storage.loadState();
      log("debug", "Handling vote request", {
        candidateId: args.candidateId,
        candidateTerm: args.term,
        currentTerm: state.term,
        lastLogIndex: args.lastLogIndex,
        lastLogTerm: args.lastLogTerm,
      });

      // 1. 自分のtermがリクエストのtermより大きい場合は拒否
      if (args.term < state.term) {
        log("warn", "Rejecting vote request - candidate term is behind", {
          candidateTerm: args.term,
          currentTerm: state.term,
        });
        return { term: state.term, voteGranted: false };
      }

      // 2. リクエストのtermが自分のtermより大きい場合はフォロワーになる
      if (args.term > state.term) {
        log("info", "Newer term detected in vote request", {
          currentTerm: state.term,
          candidateTerm: args.term,
        });
        await _becomeFollower(args.term);
        _resetElectionTimeout();
        // Stateを更新
        state = await storage.loadState();
      }

      // 3. 既に投票済みの場合は拒否
      if (state.votedFor && state.votedFor !== args.candidateId)
        return { term: args.term, voteGranted: false };

      // 4. リクエストのログが自分のログより新しい場合は投票
      const lastLogEntry = await storage.getLastLogEntry();
      const isCandidateLogNewer =
        !lastLogEntry ||
        lastLogEntry.term < args.lastLogTerm || // termが進んでいる場合
        (lastLogEntry.term === args.lastLogTerm && // termが同じでindexが進んでいる場合
          lastLogEntry.index <= args.lastLogIndex);

      if (!isCandidateLogNewer) return { term: args.term, voteGranted: false };

      await storage.saveState({ term: args.term, votedFor: args.candidateId });
      _resetElectionTimeout();

      return { term: args.term, voteGranted: true };
    } finally {
      unlock();
    }
  };

  const handleClientRequest = async (commands: KvCommand[]) => {
    const { votedFor } = await storage.loadState();
    if (role === "follower")
      return { type: "redirect" as const, redirect: votedFor };
    if (role === "candidate") return { type: "in-election" as const };

    await _appendAndCommitCommands(commands);

    return { type: "success" as const };
  };

  const getNodeState = async (): Promise<MemoryState & PersistentState> => {
    const persisted = await storage.loadState();

    return { role, commitIndex, ...persisted };
  };

  const getLeaderState = async () => {
    if (role !== "leader") return null;
    return { commitIndex, nextIndex, matchIndex };
  };

  const _resetElectionTimeout = timers.electionTimeout(_startElection);
  timers.heartbeatInterval(_sendHeartbeat);

  return {
    getNodeState,
    getLeaderState,
    handleAppendEntries,
    handleRequestVote,
    handleClientRequest,
  };
};

export type RaftKvNode = Awaited<ReturnType<typeof initializeRaftKv>>;
