# Raft KV Cluster Status

## Node Summary

| Node ID | Role | Term | Voted For | LogEntry Length | Commit Index  |
|---------|------|------|-----------|-----------------|---------------|
| node1 | follower | 1 | node2 | 1 |1 |
| node2 | leader | 1 | node2 | 1 |1 |
| node3 | follower | 1 | node2 | 1 |1 |

## Node Details

### Node node1

#### State

```json
{
  "role": "follower",
  "commitIndex": 1,
  "term": 1,
  "votedFor": "node2"
}
```

#### Log Entries

| Index | Term | Command |
|-------|------|---------|
| 1 | 1 | {"op":"noop"} |


Kv Store

```json
{}
```

### Node node2

#### State

```json
{
  "role": "leader",
  "commitIndex": 1,
  "term": 1,
  "votedFor": "node2"
}
```

#### Log Entries

| Index | Term | Command |
|-------|------|---------|
| 1 | 1 | {"op":"noop"} |


#### Leader State

| Node | Next Index | Match Index |
|------|------------|-------------|
| node1 | 2 | 1 |
| node3 | 2 | 1 |

Kv Store

```json
{}
```

### Node node3

#### State

```json
{
  "role": "follower",
  "commitIndex": 1,
  "term": 1,
  "votedFor": "node2"
}
```

#### Log Entries

| Index | Term | Command |
|-------|------|---------|
| 1 | 1 | {"op":"noop"} |


Kv Store

```json
{}
```

