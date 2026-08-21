# Milvus 全文检索引擎设计

> 状态:Draft(待评审)
> 日期:2026-08-19
> **实现基座:main 分支**(非 `feat-milvus-26-fulltext`)。旧分支仅作为 BM25 机制的参考(见 §3.2);本设计基于 main 直接实现,`version.ts` / `config.ts` / `textContents` 等仅存在于旧分支、在 main 上不存在,无需「删除」。旧分支 `fullTextRecall.ts` 的 `buildResultsFromRecallItems` 重构模式可参考采用。

## 1. 背景

FastGPT 当前全文检索基于 MongoDB `dataset_data_texts` 集合(`$text` 索引 + jieba 预分词),全文数据在数据写入时维护。

分支 `feat-milvus-26-fulltext` 引入 Milvus 2.6+ BM25 全文检索,但采用**单表方案**(在 vector 主表 `modeldata` 上追加 `text`/`sparse` 字段),并引入版本探测(`version.ts`)、feature level、动态 schema、运行时降级到 mongo 的复杂机制,且迁移(`initv4152`)依赖全量重嵌入。

本次需求变更核心:改用**方案 2(独立全文集合)**,去掉版本探测与降级,全文数据只存一份,并配套专门的全量迁移脚本。

## 2. 需求拆解

| # | 需求 | 设计落点 |
|---|------|----------|
| 1 | 全文检索库由 `FULL_TEXT_ENGINE` 指定,全文数据只存一份;milvus 不做版本探测,启动时探测、不支持则报错退出 | §4 环境变量、§5 全文集合、§8 启动探测 |
| 2 | 专门的全量迁移脚本:旧引擎配置参数传入,新引擎取 `FULL_TEXT_ENGINE`,从 A 全量迁移到 B | §9 迁移脚本 |
| 3 | 方案 2(独立全文集合);若 `FULL_TEXT_ENGINE=mongo`,vector 表 schema/index 与 main 一致;迁移 milvus→mongo 直接拷贝过去 | §3 总体方案、§5、§9 |
| 4 | 可靠性设计 | §10 可靠性 |
| 5 | 新增 milvus 语言识别器环境变量,默认 `lingua` | §4、§5.3 |
| 6 | 选型一(一表 vs 独立表):已确定**独立表**;选型二(全文插入的数据):环境变量可切换 `data` / `index` 两种粒度 | §5.2 |

## 3. 总体方案

```
                        ┌─────────────────────────────────────────────┐
                        │  FULL_TEXT_ENGINE = mongo(默认,main 现状)      │
                        │  全文数据 → MongoDB dataset_data_texts($text) │
                        │  检索     → $text + jieba                    │
                        └─────────────────────────────────────────────┘
                                        │ 切换
                                        ▼
                        ┌─────────────────────────────────────────────┐
                        │  FULL_TEXT_ENGINE = milvus                  │
                        │  全文数据 → Milvus 独立全文集合 modeldata_text │
                        │             (BM25 sparse,不写 mongo,只存一份) │
                        │  检索     → sparse BM25                      │
                        └─────────────────────────────────────────────┘

  Milvus vector 主表 modeldata:schema/index 恒为 main 现状
  (id / vector / teamId / datasetId / collectionId / createTime,不引入 text/sparse)
```

### 3.1 关键决策

测试数据见 3.4

1. **方案 2(独立全文集合)**:
   - vector 主表 `modeldata` 保持 main 的 schema/index **不变**,天然满足「`FULL_TEXT_ENGINE=mongo` 时 schema/index 与 main 一致」。
   - 全文数据放入独立集合 `modeldata_text`(仅 `FULL_TEXT_ENGINE=milvus` 时存在)。
   - 全文数据**只存一份**:engine=milvus 时**不再写** mongo `dataset_data_texts`;engine=mongo 时维持现状。
   - 缺点(已接受):不能使用 milvus `hybrid_search`;`teamId/datasetId/collectionId` 在全文集合中重复存储。后续如需 hybrid,可在全文集合基础上演进。

2. **选型二(全文集合插入的数据)**:由 `MILVUS_FULL_TEXT_SOURCE` 环境变量选择,默认 `data`。
   - `data`(等价「只存 dataset_data_texts」):每 `dataset_data` 一行,`text = q + '\n' + a`,主键 `dataId = dataset_data._id`。
   - `index`(等价「存 dataset_data.indexes[].text」):每个 index 一行,`text = indexes[].text`,主键 `vectorId = indexes[].dataId`,并冗余 `dataId = dataset_data._id` 便于按数据删除/反查。
   - 两个粒度共用**同一套集合 schema**(仅行内容与主键来源不同),切换粒度无需重建集合,只影响数据写入/检索归一化逻辑。



### 3.2 与旧分支实现的差异

| 项 | 旧分支(feat-milvus-26-fulltext) | 新设计 |
|---|---|---|
| vector 主表 | 追加 `text`/`sparse`(单表) | 保持 main 现状 |
| 版本机制 | `version.ts` feature level + 动态 schema + 运行时降级 | 不引入;启动时一次能力探测,不支持即退出 |
| 全文数据 | 随 vector 写入 `textContents`(每 index 文本) | 独立全文集合,`data`/`index` 粒度由 env 决定 |
| 检索 | milvus 返回 vectorId → `indexes.dataId` 反查 dataId | store 内部归一化,统一返回 `dataId` |
| 迁移 | `initv4152` 全量重嵌入(重建 collection + 训练任务) | `initFullTextMigrate` 从旧引擎索引直接拷贝/转换,不重嵌入 |

### 3.3 一致性原则与全文写入顺序(选型)

**一致性原则(先确立):** `dataset_data` 是数据唯一成功判据 ——「dataset_data 成功才算成功」。全文索引是**派生数据**,写入失败不阻塞数据操作,通过修复机制最终一致。main 现状在 mongo 会话内原子写 `dataset_data_texts`,天然满足"dataset_data 成功 ⇒ 全文成功";milvus 无法参与 mongo 事务,需明确写入顺序。

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. 统一后写(post-commit)** | mongo 与 milvus 统一在数据提交后,经统一 facade(`textStore.ts`)写入(幂等 upsert);失败置 `fullTextPending` + 修复任务 | 一条代码路径、一种时序;最符合"以 dataset_data 为保底";实现/维护最简 | mongo 由"会话内原子写"退化为"提交后尽力写",极端场景有短暂缺失(修复任务兜底,实际可忽略) |
| B. 先写(pre-write) | 数据写入前先写全文(`data` 粒度需预生成 ObjectId);失败则中止数据创建 | 数据创建成功 ⇒ 全文已存在,无缺失窗口;与现有"向量先写"模式一致 | 全文写失败阻塞数据创建(milvus 抖动直接导致用户写入失败);update 时数据回滚会残留"新"全文行(比缺失更难清理) |
| C. 先写 + 失败降级继续 | 先写全文,失败不阻塞、置标记后继续建数据 | 正常路径无缺失窗口;异常路径退化为方案 A 语义 | 需预生成 ObjectId;正常路径全文写在关键路径上;实现最复杂 |

**推荐:方案 A(统一后写)。** 理由:与"dataset_data 为保底"完全一致;单一时序才能支撑统一 facade(评审点 3);修复路径唯一。方案 B/C 的"无缺失窗口"优势在 FastGPT 场景(数据写入后一般不会立即全文检索)价值有限,而"全文写失败阻塞数据创建"或"update 残留新行"的代价更高。

**为何"残留新行"比"缺失"更难清理(对比当前已容忍的孤儿向量):** 当前 update 就是先写向量、后提交 `dataset_data`(`projects/app/src/service/core/dataset/data/data.ts` 的 `insertVectorForPatch` 在 `mongoSessionRun` 之前),事务回滚会残留**孤儿新向量**且已被容忍。但全文"残留新行"与孤儿向量性质不同 —— 孤儿向量是**存在级垃圾 + 引用失效**,全文残留行是**内容级错误 + 引用仍有效**,后者更致命:

| 对比 | 孤儿新向量(当前已容忍) | 残留新全文行(方案 B) |
|---|---|---|
| 回滚后状态 | 新向量在向量库,不被任何 `dataset_data.indexes` 引用 | 全文行 dataId 存在、text=新内容,被真实存在的 `dataset_data` 引用 |
| 检索命中后 | vectorId → 反查 `indexes` 找不到 → 下游打日志跳过,**无害** | dataId → 反查 `dataset_data` 找得到 → 返回**内容错位**的活跃错结果 |
| 清理判据 | **存在性判断**(vectorId 是否在 indexes 中)→ 现有孤儿向量扫描可认出 | **存在性判断失效**(dataId 有效)→ 需内容比对;全文行只存 token 不存原文,难自动比对 |

> 附带说明:当前 mongo 全文是**事务内原子写**(`MongoDatasetDataText.updateOne` 在 session 内),回滚不会残留。方案 B 会让 mongo 全文退化为预写非事务,凭空引入一个现有代码里不存在的残留方向;方案 A 的代价只是"提交后短暂缺失 + 修复任务补齐"。
> 补充说明：MILVUS_FULL_TEXT_SOURCE使用data还是index，还需要测试决定，先按照方案A实现。

**写顺序确定后 ⇒ 决定增加 `createTime`:** 全文集合增加 `createTime`(Int64),用于清理**残留无用数据**(悬空行:数据回滚后残留的全文行、删除失败残留的行)。清理任务按 `createTime < now - TTL` 分页扫描,`dataId` 反查 `dataset_data` 不存在即删除;同时便于运维定位。→ §5.2 已纳入。

### 3.4 命中率对比

> 命中率定义:固定查询集下,检索返回结果中相关命中的比例(记录时注明数据集规模与查询集条数,便于横向对比)。数值待基准测试填充(§3.3 补充说明),用于收口两个决策:①milvus 相对 mongo 的命中表现;②`MILVUS_FULL_TEXT_SOURCE` 取 `data`(整条 `q+a` 一行,与 mongo 语义一致)还是 `index`(每个 `indexes[].text` 一行)。

**表一:mongo vs milvus(检索引擎对比,`MILVUS_FULL_TEXT_SOURCE=data`)**

| 测试场景 | 说明 | mongo 命中率 | milvus(data) 命中率 | 备注 |
|---|---|---|---|---|
| 中文短语(2~4 字) | 如「全文检索」 | - | - | |
| 中文长句 | 整句作为查询 | - | - | |
| 英文单词/短语 | | - | - | |
| 中英混合 | | - | - | |
| 专业术语/生僻词 | jieba / BM25 分词未覆盖 | - | - | |
| 长文本截断 | 超长 text 截断边界 | - | - | |
| 英文-智能客服（3w data、200w index） | FAQ | Hit@1: 63/268=23.51%</br>Hit@10: 154/268=57.46%</br>Hit@50: 167/268=62.31% | Hit@1: 79/268=29.48%</br>Hit@10: 168/268=62.69%</br>Hit@50: 206/268=76.87% | 提升:</br>Hit@1 +5.97pp</br>Hit@10 +5.23pp</br>Hit@50 +14.56pp |

**表二:milvus `data` 粒度 vs `index` 粒度(全文集合数据粒度对比,用于决定 `MILVUS_FULL_TEXT_SOURCE`)**

| 测试场景 | 说明 | milvus(data) 命中率 | milvus(index) 命中率 | 备注 |
|---|---|---|---|---|
| 中文短语(2~4 字) | `data` 粒度 text = `q+a`;`index` 粒度 text = `indexes[].text` | - | - | |
| 中文长句 | | - | - | |
| 英文单词/短语 | | - | - | |
| 中英混合 | | - | - | |
| 专业术语/生僻词 | | - | - | |
| 长文本截断 | | - | - | |
| 英文-智能客服 | FAQ | Hit@1: 79/268=29.48%</br>Hit@10: 168/268=62.69%</br>Hit@50: 206/268=76.87% | Hit@1: 114/268=42.54%</br>Hit@10: 200/268=74.63%</br>Hit@50: 218/268=81.34% | |

> 观察点(非结论,待数据填充后定论):`data` 粒度与 mongo 语义一致、迁移对称、实现最简(§3.1 已暂定默认);`index` 粒度将长文本拆为多行,理论上对「长文本内局部命中」更友好,但引入 `vectorId→dataId` 反查与多行删除的复杂度。两表数据填充后,§3.1 选型二与 §13 开放问题一并收口。

## 4. 环境变量设计

`packages/service/env.ts`:

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `FULL_TEXT_ENGINE` | `mongo` \| `milvus` | `mongo` | 全文检索引擎 |
| `MILVUS_LANGUAGE_IDENTIFIER` | `lingua` \| `whatlang` | `lingua` | milvus 语言识别引擎(BM25 analyzer) |
| `MILVUS_FULL_TEXT_SOURCE` | `data` \| `index` | `data` | milvus 全文集合数据粒度(仅 engine=milvus 生效) |

校验规则:
- `FULL_TEXT_ENGINE` 非法值 → 启动报错退出(不再像旧分支「非法值按 mongo 处理」)。理由:引擎是运维显式声明的,静默降级会掩盖配置错误。
- `MILVUS_LANGUAGE_IDENTIFIER`、`MILVUS_FULL_TEXT_SOURCE` 非法值 → 启动报错退出。
- `FULL_TEXT_ENGINE=milvus` 但未配置 `MILVUS_ADDRESS` → 启动报错退出。
- `MILVUS_FULL_TEXT_SOURCE` 仅在 engine=milvus 时读取;engine=mongo 时忽略(全文数据形态固定为 mongo 现状)。

## 5. Milvus 全文集合

### 5.1 表名与数据库

- 表名:`modeldata_text`(`DatasetVectorTextTableName`,新增常量,沿用 `DatasetVectorTableName = 'modeldata'` 的命名风格)。
- 数据库:与 vector 表相同(默认 `fastgpt`)。

### 5.2 Schema(统一,两种粒度共用)

字段:

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | VarChar PK (64) | 主键。`data` 粒度 = `dataset_data._id`(mongo ObjectId,24 位 hex,如 `68ad85a7463006c963799a05`);`index` 粒度 = `indexes[].dataId`(milvus Int64 向量 id 的字符串,16 位数字,如 `1234567890123456`)。两者格式不同但均为 ASCII 且 ≤64,共用同一列 |
| `dataId` | VarChar (64) | 恒为 `dataset_data._id`。`data` 粒度与主键同值(便于统一处理);`index` 粒度用于按数据删除与反查 |
| `text` | VarChar (65535),`enable_analyzer` + `enable_match` | BM25 输入文本。`data` 粒度 = `q + '\n' + a`;`index` 粒度 = `indexes[].text`。超长截断(沿用 `MILVUS_TEXT_MAX_LENGTH` 常量) |
| `sparse` | SparseFloatVector | BM25 输出稀疏向量 |
| `createTime` | Int64 | 写入时间(毫秒)。用于残留悬空行清理(§3.3)与运维定位 |
| `teamId` / `datasetId` / `collectionId` | VarChar (64) | 归属信息,用于检索过滤与批量删除 |

Function(BM25):`text` → `sparse`(`FunctionType.BM25`)。

Index:

| 字段 | index_type | 说明 |
|---|---|---|
| `sparse` | `SPARSE_INVERTED_INDEX`,metric `BM25`,params `{ bm25_k1: 1.2, bm25_b: 0.75 }` | 全文检索 |
| `dataId` | `Trie` | 按数据删除 / 反查 |
| `createTime` | `STL_SORT` | 残留数据清理扫描 |
| `teamId` / `datasetId` / `collectionId` | `Trie` | 过滤 / 批量删除 |

> `dataId` 上不加 `enable_match`,仅 `text` 字段需要 analyzer。

### 5.3 Analyzer(language_identifier)

由 `MILVUS_LANGUAGE_IDENTIFIER` 决定识别引擎与 analyzer key 映射:

| 识别引擎 | 中文 key | 配置 |
|---|---|---|
| `lingua`(默认) | `Chinese` | `Chinese: { tokenizer: 'jieba' }` |
| `whatlang` | `Mandarin` | `Mandarin: { tokenizer: 'jieba' }` |

```ts
// 构造 analyzer params(env → 常量,仅此一处)
const buildAnalyzerParams = (identifier: 'lingua' | 'whatlang') => ({
  tokenizer: {
    type: 'language_identifier',
    identifier,
    analyzers: {
      default: { tokenizer: 'standard' },
      English: { type: 'english' },
      ...(identifier === 'lingua'
        ? { Chinese: { tokenizer: 'jieba' } }
        : { Mandarin: { tokenizer: 'jieba' } })
    }
  }
});
```

> 注意:两个识别引擎对同一语言返回的名字不同(`Mandarin` vs `Chinese`),analyzer key 必须与识别引擎输出精确匹配,否则中文回落到 `standard` 分词导致召回退化。这是 milvus 2.6 的已知行为(见 milvus 官方语言识别器文档)。

> 本设计使用**单一 `language_identifier` analyzer**(基于 main 实现,不引入旧分支的 `analyzerConfigs` 降级链)。启动时已探测能力,不支持即退出,因此无需降级链。

## 6. 写入链路

### 6.1 统一全文接口(textStore.ts)

全文检索统一接口封装在 `packages/service/core/dataset/data/textStore.ts`(评审点 3):

- 定义:`FullTextStore` 接口、`FullTextWriteProps`、`FullTextSearchProps`、`FullTextSearchItem`。
- `MongoFullTextStore`:mongo 引擎实现(基于现有 `MongoDatasetDataText`,按 §3.3 方案 A 统一为提交后幂等写)。
- `getFullTextStore(): FullTextStore`:按 `FULL_TEXT_ENGINE` 返回 mongo 或 milvus 实现。
- milvus 实现 `MilvusFullTextStore` 仍放 `packages/service/common/vectorDB/milvus/fullText.ts`(内部按 `MILVUS_FULL_TEXT_SOURCE` 分支粒度)。

**循环引用检查**:`milvus/fullText.ts` 对 `textStore.ts` 仅 **type-only import**(`import type { FullTextStore, ... }`),运行时被擦除;`textStore.ts` 对 `milvus/fullText.ts` 是值导入。运行时依赖图单向(`textStore → milvus/fullText`),**无运行时循环**。

### 6.2 FullTextStore 接口

```ts
// textStore.ts
export type FullTextWriteProps = {
  teamId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;                                     // dataset_data._id
  text?: string;                                      // data 粒度:q + '\n' + a
  indexes?: { vectorId: string; text: string }[];     // index 粒度:indexes[].text
};

export type FullTextSearchProps = {
  teamId: string;
  datasetIds: string[];
  query: string;
  limit: number;
  forbidCollectionIdList: string[];
  filterCollectionIdList?: string[];
};

export type FullTextSearchItem = {
  dataId: string;      // dataset_data._id —— 两种粒度统一归一化后返回
  collectionId: string;
  score: number;
};

export interface FullTextStore {
  init(): Promise<void>;                            // 建集合 + 建索引 + 加载 + 能力探测(§8)
  write(props: FullTextWriteProps[]): Promise<void>;  // 批量写入,内部按 FULL_TEXT_WRITE_BATCH_SIZE(=50)分片
  // data 粒度:片内 upsert;index 粒度:片内 delete(filter dataId in [...]) + insert
  deleteByDataId(dataId: string): Promise<void>;
  // 批量删除的 filter 与现有调用点对齐(见 §6.3)
  deleteByDatasetIds(props: { teamId: string; datasetIds: string[] }): Promise<void>;
  deleteByCollectionIds(props: {
    teamId: string;
    datasetIds: string[];
    collectionIds: string[];
  }): Promise<void>;
  search(props: FullTextSearchProps): Promise<FullTextSearchItem[]>;
}
```

> 检索结果统一返回 `dataId`(两种粒度都在 store 内部归一化),**不用** `EmbeddingRecallItemType[]`(`id` 字段会混淆 dataId / vectorId)(评审点 2)。
>
> `write` 接收**数组**:批量写入,内部按 `FULL_TEXT_WRITE_BATCH_SIZE`(=50,常量置于 `common/vectorDB/constants.ts`,mongo `bulkWrite` 与 milvus `upsert`/`insert` 共用同一上限)分片;数据路径的单条调用由 facade 层 `writeFullText` 包装为 `[props]`。一次分片调用(一次 upsert / delete+insert)即原子单元,失败粒度 = 50 片 —— 迁移脚本据此收集失败行(§9.3/§9.4)。

粒度差异:

| 操作 | `data` 粒度 | `index` 粒度 |
|---|---|---|
| write(批量,内部按 50 分片) | 片内 `upsert` 1 行/数据,`id = dataId`,`text = q+a` | 片内 `delete`(filter `dataId in [...]`)+ `insert` N 行,`id = vectorId`,`text = index.text`,每行 `dataId = dataset_data._id` |
| search | 返回主键即 `dataId` | 返回 `vectorId` → 批量查 mongo `{ 'indexes.dataId': { $in: vectorIds } }` 反查 `dataset_data._id` |
| deleteByDataId | `delete`(filter `id == dataId`) | `delete`(filter `dataId == dataId`) |
| 幂等 | upsert 天然幂等 | 删后插,整体幂等 |

两种粒度的 `search` 都归一化为 `FullTextSearchItem`(携带 `dataId`),recall 层不感知粒度。

### 6.3 写点改造(统一 facade,按 §3.3 方案 A 后写)

数据增删改后统一调用 `getFullTextStore()`(mongo / milvus)的对应方法,不再在数据路径内直接操作 `MongoDatasetDataText`:

| 写点 | 文件 | 调用 |
|---|---|---|
| data 创建 | `projects/app/src/service/core/dataset/data/data.ts` `create` | `write([{ dataId, text: q+a }])`(`data` 粒度)或 `write([{ dataId, indexes }])`(`index` 粒度) |
| q/a 更新 | 同上 `update`(两处) | `write([...])`(upsert / 删+插) |
| data 删除 | 同上 `delete` | `deleteByDataId(dataId)` |
| 按 collection 删除 | `packages/service/core/dataset/collection/controller.ts` | `deleteByCollectionIds({ teamId, datasetIds, collectionIds })` |
| 按 dataset 删除 | `packages/service/core/dataset/controller.ts` | `deleteByDatasetIds({ teamId, datasetIds })` |

> mongo 实现内部仍写 `dataset_data_texts`(jieba(q+a),按 dataId upsert),但时序从"会话内原子写"改为"提交后尽力写"(§3.3 方案 A),与 milvus 一致;一致性由 §10 修复任务兜底。
>
> `index` 粒度创建时依赖 `indexOperation.insertVectors` 返回的 `{ dataId, text }`,data.ts `create/update` 流程中可得(`newIndexes`),无需向向量控制器回传文本 → 向量控制器接口**不新增** `textContents`(main 现状即是纯向量写入,保持不动)。

### 6.4 一致性顺序与落点(§3.3 方案 A)

milvus 无法参与 mongo 事务,按 §3.3 方案 A,全文写入统一为**数据提交后的幂等异步侧写**,不进入 mongo 事务:

```
create 流程:insertVectors(向量先写)→ MongoDatasetData.create(提交)→ 全文 write(紧接其后,facade,不接收 session)
update 流程:mongoSessionRun(更新 data + 向量)→ 全文 write(删旧 + 插新)
delete 流程:mongoSessionRun(删 data)→ 全文 delete
```

落点钉死(评审补充):
- `createDatasetData` 的调用方 `insertData.ts` **不传 session**(自动提交)、`generateVector.ts` **会传 session**(外层 `mongoSessionRun`)。全文 write 统一在数据提交后执行(facade 内不接收 session),mongo 与 milvus **同时序**。
- 顺序语义:若外层 session 在 create() 返回后回滚(如 generateVector 后续步骤失败),会残留悬空全文行——**无害**(检索时 `buildResultsFromRecallItems` 对缺失 data 打日志并跳过),由 §3.3 的 `createTime` 清理任务回收;若全文 write 失败而数据提交成功 → 缺全文行,由 `fullTextPending` 修复任务补齐。两个方向都有兜底。
- 故障域:全文 write 失败**不影响数据操作结果**(仅记录 + 置标记),符合「dataset_data 成功才算成功」。

## 7. 检索链路

改造 `packages/service/core/dataset/search/defaultRecall/fullTextRecall.ts`(基于 main,main 当前只走 mongo 聚合):

1. **重构**:抽出 `mongoFullTextRecall`(现有 mongo 聚合)+ `buildResultsFromRecallItems`(现有 data/collection 回查与结果组装,参考旧分支已提炼的模式),保持 mongo 行为不变。
2. **按 `getFullTextEngine()` 分支**:
   - `mongo` → 走 `MongoFullTextStore.search` + `buildResultsFromRecallItems`。
   - `milvus` → 走 `MilvusFullTextStore.search`。
   - 两种实现都经统一 facade 返回 `FullTextSearchItem[]`(`{ dataId, collectionId, score }`,已归一化),recall 层直接映射到 `RecallItem` 后走同一个 `buildResultsFromRecallItems`。
3. **不引入**旧分支的 `computeUseMilvusFullText` 版本检查与运行时降级:milvus 不可用(未配置/不支持)在启动时已报错退出,不存在运行时回落 mongo。
4. `vectorId → dataId` 反查(`index` 粒度需要)**内聚到 store 内**,recall 层不感知粒度。

检索 filter 沿用现状:`(teamId == X) and (datasetId in [...]) [collectionId in/not in ...]`,`anns_field: 'sparse'`,`params: { metric_type: 'BM25' }`,`output_fields: ['collectionId']`(主键即 dataId/vectorId)。

## 8. 启动初始化与能力探测

`MilvusFullTextStore.init()`(engine=milvus 时,在 `projects/app/src/instrumentation-node.ts` 的 `init-vector-store` 步骤内与 vector store 一并执行):

1. `getClient()`:`MILVUS_ADDRESS` 未配置 → throw(启动失败)。
2. `useDatabase` + `hasCollection` → 不存在则 `createCollection`(BM25 function + language_identifier analyzer + index),再 `loadCollection`。
3. **能力探测**:`describeCollection` 校验 `text`/`sparse` 字段存在;SDK 在 milvus < 2.6 或 analyzer 不支持时抛错(`ANALYZER_NOT_SUPPORTED` 等)。
4. 探测失败 → `logger.error` + 抛出 → 启动流程记录 `VECTORDB_ERROR` → **进程退出**(复用现有 `runInitializationStep` 机制)。

> 基于 main 实现,无旧分支的 `version.ts`/`supportsFullText` 动态 schema/`analyzerConfigs` 降级链需要删除;唯一需要同步的是 SDK 升级(§11)可能引入的 API 适配(如 `embRecall` 的 `searchParams.data` 而非 `vector`)。

## 9. 全量迁移脚本(Admin API)

### 9.1 接口

`GET /api/admin/initFullTextMigrate`(`authCert({ authRoot: true })`,与 `initv4152` 同模式)

Query 参数(旧引擎配置):

| 参数 | 必填 | 说明 |
|---|---|---|
| `oldEngine` | 是 | `mongo` \| `milvus`(旧引擎) |
| `oldMilvusAddress` / `oldMilvusToken` | oldEngine=milvus 时 | 旧 milvus 连接 |
| `batchSize` | 否 | 默认 500 |
| `dryRun` | 否 | `true`/`1` 时只统计不写入 |
| `removeOld` | 否 | `true`/`1` 时迁移校验通过后删除旧引擎索引 |

新引擎:从 `serviceEnv.FULL_TEXT_ENGINE` 读取(进程内配置)。

### 9.2 迁移语义(归一化 + 按目标粒度写入)

迁移将源数据归一化为 `{ dataId, text }` 单元(数据粒度的唯一文本来源是 `dataset_data` 的 `q+a` 或 `indexes[].text`),再按**目标引擎 + 目标粒度**写入:

| 源 → 目标 | 读取 | 写入 |
|---|---|---|
| mongo → milvus(`data`) | 遍历 `dataset_data_texts` 取 dataId(旧索引清单),join `dataset_data` 取 `q+a` | 批量 upsert(按 `FULL_TEXT_WRITE_BATCH_SIZE` 分片),`id=dataId` |
| mongo → milvus(`index`) | 遍历 `dataset_data`(或 `dataset_data_texts` 的 dataId) | 分片 delete-by-dataId(`dataId in [...]`) + insert N 行/`data`(`id=vectorId`,`text=indexes[].text`) |
| milvus(`data`) → mongo | 遍历 `modeldata_text` 行(`dataId`,`text=q+a`) | **直接拷贝**:`jiebaSplit(text)` 后写 `dataset_data_texts`(按 dataId upsert) |
| milvus(`index`) → mongo | 遍历 `modeldata_text` 取唯一 `dataId`,join `dataset_data` 取 `q+a` | 同上(jieba(q+a)) |
| milvus(`data`) → milvus(`index`) 或反向 | 遍历源集合行 | 按目标粒度重构后写入 |

说明:
- 「milvus → mongo 直接拷贝过去」在 `data` 粒度下成立(源行已含 `q+a`,仅需重新 jieba 分词为 mongo 格式);`index` 粒度下需 join `dataset_data` 重构 `q+a`(mongo 全文索引形态固定为每 data 一条)。
- 目标写入全部按 `dataId` **幂等**(mongo `updateOne` upsert;milvus `upsert` / delete+insert),重复执行安全。
- 不重嵌入、不触发训练任务,纯索引搬运。

### 9.3 流程、断点续跑与迁移期间新数据

**流程:**
1. 校验:引擎与参数合法性、新旧引擎不同、目标引擎能力探测(§8)。
2. 统计:源行数、预估批次数(`dryRun` 只读返回)。
3. 分批搬运 + 进度持久化(见下"断点续跑");失败行收集并继续。
4. 计数校验:结束后比对源/目标行数,不一致则报错并给出差异清单。
5. `removeOld`:校验通过后删除源索引(支持仅留日志审计)。

**断点续跑(光标):**
- 进度记录在 `full_text_migration_logs`(schema 见 §9.4):`{ migrationId, oldEngine, newEngine, status: 'running'|'done'|'failed', cursor, totalCount, processedCount, skippedCount, failedCount, error, updatedAt, createdAt }`,每批提交后按 `migrationId` `updateOne`。
- 光标语义:源按**可排序键**递增分页:
  - mongo 源:`dataset_data_texts._id`(ObjectId,随插入递增)→ `find({ _id: { $gt: cursor } }).sort({ _id: 1 }).limit(batchSize)`。
  - milvus 源:全文行 `dataId` 恒为 `dataset_data._id`(ObjectId 字符串,字典序 = 插入序)→ `filter: "dataId > cursor"` + `limit`(两种粒度均适用,`data` 粒度 `id == dataId`,`index` 粒度有 `dataId` 字段)。
- 续跑:再次调用带 `resumeMigrationId`,读 `status='running'|'failed'` 的记录从 `cursor` 继续;无记录则全量重跑。**幂等兜底**:目标写按 dataId upsert,光标即使回退/重复,重写也不产生重复数据。
- 失败处理:失败行(50 片级)持久化到 `full_text_migration_failed`(§9.4,按 dataId upsert,`bulkWrite` ordered:false),失败行**全部落库**(设计初稿的「超上限才落库」取消,行级失败量级可控,落库让续跑与审计都精确);批次内对失败片统一重试一次,仍失败保留,主循环结束后再逐条自愈重试(§9.4 消费),仍失败则保留待续跑补齐。

**迁移期间新数据(评审点 5):**
- **推荐操作顺序:先切引擎,再迁移**。切引擎后:
  - 新数据经 live 写路径直接写**目标**引擎(只存一份),不再进入旧引擎源 → 迁移源是固定快照。
  - 迁移写目标与 live 写目标均按 `dataId` upsert,且 **dataId 不相交**(源只含切引擎前的老数据),无重复/冲突。
- **迁移失败 + 期间有新数据**:迁移是幂等 upsert,**重跑安全**;新数据 dataId 不在源中,重跑不会触碰它们。
- **唯一竞态**:迁移扫描到的某个 dataId 恰在迁移期间被 live **更新**(目标先写新文本,迁移随后写旧文本)→ 窗口极窄;自愈路径:该数据下次任何更新会重写全文,或迁移跑完后再跑一次作为一致性收尾(幂等)。文档注明:迁移建议在低写入时段执行。

### 9.4 迁移状态表与失败行表(`full_text_migration_logs` / `full_text_migration_failed`)

两个集合都建在默认 mongo 连接,**不参与业务事务**(迁移本身是分批外置写,进度与失败行独立持久化,与数据主库解耦)。schema 集中在 `packages/service/core/dataset/fullText/schema.ts`,均由 `getMongoModel` 生成模型。

**表一 `full_text_migration_logs` — 迁移进度 / 断点日志(每迁移实例一行)**

| 字段 | 类型 | 说明 |
|---|---|---|
| `migrationId` | string(UUID,唯一) | 迁移实例 ID,断点续跑凭此恢复;非 dry-run 且无 `resumeMigrationId` 时 `create` |
| `oldEngine` / `newEngine` | `'mongo'` \| `'milvus'` | 源 / 目标引擎,续跑时校验与本次请求一致,不一致报错(防错续) |
| `status` | `'running'` \| `'done'` \| `'failed'` | 默认 `running`;全部成功且计数校验通过为 `done`,有失败行或计数不一致为 `failed` |
| `cursor` | string | 断点光标(已处理源行的上界)。mongo 源:`dataset_data_texts._id`;milvus 源:批内最大 `dataId`。空串 = 从头全量 |
| `totalCount` | number | 起始源行数。mongo 源续跑时 = cursor 之后剩余行数;milvus 源 = 行数(含 index 粒度重复行,仅信息展示) |
| `processedCount` | number | 已成功写入目标的行数(续跑自愈成功也会回填) |
| `skippedCount` | number | 跳过行数(非法 ObjectId、`dataset_data` 已删除的孤儿行) |
| `failedCount` | number | 失败行数(仍留在 failed 表,等续跑补齐) |
| `error` | string(optional) | 失败原因摘要。当前实现经返回值携带最终错误,日志行字段预留;如需审计可随收尾 `updateOne` 一并落库 |
| `createdAt` / `updatedAt` | Date | 审计与实例存活判断 |

索引:

| 索引 | 类型 | 作用 |
|---|---|---|
| `{ migrationId: 1 }` | **unique** | 续跑 `findOne({ migrationId })`;同一实例并发重入由唯一键约束阻止(重复 `create` 抛 duplicate) |
| `{ status: 1, updatedAt: 1 }` | 普通 | 运维查询进行中 / 历史迁移;`updatedAt` 长时间未推进可判定迁移进程已死,可人工接管续跑 |

生命周期:
1. 非 dry-run 且无 `resumeMigrationId`:`create`(status=`running`,cursor='');续跑沿用已有行,不新建。
2. 每批搬运后:`updateOne({ migrationId }, { $set: { cursor, processedCount, skippedCount, failedCount, updatedAt } })`——断点随每批落盘,进程中途被杀,下次从 `cursor` 续,不重复不遗漏。
3. 收尾:先消费 failed 表(见下),再按最终结果置 `done`/`failed` 并更新最终计数;历史日志保留供审计,不做自动清理。

**表二 `full_text_migration_failed` — 失败行(失败一次记录一行)**

| 字段 | 类型 | 说明 |
|---|---|---|
| `migrationId` | string | 归属迁移实例 |
| `dataId` | string | 失败行对应的 `dataset_data._id`(ObjectId 字符串) |
| `error` | string | 失败原因(便于续跑后人工核查) |
| `createdAt` | Date | 失败时间 |

索引:`{ migrationId: 1, dataId: 1 }` **unique** —— 批量 upsert 幂等(`updateOne` filter `{ migrationId, dataId }` + `$set` error + upsert,`bulkWrite` `{ ordered: false }`):同 dataId 重复失败只更新 error、不产生重复行;自愈成功后按同键 `deleteOne`。

生命周期:
1. **写入**:批次内某 50 片失败(片内整片收集),`bulkWrite` upsert 落库。全部失败都持久化,不做行数上限截断(设计初稿的「超上限才落库」取消——行级失败量级可控,且落库后续跑与审计都精确)。
2. **消费(续跑自愈)**:主循环结束后读本 `migrationId` 全部失败行,逐条重试:
   - 成功 → `deleteOne` + `processedCount+1` + `failedCount-1`(自愈行自动移出失败表,计数回填);
   - `dataset_data` 已删除(孤儿)→ 视为跳过,`deleteOne` + `skippedCount+1`;
   - 仍失败 → 保留,最终 `status='failed'`,返回提示带 `resumeMigrationId` 再跑。
3. 集合无行数上限(失败即记);实例迁移成功后自愈行清空,无残留,天然收敛。

> 两表分工:logs 表回答「迁到哪、剩多少、从哪续」,failed 表回答「哪几行失败了、原因是什么」。续跑 = 读 logs 的 cursor 继续主循环 + 读 failed 表逐条补齐,两表协同构成完整的断点续跑语义(§9.3)。

## 10. 可靠性设计

| 场景 | 措施 |
|---|---|
| 全文写入失败(数据已提交) | retryFn(重试+退避);持续失败 → 置 `dataset_data.fullTextPending: true`,日志告警 |
| 修复 | 新增定时修复任务(挂到 `cronTask.ts` 或独立 cron):扫描 `fullTextPending` 的 data,按当前粒度重写全文行(源 = dataset_data),成功后清除标记 |
| 删除失败/悬空行 | 删除走 retryFn;残留悬空行对检索**无副作用**(`buildResultsFromRecallItems` 已对缺失 data/collection 打日志并跳过);新增**残留清理任务**(挂 `cronTask.ts`):按 `createTime < now - TTL`(默认 7 天)分页扫描全文集合,`dataId` 反查 `dataset_data` 不存在即删除(§3.3) |
| 写入幂等 | `data` 粒度 upsert(PK=dataId);`index` 粒度 delete-by-dataId + insert(整体幂等) |
| 迁移 | dry-run、断点续跑、幂等写入、计数校验、失败收集、`removeOld` 后校验 |
| 启动探测 | engine=milvus 不支持 BM25/analyzer → 报错退出,杜绝带病运行 |
| 一致性边界(已接受) | milvus 全文索引与 mongo 数据是最终一致(非事务);召回窗口内可能短暂缺失新数据,由修复任务兜底 |

## 11. 文件改动清单(基于 main)

**新增**
- `packages/service/core/dataset/data/textStore.ts` — 统一全文接口:`FullTextStore` / `FullTextWriteProps` / `FullTextSearchProps` / `FullTextSearchItem` + `MongoFullTextStore`(mongo 实现)+ `getFullTextStore()`(按 `FULL_TEXT_ENGINE` 分发)(§6.1/§6.2)
- `packages/service/common/vectorDB/milvus/fullText.ts` — `MilvusFullTextStore` + `getMilvusFullTextStore`(粒度分支、检索归一化、能力探测);对 `textStore.ts` 仅 type-only import
- `packages/service/common/vectorDB/milvus/fullTextConfig.ts` — 全文集合 schema / index / BM25 function / analyzer(`MILVUS_LANGUAGE_IDENTIFIER` 映射)
- `projects/app/src/pages/api/admin/initFullTextMigrate.ts` — 全量迁移脚本(§9)
- `packages/service/core/dataset/fullText/repair.ts` — 定时修复任务(扫描 `fullTextPending`)
- 常量:`DatasetVectorTextTableName = 'modeldata_text'`;`FULL_TEXT_WRITE_BATCH_SIZE = 50`(全文批量写入分片上限,置于 `common/vectorDB/constants.ts`,§6.2)
- mongo `full_text_migration_logs` / `full_text_migration_failed` schema(迁移断点进度、失败行,§9.4)

**修改**
- `packages/service/package.json` — `@zilliz/milvus2-sdk-node` `2.4.10` → `^2.6.0`(BM25 function / `FunctionType.BM25` / language_identifier 支持),并适配 SDK 2.6 API 变更
- `packages/service/env.ts` — 新增 `MILVUS_LANGUAGE_IDENTIFIER`(默认 `lingua`)、`MILVUS_FULL_TEXT_SOURCE`(默认 `data`);`FULL_TEXT_ENGINE` 非法值改为启动报错
- `packages/service/common/vectorDB/milvus/index.ts` — 适配 SDK 2.6(`embRecall` 的 `searchParams.data`);其余保持 main 现状(不引入 text/sparse)
- `packages/service/core/dataset/search/defaultRecall/fullTextRecall.ts` — 重构出 mongo 路径 + `buildResultsFromRecallItems`,新增 milvus 引擎分支(§7)
- `packages/global/core/dataset/type.ts` — `DatasetDataSchema` 增加 `fullTextPending: z.boolean().optional()`(修复标记)
- `packages/service/core/dataset/data/schema.ts` — 增加 `fullTextPending: Boolean` 字段,并为修复任务扫描加索引(如 `{ fullTextPending: 1, updateTime: 1 }`)
- `projects/app/src/service/core/dataset/data/data.ts` — `create`/`update`(两处)/`delete` 全文写点门控(engine=milvus 时写 `MilvusFullTextStore`,跳过 `MongoDatasetDataText`;engine=mongo 维持现状)
- `packages/service/core/dataset/collection/controller.ts`、`packages/service/core/dataset/controller.ts` — 批量删除门控
- `projects/app/src/service/common/system/cronTask.ts` — 挂全文修复任务 + 残留悬空行清理任务(§10)

**测试**
- 单测:`env` 校验、analyzer 映射(`lingua`/`whatlang`)、`fullTextStore` 粒度归一化、迁移幂等
- 集成测试(需 Milvus 2.6):全文集合创建/插入/检索/删除/粒度切换
- 迁移脚本手工验收清单(dry-run、断点、计数校验)

## 12. 兼容性与回滚

- **engine=mongo(默认)**:mongo 全文路径零改动,行为与 main 完全一致。
- **engine=milvus**:
  - 升级到本版本需要已有 mongo 全文数据 → 先跑迁移脚本(或接受全量检索空白,由后续写入逐步填充)。
  - 回退到 mongo:先跑迁移(milvus → mongo)再切环境变量。
- 文档:补充 `.env` 示例与 `FULL_TEXT_ENGINE` / `MILVUS_LANGUAGE_IDENTIFIER` / `MILVUS_FULL_TEXT_SOURCE` 说明。
- 从旧分支升级:旧分支 `modeldata` 已含 `text/sparse` 字段与 `textContents` 数据,需走迁移脚本将全文数据搬入新集合,并重建 vector 集合(丢弃 text/sparse)或由部署方手工处理——迁移脚本不处理该场景,文档中注明。

## 13. 开放问题

- [x] `MILVUS_FULL_TEXT_SOURCE` 默认值:**定为 `data`**(§3.1/§4 已固化;理由:与 mongo 语义一致、迁移对称、实现最简)。
- [x] 全文写入顺序与 `createTime`:**定为方案 A(统一后写)并增加 `createTime`**(§3.3;用于残留悬空行清理)。
- [x] 迁移时序:**先切引擎、再迁移**(§9.3;源冻结为固定快照,幂等 upsert 保证重跑安全)。
- [ ] 迁移脚本对「旧分支单表残留数据」(部署过旧分支、`modeldata` 已含 text/sparse)是否提供一键回收 —— 当前设计为文档说明,不实现。
- [ ] 修复任务扫描频率与 `fullTextPending` 的上限/告警阈值。
