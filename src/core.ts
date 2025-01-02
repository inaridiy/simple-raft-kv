import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  ElectionResult,
  NodeRole,
  RaftKvRpc,
  RaftKvStorage,
  RequestVoteArgs,
  RequestVoteReply,
} from "./types.js";

export interface RaftKvParams {
  nodeId: string;
  nodes: { id: string; rpc: RaftKvRpc }[];
  storage: RaftKvStorage;
  // (cb: ハートビートハンドラー) => void
  heartbeatInterval: (cb: () => void) => void;
  // (cb: タイムアウトハンドラー) => リセット関数
  electionTimeout: (cb: () => void) => () => void;
  // () => Promise<void>;
  electionRetrySleep: () => Promise<void>;
  // () => Promise<void>;
  electionDuration: () => Promise<void>;
}

export const initializeRaftKv = async (params: RaftKvParams) => {
  const { nodeId, nodes, storage, heartbeatInterval } = params;
  const { electionRetrySleep, electionTimeout, electionDuration } = params;

  let role = "follower" as NodeRole;
  let nextIndex = new Map<string, number>();
  let matchIndex = new Map<string, number>();

  const becomeFollower = async (term: number) => {
    role = "follower";
    const newState = { term, votedFor: null };
    await storage.saveState(newState);
  };

  const becomeLeader = async () => {
    role = "leader";

    //1. リーダー用の変数を初期化
    nextIndex = new Map<string, number>();
    matchIndex = new Map<string, number>();

    const lastLogEntry = await storage.getLastLogEntry();
    for (const node of nodes) {
      // 2. リーダーのログの次のエントリーを追加する
      nextIndex.set(node.id, (lastLogEntry?.index ?? -1) + 1);
      matchIndex.set(node.id, 0);
    }
  };

  const startElection = async () => {
    // 1. 自分のtermを1増やして候補者になる
    const state = await storage.loadState();
    role = "candidate";
    const term = state.term + 1;
    const votedFor = nodeId;
    await storage.saveState({ term, votedFor });

    const votesNeeded = Math.floor(nodes.length / 2) + 1;

    const lastLogEntry = await storage.getLastLogEntry();
    const requestVoteArgs = {
      term,
      candidateId: nodeId,
      lastLogIndex: lastLogEntry?.index ?? 0,
      lastLogTerm: lastLogEntry?.term ?? 0,
    };

    const voteResultWaiting = new Promise<ElectionResult>((resolve) => {
      let votesReceived = 1;
      const promises = nodes.map((node) =>
        node.rpc.requestVote(requestVoteArgs).then((result) => {
          // 2. 他の候補者のtermが自分のtermより大きい場合は、即時にフォロワーになる
          if (result.term > term) resolve({ type: "lose", term: result.term });
          if (result.voteGranted) votesReceived++;
          // 3. 過半数の投票を受け取った場合はリーダーになる
          if (votesReceived >= votesNeeded) resolve({ type: "win" });
        }),
      );
      Promise.all(promises).then(() => resolve({ type: "timeout" }));
    });
    const voteResult = await Promise.race([
      voteResultWaiting,
      electionDuration().then((): ElectionResult => ({ type: "timeout" })),
    ]);

    // 別のノードからAppendEntriesが来ていた場合、選挙を中断する
    if (role !== "candidate") return;

    if (voteResult.type === "win") {
      await becomeLeader();
    } else if (voteResult.type === "lose") {
      await becomeFollower(voteResult.term);
      resetElectionTimeout();
    } else {
      // 4. タイムアウトした場合は再選挙
      await electionRetrySleep();
      startElection();
    }
  };

  const sendHeartbeat = async () => {
    if (role !== "leader") return;
    const state = await storage.loadState();
    const lastLogEntry = await storage.getLastLogEntry();

    const appendEntriesArgs = {
      term: state.term,
      leaderId: nodeId,
      prevLogIndex: lastLogEntry?.index ?? 0,
      prevLogTerm: lastLogEntry?.term ?? 0,
      entries: [], //ハートビートなので空
      leaderCommit: 0, //ハートビートなので0
    };
  };

  // あ～アトミックにしてぇ、トランザクション張りてぇ (´；ω；｀)
  const handleAppendEntries = async (
    args: AppendEntriesArgs,
  ): Promise<AppendEntriesReply> => {
    const state = await storage.loadState();
    // 1. リーダーのtermが自分のtermより小さい場合は拒否
    if (args.term < state.term) return { term: state.term, success: false };

    // 2. リーダーのtermが自分のtermより大きい場合はフォロワーになる
    if (args.term > state.term) await becomeFollower(args.term);
    resetElectionTimeout();

    // 3. prevLogIndexの位置にprevLogTermと一致するエントリがログにない場合、falseを返す (§5.3)
    const prevLogEntry = await storage.getLogEntryByIndex(args.prevLogIndex);
    if (!prevLogEntry || prevLogEntry.term !== args.prevLogTerm)
      return { term: args.term, success: false };

    await storage.appendLogEntries(args.prevLogIndex + 1, args.entries);

    // 4. leaderCommitまでState Machineに適用する。lastAppliedはKV内で保持される
    const commitIndex = Math.min(
      args.leaderCommit,
      args.prevLogIndex + args.entries.length,
    );
    // 適用は非同期で行う
    void storage.commitLogEntries(commitIndex);

    return { term: args.term, success: true };
  };

  // あ～アトミックにしてぇ、トランザクション張りてぇ (´；ω；｀)
  const handleRequestVote = async (
    args: RequestVoteArgs,
  ): Promise<RequestVoteReply> => {
    const state = await storage.loadState();
    // 1. 自分のtermがリクエストのtermより大きい場合は拒否
    if (args.term < state.term) return { term: state.term, voteGranted: false };

    // 2. 既に投票済みの場合は拒否
    if (state.votedFor && state.votedFor !== args.candidateId)
      return { term: args.term, voteGranted: false };

    // 3. リクエストのログが自分のログより新しい場合は投票
    const lastLogEntry = await storage.getLastLogEntry();
    const isCandidateLogNewer =
      !lastLogEntry ||
      lastLogEntry.term < args.lastLogTerm || // termが進んでいる場合
      (lastLogEntry.term === args.lastLogTerm && // termが同じでindexが進んでいる場合
        lastLogEntry.index <= args.lastLogIndex);

    if (!isCandidateLogNewer) return { term: args.term, voteGranted: false };

    await storage.saveState({ term: args.term, votedFor: args.candidateId });
    resetElectionTimeout();

    return { term: args.term, voteGranted: true };
  };

  const resetElectionTimeout = electionTimeout(startElection);

  heartbeatInterval(sendHeartbeat);

  return {
    handleAppendEntries,
    handleRequestVote,
  };
};
