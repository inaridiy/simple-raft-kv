import { Database } from "./database";
import type { Network } from "./network";
import {
  type AppendEntriesArgs,
  type AppendEntriesResult,
  type Command,
  type LogEntry,
  type RequestVoteArgs,
  type RequestVoteResult,
  ServerState,
} from "./types";

export class Server {
  // 永続的な状態（全てのサーバー上）
  public currentTerm: number; // サーバーが認識している最新のterm（起動時に0で初期化され、その後単調に増加）
  public votedFor: number | null; // 現在のtermで投票した候補者のID（存在しない場合はnull）
  public log: LogEntry[]; // ログエントリの配列

  // 揮発的な状態（全てのサーバー上）
  public commitIndex: number; // コミットされたことが分かっている最後のログエントリのインデックス（起動時に0で初期化され、その後単調に増加） (§5.3, §5.4)
  public lastApplied: number; // ステートマシンに適用された最後のログエントリのインデックス（起動時に0で初期化され、その後単調に増加） (§5.3)

  // 揮発的な状態（リーダー上、選挙後に再初期化）
  public nextIndex: number[]; // 各サーバーについて、次に送信するログエントリのインデックス（リーダーの最後のログインデックス + 1で初期化） (§5.3)
  public matchIndex: number[]; // 各サーバーについて、サーバー上で複製されたことが分かっている最

  public id: number;
  public state: ServerState;
  private database: Database;
  private network: Network;
  private peers: number[]; // 他のサーバーのIDの配列
  private electionTimeout: number;
  private heartbeatInterval: number;
  private electionTimer: NodeJS.Timeout | null = null;
  private heartbeatTimers: { [serverId: number]: NodeJS.Timeout } = {};

  constructor(id: number, network: Network, peers: number[]) {
    this.id = id;
    this.database = new Database(`./server-${id}.db`); // 各サーバーは個別のデータベースファイルを持つ
    this.network = network;
    this.peers = peers;
    this.electionTimeout = this.generateElectionTimeout(); // 150msから300msのランダムな値
    this.heartbeatInterval = 50; // ハートビートの送信間隔

    // 永続的な状態を初期化
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = [{ term: 0, command: null, index: 0 }]; // 便宜上、インデックス0にダミーのログエントリを追加

    // 揮発的な状態を初期化
    this.commitIndex = 0;
    this.lastApplied = 0;

    // リーダー選出のための状態を初期化（フォロワーとして開始）
    this.state = ServerState.Follower;

    // 永続的な状態をデータベースから読み込む
    this.loadPersistentState();

    // 選挙タイマーを開始
    this.resetElectionTimer();

    // 揮発的な状態（リーダー上）を初期化
    this.nextIndex = [];
    this.matchIndex = [];
  }

  // 永続的な状態をデータベースから読み込む
  private async loadPersistentState(): Promise<void> {
    try {
      const savedTerm = await this.database.loadMetadata("currentTerm");
      if (savedTerm) {
        this.currentTerm = Number.parseInt(savedTerm, 10);
      }

      const savedVotedFor = await this.database.loadMetadata("votedFor");
      if (savedVotedFor) {
        this.votedFor = Number.parseInt(savedVotedFor, 10);
      }

      const savedLogs = await this.database.loadLogs();
      if (savedLogs.length > 0) {
        this.log = savedLogs;
      }
    } catch (error) {
      console.error(`[Server ${this.id}] Error loading persistent state:`, error);
    }
  }

  // 永続的な状態をデータベースに保存する
  private async savePersistentState(): Promise<void> {
    try {
      await this.database.saveMetadata(
        "currentTerm",
        this.currentTerm.toString()
      );
      if (this.votedFor !== null) {
        await this.database.saveMetadata(
          "votedFor",
          this.votedFor.toString()
        );
      }
      // インデックス0を除いてログを保存
      for (const entry of this.log.slice(1)) {
        await this.database.saveLog(
          entry.index,
          entry.term,
          JSON.stringify(entry.command)
        );
      }
    } catch (error) {
      console.error(`[Server ${this.id}] Error saving persistent state:`, error);
    }
  }

  // 150msから300msのランダムな選挙タイムアウトを生成 (§5.1)
  private generateElectionTimeout(): number {
    return 150 + Math.floor(Math.random() * 151);
  }

  // 選挙タイマーをリセット
  private resetElectionTimer(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
    }
    // タイムアウト後に選挙を開始するタイマーを設定
    this.electionTimer = setTimeout(() => {
      this.startElection();
    }, this.electionTimeout);
  }

  // ハートビートタイマーをリセット
  private resetHeartbeatTimers(): void {
    for (const peerId of this.peers) {
      this.resetHeartbeatTimer(peerId);
    }
  }

  // 特定のサーバーへのハートビートタイマーをリセット
  private resetHeartbeatTimer(serverId: number): void {
    if (this.heartbeatTimers[serverId]) {
      clearTimeout(this.heartbeatTimers[serverId]);
    }
    // タイムアウト後にハートビートを送信するタイマーを設定
    this.heartbeatTimers[serverId] = setTimeout(() => {
      this.sendHeartbeat(serverId);
    }, this.heartbeatInterval);
  }

  // ハートビートを送信
  private sendHeartbeat(serverId: number): void {
    if (this.state === ServerState.Leader) {
      // ログの最後のインデックスを取得
      const lastLogIndex = this.log.length - 1;
      // ログの最後のインデックスのtermを取得
      const lastLogTerm = this.log[lastLogIndex].term;

      const args: AppendEntriesArgs = {
        term: this.currentTerm,
        leaderId: this.id,
        prevLogIndex: lastLogIndex,
        prevLogTerm: lastLogTerm,
        entries: [], // ハートビートの場合は空
        leaderCommit: this.commitIndex,
      };
      // ハートビートを非同期で送信し、結果を処理
      this.network
        .sendAppendEntries(this.id, serverId, args)
        .then((result) => {
          this.handleAppendEntriesResult(serverId, args, result);
        })
        .catch((error) => {
          // console.error(`[Server ${this.id}] Error sending heartbeat to server ${serverId}:`, error); // デバッグログ
        });
      // 次のハートビートをスケジュール
      this.resetHeartbeatTimer(serverId);
    }
  }

  // 選挙を開始 (§5.2)
  private startElection(): void {
    // 自分自身に投票
    this.state = ServerState.Candidate;
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.savePersistentState(); // 状態の変更をデータベースに保存
    this.resetElectionTimer(); // 自分のタイマーをリセット
    console.log(
      `[Server ${this.id}] Starting election for term ${this.currentTerm}`
    );

    // ログの最後のインデックスを取得
    const lastLogIndex = this.log.length - 1;
    // ログの最後のインデックスのtermを取得
    const lastLogTerm = this.log[lastLogIndex].term;

    // RequestVote RPCを送信
    let votesReceived = 1; // 自分自身からの票
    for (const peerId of this.peers) {
      const args: RequestVoteArgs = {
        term: this.currentTerm,
        candidateId: this.id,
        lastLogIndex: lastLogIndex,
        lastLogTerm: lastLogTerm,
      };
      // RequestVote RPCを非同期で送信し、結果を処理
      this.network
        .sendRequestVote(this.id, peerId, args)
        .then((result) => {
          if (this.state === ServerState.Candidate) {
            if (result.voteGranted) {
              votesReceived += 1;
              // 過半数の票を獲得した場合、リーダーになる
              if (votesReceived > (this.peers.length + 1) / 2) {
                console.log(
                  `[Server ${this.id}] Elected as leader for term ${this.currentTerm}`
                );
                this.becomeLeader();
              }
            } else if (result.term > this.currentTerm) {
              // より大きなtermを持つサーバーからの応答を受け取った場合、フォロワーに戻る
              console.log(
                `[Server ${this.id}] Stepping down from candidate in term ${this.currentTerm} due to higher term ${result.term} from server ${peerId}`
              );
              this.stepDown(result.term);
            }
          }
        })
        .catch((error) => {
          // console.error(`[Server ${this.id}] Error sending RequestVote to server ${peerId}:`, error); // デバッグログ
        });
    }
  }

  // リーダーになる (§5.2)
  private becomeLeader(): void {
    this.state = ServerState.Leader;
    // リーダーの揮発性状態を初期化
    this.nextIndex = this.peers.map(() => this.log.length);
    this.matchIndex = this.peers.map(() => 0);
    // ハートビートタイマーを開始
    this.resetHeartbeatTimers();
  }

  // フォロワーに戻る (§5.1)
  public stepDown(term: number): void {
    console.log(`[Server ${this.id}] Stepping down to follower in term ${term}`);
    this.state = ServerState.Follower;
    this.currentTerm = term;
    this.votedFor = null;
    this.savePersistentState(); // 状態の変更をデータベースに保存
    this.resetElectionTimer(); // 選挙タイマーをリセット
  }

  // RequestVote RPCを受信 (§5.1, §5.2, §5.4)
  public receiveRequestVote(
    args: RequestVoteArgs
  ): Promise<RequestVoteResult> {
    return new Promise(async (resolve) => {
      await this.savePersistentState(); // 非同期処理の前に状態を保存
      // console.log(`[Server ${this.id}] Received RequestVote from server ${args.candidateId}, term: ${args.term}, currentTerm: ${this.currentTerm}`); // デバッグログ

      // 1. リクエスのtermが現サーバーのcurrentTermより小さい場合、falseを返す (§5.1)
      if (args.term < this.currentTerm) {
        resolve({ term: this.currentTerm, voteGranted: false });
        return;
      }

      // より大きなtermを持つサーバーからのリクエストを受け取った場合、フォロワーに戻る
      if (args.term > this.currentTerm) {
        console.log(
          `[Server ${this.id}] Stepping down from currentTerm ${this.currentTerm} due to higher term ${args.term} from server ${args.candidateId}`
        );
        this.stepDown(args.term);
      }

      // 2. 既に他の候補者に投票している場合、または候補者のログが自身のログより新しくない場合、falseを返す (§5.2, §5.4)
      if (
        (this.votedFor === null || this.votedFor === args.candidateId) &&
        this.isLogUpToDate(args.lastLogIndex, args.lastLogTerm)
      ) {
        this.votedFor = args.candidateId;
        this.savePersistentState(); // 状態の変更をデータベースに保存
        this.resetElectionTimer(); // 投票したのでタイマーをリセット
        resolve({ term: this.currentTerm, voteGranted: true });
      } else {
        resolve({ term: this.currentTerm, voteGranted: false });
      }
    });
  }

  // 候補者のログが自身のログより新しいかどうかを判定 (§5.4)
  private isLogUpToDate(
    candidateLastLogIndex: number,
    candidateLastLogTerm: number
  ): boolean {
    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = this.log[lastLogIndex].term;

    // 最後のログエントリのtermで比較。termが同じ場合は、ログの長さで比較。
    return (
      candidateLastLogTerm > lastLogTerm ||
      (candidateLastLogTerm === lastLogTerm &&
        candidateLastLogIndex >= lastLogIndex)
    );
  }

  // AppendEntries RPCを受信 (§5.1, §5.3)
  public receiveAppendEntries(
    args: AppendEntriesArgs
  ): Promise<AppendEntriesResult> {
    return new Promise(async (resolve) => {
      await this.savePersistentState(); // 非同期処理の前に状態を保存
      // console.log(`[Server ${this.id}] Received AppendEntries from server ${args.leaderId}, term: ${args.term}, currentTerm: ${this.currentTerm}`); // デバッグログ

      // 1. リクエストのtermが現サーバーのcurrentTermより小さい場合、falseを返す (§5.1)
      if (args.term < this.currentTerm) {
        resolve({ term: this.currentTerm, success: false });
        return;
      }

      // より大きなtermを持つサーバーからのリクエストを受け取った場合、フォロワーに戻る
      if (args.term > this.currentTerm) {
        console.log(
          `[Server ${this.id}] Stepping down from currentTerm ${this.currentTerm} due to higher term ${args.term} from server ${args.leaderId}`
        );
        this.stepDown(args.term);
      }

      // 有効なリーダーからのAppendEntriesを受信したので、選挙タイマーをリセット
      this.resetElectionTimer();
      this.state = ServerState.Follower;

      // 2. prevLogIndexの位置にprevLogTermと一致するエントリがログにない場合、falseを返す (§5.3)
      if (
        args.prevLogIndex >= this.log.length ||
        this.log[args.prevLogIndex].term !== args.prevLogTerm
      ) {
        console.log(
          `[Server ${this.id}] AppendEntries failed: prevLogIndex ${args.prevLogIndex} does not match prevLogTerm ${args.prevLogTerm}`
        );
        resolve({ term: this.currentTerm, success: false });
        return;
      }

      // 3. 既存のエントリが新しいエントリと競合する場合（同じインデックスだが異なるtermを持つ場合）、その既存のエントリとそれに続く全てのエントリを削除する (§5.3)
      let logIndex = args.prevLogIndex + 1;
      for (const entry of args.entries) {
        if (
          logIndex < this.log.length &&
          this.log[logIndex].term !== entry.term
        ) {
          console.log(
            `[Server ${this.id}] Deleting conflicting entries from index ${logIndex}`
          );
          this.log.splice(logIndex); // 競合するエントリとそれ以降を削除
          await this.database.deleteLogsFromIndex(logIndex);
          break;
        }
        logIndex++;
      }

      // 4. まだログにない新しいエントリを追加する (§5.3)
      logIndex = args.prevLogIndex + 1;
      for (const entry of args.entries) {
        if (logIndex >= this.log.length) {
          entry.index = logIndex;
          this.log.push(entry);
          console.log(
            `[Server ${this.id}] Appending entry at index ${entry.index}, term ${entry.term}, command: ${JSON.stringify(entry.command)}`
          );
          await this.database.saveLog(
            entry.index,
            entry.term,
            JSON.stringify(entry.command)
          );
        }
        logIndex++;
      }

      // 5. leaderCommit > commitIndexの場合、commitIndexをmin(leaderCommit, 最後の新しいエントリのインデックス)に設定する (§5.3, §5.4)
      if (args.leaderCommit > this.commitIndex) {
        this.commitIndex = Math.min(args.leaderCommit, this.log.length - 1);
        // console.log(`[Server ${this.id}] Updated commitIndex to ${this.commitIndex}`); // デバッグログ
        this.applyEntries(); // コミットされたエントリをステートマシンに適用
      }

      resolve({ term: this.currentTerm, success: true });
    });
  }

  // AppendEntries RPCの結果を処理
  private handleAppendEntriesResult(
    serverId: number,
    args: AppendEntriesArgs,
    result: AppendEntriesResult
  ): void {
    if (this.state === ServerState.Leader) {
      if (result.success) {
        // AppendEntriesが成功した場合、nextIndexとmatchIndexを更新
        this.nextIndex[serverId] = args.prevLogIndex + args.entries.length + 1;
        this.matchIndex[serverId] = this.nextIndex[serverId] - 1;
        // console.log(`[Server ${this.id}] AppendEntries to server ${serverId} succeeded. nextIndex: ${this.nextIndex[serverId]}, matchIndex: ${this.matchIndex[serverId]}`); // デバッグログ

        // 過半数のサーバーがエントリを複製したかどうかを確認し、コミットを試みる
        for (
          let N = this.log.length - 1;
          N > this.commitIndex;
          N--
        ) {
          if (this.log[N].term === this.currentTerm) {
            let replicatedOn = 1; // リーダー自身は常にカウント
            for (const peerId of this.peers) {
              if (this.matchIndex[peerId] >= N) {
                replicatedOn += 1;
              }
            }

            if (replicatedOn > (this.peers.length + 1) / 2) {
              // 過半数のサーバーがエントリを複製した場合、コミット
              console.log(
                `[Server ${this.id}] Committing entry at index ${N}, term ${this.log[N].term}`
              );
              this.commitIndex = N;
              this.applyEntries(); // コミットされたエントリをステートマシンに適用
              break;
            }
          }
        }
      } else {
        // AppendEntriesが失敗した場合
        if (result.term > this.currentTerm) {
          // より大きなtermを持つサーバーからの応答を受け取った場合、フォロワーに戻る
          console.log(
            `[Server ${this.id}] Stepping down from leader in term ${this.currentTerm} due to higher term ${result.term} from server ${serverId}`
          );
          this.stepDown(result.term);
        } else {
          // ログの不整合が原因で失敗した場合、nextIndexをデクリメントして再試行
          console.log(
            `[Server ${this.id}] AppendEntries to server ${serverId} failed due to log inconsistency. Decrementing nextIndex from ${this.nextIndex[serverId]} to ${this.nextIndex[serverId] - 1}`
          );
          this.nextIndex[serverId]--;
          this.retryAppendEntries(serverId);
        }
      }
    }
  }

  // AppendEntriesの再試行
  private retryAppendEntries(serverId: number): void {
    const nextIndex = this.nextIndex[serverId];
    const prevLogIndex = nextIndex - 1;
    const prevLogTerm = this.log[prevLogIndex].term;
    const entries = this.log.slice(nextIndex); // nextIndex以降の全てのエントリ

    const args: AppendEntriesArgs = {
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    this.network
      .sendAppendEntries(this.id, serverId, args)
      .then((result) => {
        this.handleAppendEntriesResult(serverId, args, result);
      })
      .catch((error) => {
        // console.error(`[Server ${this.id}] Error retrying AppendEntries to server ${serverId}:`, error); // デバッグログ
      });
  }

  // コミットされたエントリをステートマシンに適用 (§5.3)
  private async applyEntries(): Promise<void> {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.log[this.lastApplied];
      // console.log(`[Server ${this.id}] Applying entry at index ${this.lastApplied}, term ${entry.term}, command: ${JSON.stringify(entry.command)}`); // デバッグログ

      if (entry.command) {
        // コマンドをデータベースに適用
        const { operation, key, value } = entry.command;
        try {
          if (operation === "set" && value) {
            await this.database.set(key, value);
            // console.log(`[Server ${this.id}] Applied 'set' operation: key=${key}, value=${value}`); // デバッグログ
          } else if (operation === "get") {
            const result = await this.database.get(key);
            // console.log(`[Server ${this.id}] Applied 'get' operation: key=${key}, result=${result}`); // デバッグログ
          }
        } catch (error) {
          console.error(
            `[Server ${this.id}] Error applying command at index ${this.lastApplied}:`,
            error
          );
        }
      }
    }
  }

  // クライアントからのリクエストを処理
  public async handleClientRequest(command: Command): Promise<string> {
    // console.log(`[Server ${this.id}] Received client request: ${JSON.stringify(command)}`); // デバッグログ
    if (this.state !== ServerState.Leader) {
      // リーダーでない場合、エラーを返す
      return Promise.reject(
        new Error(
          `Server ${this.id} is not the leader. Current state: ${this.state}`
        )
      );
    }

    // リーダーの場合、コマンドをログに追加
    const newEntry: LogEntry = {
      term: this.currentTerm,
      command,
      index: this.log.length,
    };
    this.log.push(newEntry);
    await this.database.saveLog(
      newEntry.index,
      newEntry.term,
      JSON.stringify(newEntry.command)
    );
    // console.log(`[Server ${this.id}] Appended client command to log at index ${newEntry.index}, term ${newEntry.term}`); // デバッグログ

    // 新しいエントリを他のサーバーに複製
    for (const peerId of this.peers) {
      this.replicateEntry(peerId, newEntry);
    }

    // クライアントへの応答は、エントリがコミットされた後に行う（ここでは省略）
    return `Request processed by leader ${this.id}. Entry index: ${newEntry.index}`;
  }

  // 新しいエントリを他のサーバーに複製
  private replicateEntry(serverId: number, entry: LogEntry): void {
    const nextIndex = this.nextIndex[serverId];
    const prevLogIndex = nextIndex - 1;
    const prevLogTerm = this.log[prevLogIndex].term;
    const entries = [entry];

    const args: AppendEntriesArgs = {
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    this.network
      .sendAppendEntries(this.id, serverId, args)
      .then((result) => {
        this.handleAppendEntriesResult(serverId, args, result);
      })
      .catch((error) => {
