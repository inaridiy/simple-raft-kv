# simple-raft-kv

Raft アルゴリズムの学習を目的とした TypeScript による実装です。
分散 KVS をベースに、Raft の基本的な機能（5+8 章）を実装しています。

## プロジェクト構造

```
src/
  core.ts      # Raftの主要なロジック
  types.ts     # 型定義
  utils.ts     # ユーティリティ関数
  storage.ts   # ストレージの実装
  main.ts      # HTTPサーバー
tests/         # セクション別のテスト
examples/      # 設定ファイルとHTTPリクエスト例
```

## 実行方法

### HTTP サーバー

```bash
pnpm install
cd examples/http
```

シングルノード:

```bash
pnpm tsx index.ts --config single-node-config.json --nodeId node1 --port 4001
```

3 ノードクラスタ:

```bash
pnpm tsx index.ts --config three-nodes-config.json --nodeId node1 --port 4001
pnpm tsx index.ts --config three-nodes-config.json --nodeId node2 --port 4002
pnpm tsx index.ts --config three-nodes-config.json --nodeId node3 --port 4003
```

## API の使用例

```bash
# 値のセット
POST http://localhost:4001/mutate
{
  "op": "set",
  "key": "foo",
  "value": "bar"
}

# 値の取得
POST http://localhost:4001/query
{
  "keys": ["foo"]
}
```
