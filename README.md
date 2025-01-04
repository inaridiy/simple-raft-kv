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

シングルノード:

```
pnpm tsx src/main.ts --config examples/single-node-config.json --nodeId node1 --port 4001
```

3 ノードクラスタ:

```
pnpm tsx src/main.ts --config examples/three-nodes-config.json --nodeId node1 --port 4001
pnpm tsx src/main.ts --config examples/three-nodes-config.json --nodeId node2 --port 4002
pnpm tsx src/main.ts --config examples/three-nodes-config.json --nodeId node3 --port 4003
```

## API の使用例

```
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
