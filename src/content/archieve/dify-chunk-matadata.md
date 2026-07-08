# Dify 知识库深度解读：Chunk 编辑与 Metadata CURD

> 基于 `/home/hans/code/dify/api/` 源码（v1.15.0）· 上一篇《切分 / 标注 / 检索召回》讲过 pipeline，本篇聚焦「**每个 chunk 怎么动**」「**metadata 怎么 CURD**」，把上下游和涉及的 model / schema 全部点清楚。
>
> 阅读建议：先看 §0 的数据模型图，再按需跳到对应章节。

---

## 目录

- [0. 一张图：对象之间的关系](#0-一张图对象之间的关系)
- [1. 上游：Chunk 是怎么被生产出来的（再走一遍管道）](#1-上游chunk-是怎么被生产出来的再走一遍管道)
- [2. DocumentSegment 完整 Schema](#2-documentsegment-完整-schema)
- [3. Chunk / Segment 的 CURD](#3-chunk--segment-的-curd)
- [4. ChildChunk（hierarchical 模式专属）](#4-childchunkhierarchical-模式专属)
- [5. Metadata 的两套表：DatasetMetadata + DatasetMetadataBinding](#5-metadata-的两套表datasetmetadata--datasetmetadatabinding)
- [6. Metadata 的 CURD](#6-metadata-的-curd)
- [7. 下游：Chunk + Metadata 怎么被消费](#7-下游chunk--metadata-怎么被消费)
- [8. 涉及的所有 Model & 关系总图](#8-涉及的所有-model--关系总图)
- [9. 端到端示例：从上传 → 编辑 chunk → 加 metadata → 被检索](#9-端到端示例从上传--编辑-chunk--加-metadata--被检索)
- [10. 常见坑](#10-常见坑)

---

## 0. 一张图：对象之间的关系

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Dataset（知识库）                                │
│                                                                        │
│  id, name, tenant_id                                                   │
│  embedding_model / embedding_model_provider     ← 决定 chunk → 向量     │
│  indexing_technique: high_quality | economy     ← 决定走 embedding 还是 keyword
│  retrieval_model: {search_method, top_k, ...}    ← 下游召回用的        │
│  built_in_field_enabled                          ← 是否启用内置 metadata │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │   Document（一个上传文件 / 一篇 Notion 页面）                  │     │
│   │   id, name, dataset_id, position                              │     │
│   │   doc_form: text_model | qa_model | hierarchical_model        │     │
│   │   doc_metadata: JSONB   ← ★ 自定义 metadata 实际就存这        │     │
│   │   data_source_type: upload_file / notion_import / website... │     │
│   │   dataset_process_rule_id → 控制切分                          │     │
│   │                                                              │     │
│   │   ┌────────────────────────────────────────────────────┐      │     │
│   │   │  DocumentSegment（chunk）                          │      │     │
│   │   │  id, document_id, dataset_id, position            │      │     │
│   │   │  content, answer (qa), keywords, word_count       │      │     │
│   │   │  status: waiting/indexing/completed/error/...     │      │     │
│   │   │  index_node_id / index_node_hash  ← 指向向量/倒排 │      │     │
│   │   │  enabled, hit_count, sign_content (含签名 URL)     │      │     │
│   │   │                                                    │      │     │
│   │   │   ┌─ ChildChunk（仅 hierarchical 模式）           │      │     │
│   │   │   │  segment_id, content, type (auto/custom)      │      │     │
│   │   │   └────────────────────────────────────────────── ┘      │     │
│   │   └────────────────────────────────────────────────────────┘      │     │
│   └──────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │   DatasetMetadata（字段定义）                                 │     │
│   │   id, name, type: string | number | time                      │     │
│   │   built_in?（内置五个：document_name/uploader/upload_date/...）│     │
│   └──────────────────────────────────────────────────────────────┘     │
│                            │                                           │
│                            ▼  N 行绑定                                 │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │   DatasetMetadataBinding（文档级「字段定义 → 文档值」的关联） │     │
│   │   metadata_id  →  DatasetMetadata.id                          │     │
│   │   document_id  →  Document.id                                 │     │
│   │   （value 存在 Document.doc_metadata 这个 JSONB 里）          │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

关键点（容易踩的）：

- **Metadata 字段定义**（DatasetMetadata）和 **文档上的值**（Document.doc_metadata + DatasetMetadataBinding）**分两张表**。
- **Chunk 的 `answer` 字段**只在 `doc_form = qa_model` 时才有意义，写入时 `SegmentService.segment_create_args_validate` 会强制校验。
- **Chunk 的 `index_node_id`** 不在 DocumentSegment 表里写死，**实际指向外部向量库**（PG vector / Weaviate / Qdrant 等），DocumentSegment 里只存 ID 字符串。
- **ChildChunk 严格从属于 Segment**，仅在 `doc_form = hierarchical_model` 时存在。

---

## 1. 上游：Chunk 是怎么被生产出来的（再走一遍管道）

Chunk 不是凭空冒出来的，它是一条**异步管道**的产物。理解这条管道能帮你预判：手动改一个 chunk 时，哪些字段会"自动跟着变"。

```text
上传文件
   │
   ▼
[1] 文档入库（Document 行）
   │   fields: data_source_type, data_source_info, dataset_process_rule_id
   │   status: waiting → parsing
   ▼
[2] 文件抽取（extractor/）
   │   PDF / DOCX / Notion / 网页 → 纯文本
   │   写回: parsing_completed_at, word_count
   ▼
[3] 清洗（cleaner/）
   │   替换多余换行 / 去掉 emoji / 合并连续空格
   │   写回: cleaning_completed_at
   ▼
[4] 切分（splitter/）
   │   按 ProcessRule（max_tokens / separator / overlap）
   │   输出 N 个 chunk（text）+ keywords（jieba/gpt 等）
   │   写回: splitting_completed_at
   ▼
[5] 按 doc_form 分叉
   │
   ├─── text_model ───────────────────────────────────────────┐
   │                                                          │
   ├─── qa_model ──→ LLM 把每个 chunk 生成 Q&A 配对 ──────────┤
   │                   （需要 dataset 配 LLM provider）         │
   │                   segment.content = Q, segment.answer = A │
   │                                                          │
   └─── hierarchical_model ──→ LLM 给每个 parent 生成 summary  │
                               ↓                              │
                          再切 child chunks                   │
                          （child chunk 单独建索引）            │
                                                             ▼
[6] 向量化（embedding/）
   │   dataset.embedding_model = 'text-embedding-3-small' / 'bge-m3' / ...
   │   每个 chunk → vector
   │   写入：
   │     · Embedding 表（缓存，hash 去重）
   │     · 外部向量库（Collection，key = index_node_id）
   │     · DatasetKeywordTable（仅 indexing_technique = economy 时）
   │   写回: tokens, indexing_at, completed_at
   ▼
[7] DocumentSegment 落库
   │   status: waiting → indexing → completed
   │   index_node_id / index_node_hash 由第 [6] 步回填
   ▼
[Document.indexing_status = 'completed']
```

**手动改一个 chunk 会触发什么？** 见 `services/dataset_service.py::SegmentService.update_segment`：

- 改 `content` → 重新 `helper.generate_text_hash(content)` → 重新算 `tokens`（再次调用 embedding 模型计费接口）→ 重新 `VectorService.update_segment_vector`：
  - HIGH_QUALITY：`vector.delete_by_ids([index_node_id])` → `vector.add_texts([...])`（覆盖向量）
  - ECONOMY：重建 `Keyword` 倒排条目
- 改 `keywords` → 仅 ECONOMY 模式有意义（重建倒排）
- 改 `enabled=False` → 异步任务 `disable_segment_from_index_task.delay(segment.id)`，**只删向量，不删库行**
- `hierarchical_model` + `regenerate_child_chunks=True` → 用 LLM 重新生成 child chunks，并重新向量化子块
- 失败时 → `status=ERROR, enabled=False, disabled_at=now, error=str(e)`

**所以"改 chunk"的真正含义是"重写这一行 + 替换向量库里的向量"**——别只改 DB 不动 vector。

---

## 2. DocumentSegment 完整 Schema

源：`api/models/dataset.py::DocumentSegment`（表名 `document_segments`）

```python
class DocumentSegment(TypeBase):
    __tablename__ = "document_segments"

    # ── 标识 ────────────────────────────────────────────────
    id:              str  # uuid, default uuid4
    tenant_id:       str  # 租户隔离
    dataset_id:      str  # 所属知识库
    document_id:     str  # 所属文档
    position:        int  # 文档内顺序，从 1 开始

    # ── 文本 ────────────────────────────────────────────────
    content:         str  # LongText，主文本（text_model / hierarchical 父块用这个）
    answer:          str | None  # 仅 qa_model 有效：Q 的标准答案
    keywords:        list[str] | None  # JSON，关键词（用于 ECONOMY 倒排）
    word_count:      int  # content 长度
    tokens:          int  # embedding 模型计算的 token 数

    # ── 索引状态 ────────────────────────────────────────────
    status:          SegmentStatus  # waiting / indexing / completed / error / paused / re_segment
    index_node_id:   str | None     # 指向向量库 / 倒排库的 doc id
    index_node_hash: str | None     # 内容 hash，用于 dedup
    enabled:         bool  # False 时不进检索
    disabled_at:     datetime | None
    disabled_by:     str | None  # user id

    # ── 命中与时间戳 ────────────────────────────────────────
    hit_count:       int  # 被检索命中的累计次数
    created_at / created_by
    updated_at / updated_by
    indexing_at:     datetime | None  # 进入索引管道的时刻
    completed_at:    datetime | None  # 索引完成的时刻
    stopped_at:      datetime | None
    error:           str | None  # 索引失败原因
```

**容易混淆的字段：**

| 字段 | 是什么 | 什么时候该看它 |
|---|---|---|
| `content` | 用户能读到的文本 | 编辑/展示 chunk 时 |
| `sign_content`（property，不是列） | 把 `content` 里的 `/files/xxx/image-preview` 之类的内部 URL 换成带 HMAC 签名的可访问 URL | 渲染 / 给 LLM 看时 |
| `index_node_id` | 向量库或倒排库里的 doc id | 排查"向量库里没有"问题时，去向量库用这个 id 查 |
| `index_node_hash` | `helper.generate_text_hash(content)` | 改 chunk 后对比是否真改了内容 |
| `status` | 这条 segment 自己当前的索引状态 | UI 显示"索引中"是看这个 |
| `Document.indexing_status` | 整篇文档的聚合状态 | 文档级"已索引完成"看这个 |

**索引在 `document_segments` 表上：**

```python
sa.Index("document_segment_dataset_id_idx", "dataset_id"),
sa.Index("document_segment_document_id_idx", "document_id"),
sa.Index("document_segment_tenant_dataset_idx", "dataset_id", "tenant_id"),
sa.Index("document_segment_tenant_document_idx", "document_id", "tenant_id"),
sa.Index("document_segment_node_dataset_idx", "index_node_id", "dataset_id"),
sa.Index("document_segment_tenant_idx", "tenant_id"),
```

——按 `(document_id, position)` 翻页很快，按 `index_node_id` 反查也很快。

---

## 3. Chunk / Segment 的 CURD

> Service API 路径（`/v1/datasets/...`，用 dataset API key），Console API 类似，路径前缀 `/console/api`。
> 源：`api/controllers/service_api/dataset/segment.py`

### 3.1 Payload 模型

```python
class SegmentCreateItemPayload(BaseModel):
    content: str                                   # 必填
    answer: str | None = None                      # qa_model 必填
    keywords: list[str] | None = None
    attachment_ids: list[str] | None = None        # 多模态挂图

class SegmentCreatePayload(BaseModel):
    segments: list[SegmentCreateItemPayload]       # 批量

class SegmentUpdateArgs(BaseModel):
    content: str | None = None
    answer:  str | None = None
    keywords: list[str] | None = None
    enabled: bool | None = None                    # false=下架
    attachment_ids: list[str] | None = None
    regenerate_child_chunks: bool | None = None    # hierarchical 模式专用
    summary: str | None = None                     # 摘要索引
```

### 3.2 端点清单

| 操作 | Method + Path | 备注 |
|---|---|---|
| **批量新增 chunk** | `POST /v1/datasets/{dataset_id}/documents/{document_id}/segments` | body: `{segments: [...]}`，QA 模式必须给 `answer` |
| **列出 chunk** | `GET /v1/datasets/{dataset_id}/documents/{document_id}/segments?page=1&limit=20&status=completed&keyword=...` | 服务端 `limit` 上限 100 |
| **取单个 chunk** | `GET /v1/datasets/{dataset_id}/documents/{document_id}/segments/{segment_id}` | 含 `sign_content` 和 `attachments` |
| **改 chunk** | `POST /v1/datasets/{dataset_id}/documents/{document_id}/segments/{segment_id}` | body: `{segment: SegmentUpdateArgs}`，**改 content 会触发重索引** |
| **删 chunk** | `DELETE /v1/datasets/{dataset_id}/documents/{document_id}/segments/{segment_id}` | 走 `delete_segment` 异步任务 |
| **批量删** | `POST /v1/datasets/{dataset_id}/documents/{document_id}/segments/batch` | body: `{segment_ids: [...]}` |

### 3.3 改 chunk 的 5 个关键副作用（必看）

1. **Redis 锁**：`redis_client.get(f"segment_{segment.id}_indexing")` 非空就拒绝。意味着：上一次改还没落库完，并发改第二次会 5xx。前端 UI 上"保存中"就是这个原因。
2. **`enabled=false` 的 chunk 不能再改 content**：`raise ValueError("Can't update disabled segment")`。
3. **改 content 会重算 tokens 并调 embedding 计费**：`embedding_model.get_text_embedding_num_tokens(texts=[content])[0]`。批量改大文档是钱。
4. **改 content 不重排 position**：position 不变，UI 上的分页顺序不变。
5. **失败兜底**：try/except 里 `status=ERROR, enabled=False, error=str(e)`——意味着 update 不会"半成功"，要么完整覆盖向量库，要么整条 segment 被下架。

### 3.4 QA 模式专属规则

```python
def segment_create_args_validate(cls, args, document):
    if document.doc_form == IndexStructureType.QA_INDEX:
        if "answer" not in args or not args["answer"]:
            raise ValueError("Answer is required")
        if not args["answer"].strip():
            raise ValueError("Answer is empty")
    if "content" not in args or not args["content"] or not args["content"].strip():
        raise ValueError("Content is empty")
```

——`qa_model` 不给 `answer` 直接拒绝；给空字符串也拒绝。token 计算会把 `content + answer` 一起算。

### 3.5 多模态挂图（attachment_ids）

`DocumentSegment` 表本身不存图片，图片存在 `UploadFile` 表里，通过 `SegmentAttachmentBinding` 关联：

```python
class SegmentAttachmentBinding(TypeBase):
    __tablename__ = "segment_attachment_bindings"
    id, tenant_id, dataset_id, document_id, segment_id
    attachment_id  # → UploadFile.id
```

读出来时通过 `DocumentSegment.attachments` property 现签 HMAC URL：

```python
@property
def attachments(self) -> list[AttachmentItem]:
    # JOIN SegmentAttachmentBinding × UploadFile
    # 拼 image-preview 签名 URL（5 分钟过期）
    ...
```

改 `attachment_ids` 时走 `VectorService.update_multimodel_vector(segment, args.attachment_ids, dataset)`——多模态 chunk 的向量是用 LLM 把图转成描述再 embedding 的，**改 attachment 等于触发一次多模态重向量化**。

### 3.6 一段示例（curl）

```bash
# 改一个 chunk 的内容（text_model）
curl -X POST \
  "https://api.dify.ai/v1/datasets/<ds_id>/documents/<doc_id>/segments/<seg_id>" \
  -H "Authorization: Bearer <DATASET_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "segment": {
      "content": "Dify 是一个开源 LLM 应用开发平台。",
      "keywords": ["Dify", "LLM", "开源"]
    }
  }'

# 下架一个 chunk（不进检索，但库行不删）
curl -X POST .../segments/<seg_id> -d '{"segment": {"enabled": false}}'
```

---

## 4. ChildChunk（hierarchical 模式专属）

源：`api/models/dataset.py::ChildChunk`（表名 `child_chunks`）

```python
class ChildChunk(TypeBase):
    id, tenant_id, dataset_id, document_id, segment_id
    position: int                  # 父段内的顺序
    content: str                   # 子块文本
    word_count: int
    type: SegmentType              # automatic | customized（用户改过变 customized）
    index_node_id / index_node_hash
    created_at / created_by / updated_at / updated_by
    indexing_at / completed_at / error
```

**关系：**

```
DocumentSegment (parent) ─┬─ index_node_id → 向量库
                          └─ ChildChunk (children) ─┬─ 各自 content
                                                    └─ 各自 index_node_id → 向量库
```

**端点：**

| 操作 | Path |
|---|---|
| 新建子块 | `POST /v1/datasets/{ds}/documents/{doc}/segments/{seg}/child_chunks` |
| 列出子块 | `GET .../child_chunks?page=1&limit=20&keyword=...` |
| 删子块 | `DELETE .../child_chunks/{child_chunk_id}` |
| 改子块 | `PATCH .../child_chunks/{child_chunk_id}` |

**检索时怎么用：** parent chunk 命中后，拿 `child_chunks` 当"细粒度上下文"塞给 LLM（parent 提供主题，children 提供细节）——这正是 hierarchical 模式的核心收益。

**只在以下条件存在**（见 `DocumentSegment.child_chunks` property）：

```python
if document.dataset_process_rule.mode == "hierarchical":
    rules = Rule.model_validate(process_rule.rules_dict)
    if rules.parent_mode and rules.parent_mode != ParentMode.FULL_DOC:
        # 才查 child_chunks 表
```

——`parent_mode = FULL_DOC`（整篇文档作为一个 parent）时，根本没建 ChildChunk。

---

## 5. Metadata 的两套表：DatasetMetadata + DatasetMetadataBinding

**核心认知：metadata 在 Dify 里是"字段定义 + 文档值"两表分离。**

### 5.1 字段定义：DatasetMetadata

源：`api/models/dataset.py::DatasetMetadata`（表名 `dataset_metadatas`）

```python
class DatasetMetadata(TypeBase):
    id: str (uuid)
    tenant_id: str
    dataset_id: str              # 作用域是 dataset
    type: DatasetMetadataType    # string | number | time   ← 只这三种！
    name: str                    # 字段名（如 "author", "department"）
    created_at / updated_at
    created_by / updated_by
```

**支持的类型枚举**（`models/enums.py::DatasetMetadataType`）：

```python
class DatasetMetadataType(StrEnum):
    STRING = "string"
    NUMBER = "number"
    TIME   = "time"
```

——**没有 `single_select` / `array` / `boolean`**，跟飞书多维表格那种"下拉单选"不是一个体系。要做分类标签，就用 `string`，值约束靠业务侧。

**内置字段**（不算在 `dataset_metadatas` 表里，而是 dataset 上的一个开关）：

```python
class Dataset.built_in_field_enabled: bool   # 默认 False
```

启用后会拿到五个内置字段：

| name | type | 来源 |
|---|---|---|
| `document_name` | string | Document.name |
| `uploader` | string | Document.created_by → Account.name |
| `upload_date` | time | Document.created_at |
| `last_update_date` | time | Document.updated_at |
| `source` | string | data_source_type（upload_file / notion_import / website_crawl...） |

### 5.2 文档值：DatasetMetadataBinding

源：`api/models/dataset.py::DatasetMetadataBinding`（表名 `dataset_metadata_bindings`）

```python
class DatasetMetadataBinding(TypeBase):
    id, tenant_id, dataset_id
    metadata_id: str     # → DatasetMetadata.id
    document_id: str     # → Document.id
    created_at, created_by
```

**这一行只表示"这个文档使用了这个字段定义"**，**实际的值**存在 `Document.doc_metadata` 这个 JSONB 列里：

```python
# Document 模型里
doc_metadata = mapped_column(AdjustedJSON, nullable=True)   # JSONB
```

取值流程（前端 / API 拿 metadata 时）：

```text
Document.id ──┬─→ Document.doc_metadata["author"] = "Hans"   ← 真正的值
              └─→ DatasetMetadataBinding (metadata_id, document_id)  ← 用来"知道有哪些字段"
```

**所以"加 metadata"其实是两步**：
1. 在 dataset 上注册字段定义（DatasetMetadata）—— 一次
2. 在每个 Document 上写值（Document.doc_metadata 里的 JSON）—— N 次

清掉字段定义（DELETE）会把所有 binding 一起删掉，**Document.doc_metadata 里的值不会被自动清**（业务侧自己处理）。见 `MetadataService.delete_metadata`。

---

## 6. Metadata 的 CURD

源：`api/controllers/service_api/dataset/metadata.py` + `services/entities/knowledge_entities/knowledge_entities.py`

### 6.1 Payload 模型

```python
class MetadataArgs(BaseModel):
    type: Literal["string", "number", "time"]
    name: str

class MetadataUpdateArgs(BaseModel):
    name: str                       # 改字段名（注意：改的是字段定义，值不动）
    value: str | int | float | None # 改字段值（单文档）

class MetadataDetail(BaseModel):
    id: str
    name: str
    value: str | int | float | None

class DocumentMetadataOperation(BaseModel):
    document_id: str
    metadata_list: list[MetadataDetail]
    partial_update: bool = False    # True=增量；False=全量（未指定字段会被清空）

class MetadataOperationData(BaseModel):
    operation_data: list[DocumentMetadataOperation]
```

### 6.2 端点清单

| 操作 | Method + Path | 说明 |
|---|---|---|
| **建字段** | `POST /v1/datasets/{ds}/metadata` | body: `{type, name}`，type 必填 string/number/time |
| **列字段** | `GET /v1/datasets/{ds}/metadata` | 返回 `{doc_metadata: [...], built_in_field_enabled: bool}`，含 `count`（用了多少文档） |
| **改字段名** | `PATCH /v1/datasets/{ds}/metadata/{metadata_id}` | body: `{name}`；**值不动** |
| **删字段** | `DELETE /v1/datasets/{ds}/metadata/{metadata_id}` | 删字段定义 + 全部 binding；Document.doc_metadata 里的值不删 |
| **取内置字段** | `GET /v1/datasets/{ds}/metadata/built-in` | 固定返回那 5 个 |
| **启停内置字段** | `POST /v1/datasets/{ds}/metadata/built-in/{enable\|disable}` | 全局开关 |
| **批量给文档写值** | `POST /v1/datasets/{ds}/documents/metadata` | body: `{operation_data: [...]}` |
| **单文档 metadata（newer）** | `PUT /v1/datasets/{ds}/documents/{doc_id}/metadata` | 较新版才有，自托管 1.9.x 之前不一定有 |

### 6.3 partial_update 是个大坑

```python
class DocumentMetadataOperation(BaseModel):
    document_id: str
    metadata_list: list[MetadataDetail]
    partial_update: bool = False   # ← 默认 False = 全量覆盖
```

**默认行为**：发 `{author: "Hans"}` 会**清空**这个文档所有其他 metadata 字段。
**要保留**必须显式 `partial_update: true`，或者把现有 metadata 都带上。

```bash
# ❌ 危险：会清掉 department 字段
curl -X POST .../datasets/<ds>/documents/metadata -d '{
  "operation_data": [{
    "document_id": "<doc_id>",
    "metadata_list": [{"id":"<auth_field_id>","name":"author","value":"Hans"}]
  }]
}'

# ✅ 保留
curl -X POST .../datasets/<ds>/documents/metadata -d '{
  "operation_data": [{
    "document_id": "<doc_id>",
    "metadata_list": [...所有字段...],
    "partial_update": true
  }]
}'
```

### 6.4 改字段名 vs 改值

- `PATCH /metadata/{id}` body `{name: "new_name"}` → 只改 `dataset_metadatas.name`，Document.doc_metadata 里的 `key` 不自动改（`MetadataService.update_metadata_name` 只动 DatasetMetadata 行）。如果你在 Document.doc_metadata 里查的是 `doc_metadata["author"]`，改名后**值找不到了**——得自己迁移。
- `POST /documents/metadata` body 含 `value` → 改 `Document.doc_metadata[name] = value`，dataset_metadatas 表**不动**。

——一个改"字段名"，一个改"字段值"，别混。

---

## 7. 下游：Chunk + Metadata 怎么被消费

源：`api/core/rag/retrieval/dataset_retrieval.py` + `retrieval_service.py`

### 7.1 检索一次 query 的完整管线

```text
用户问题 q
   │
   ▼
[1] 入参：DatasetRetrieverService.retrieve(query=q, dataset_ids, ..., metadata_filtering_mode, metadata_filtering_conditions)
   │
   ▼
[2] metadata 过滤（如果开了）
   │   metadata_filtering_mode: disabled | automatic | manual
   │   - automatic：LLM 把 q 翻译成 metadata condition（要花钱）
   │   - manual：调用方直接给 condition
   │   - disabled：跳过
   │   ↓
   │   MetadataFilteringCondition
   │     { logical_operator: "and"|"or", conditions: [{name, comparison_operator, value}] }
   │   ↓
   │   self.get_metadata_filter_condition(...)
   │     → 先去 dataset_metadatas + documents 找出符合 condition 的 document_id 集合
   │     → 拿这个集合去缩小检索范围
   ▼
[3] 向量召回（仅 HIGH_QUALITY）
   │   dataset.embedding_model → 把 q 转向量
   │   在向量库里查 top_k
   │   走 dataset.retrieval_model.search_method：
   │     - vector_search：纯向量
   │     - full_text_search：纯倒排（仅 ECONOMY）
   │     - hybrid_search：RRF 融合向量 + 倒排
   ▼
[4] Rerank（如果开了）
   │   dataset.retrieval_model.reranking_enable = true
   │   → RerankModel.rerank(query=q, documents=top_k * 3)
   │   → 返回 top_k
   ▼
[5] Score threshold
   │   dataset.retrieval_model.score_threshold（默认 0）
   │   低于阈值的丢掉
   ▼
[6] 拼上下文给 LLM
       DocumentSegment 列表 → 渲染成 prompt
       + sign_content（含 HMAC 签名图 URL）
       + attachments（多模态挂图）
       + document_name（引用来源）
       + doc_metadata（按 dataset.retrieval_model.metadata_filtering_mode 决定是否也作为上下文）
```

### 7.2 Metadata 过滤的"先于检索"特性

`metadata_filtering_mode` 在**向量召回之前**生效：它先算出"哪些文档 ID 满足条件"，向量召回时只查这些文档的向量。这是 metadata 最大的实战价值——把"全库 100 万 chunk"缩成"先筛选到 200 文档 → 再召 800 向量"。

**示例：手动 condition**

```json
{
  "logical_operator": "and",
  "conditions": [
    {"name": "department", "comparison_operator": "is", "value": "finance"},
    {"name": "upload_date", "comparison_operator": "after", "value": "2025-01-01T00:00:00Z"}
  ]
}
```

支持的 `comparison_operator` 取决于 `DatasetMetadataType`：

| type | operators |
|---|---|
| string | `contains`, `is`, `is not`, `empty`, `not empty` |
| number | `=`, `≠`, `>`, `<`, `≥`, `≤`, `empty`, `not empty` |
| time | `before`, `after`, `on or before`, `on or after`, `empty`, `not empty` |

### 7.3 chunk 的"被消费方式"汇总

| 消费方 | 用到 segment 哪些字段 |
|---|---|
| 检索（向量 / 倒排） | `index_node_id`, `index_node_hash`, `enabled`, `content` |
| Rerank | `content`（含 answer 拼接） |
| LLM prompt | `content`, `sign_content`, `attachments`, `answer` (qa_model) |
| 引用 / 溯源 | `document_id`, `position`, `Document.name`, `Document.doc_metadata` |
| 命中统计 | `hit_count` |
| 多模态展示 | `attachments[]`（带签名的图 URL） |
| Summary index | `DocumentSegmentSummary`（额外的 summary chunk） |

---

## 8. 涉及的所有 Model & 关系总图

源：全部在 `api/models/dataset.py`（100+ 个类，列核心）

```text
Dataset (datasets)
  ├─ id, tenant_id, name, description
  ├─ embedding_model, embedding_model_provider
  ├─ indexing_technique: HIGH_QUALITY | ECONOMY
  ├─ retrieval_model (JSONB): {search_method, top_k, score_threshold,
  │                                       reranking_enable, reranking_model,
  │                                       reranking_mode, weights, metadata_filtering_mode}
  ├─ built_in_field_enabled
  ├─ enable_api, runtime_mode, pipeline_id, is_multimodal
  │
  ├─ 1:N ──→ Document
  │              ├─ id, position, name
  │              ├─ data_source_type: upload_file | notion_import | website_crawl
  │              ├─ data_source_info (LongText/JSON)
  │              ├─ dataset_process_rule_id → DatasetProcessRule
  │              ├─ doc_form: text_model | qa_model | hierarchical_model
  │              ├─ doc_metadata (JSONB)   ← ★ metadata 实际值
  │              ├─ doc_type, doc_language, need_summary
  │              ├─ indexing_status, enabled, archived, error
  │              ├─ word_count, tokens, completed_at, indexing_latency
  │              │
  │              ├─ 1:N ──→ DocumentSegment (document_segments)
  │              │              ├─ position, content, answer, keywords
  │              │              ├─ word_count, tokens
  │              │              ├─ status: SegmentStatus
  │              │              ├─ index_node_id, index_node_hash
  │              │              ├─ enabled, disabled_at/disabled_by
  │              │              ├─ hit_count, error
  │              │              │
  │              │              └─ 1:N (hierarchical only) ──→ ChildChunk
  │              │                                ├─ position, content, word_count
  │              │                                ├─ type: automatic | customized
  │              │                                └─ index_node_id, index_node_hash
  │              │
  │              └─ 1:N ──→ SegmentAttachmentBinding
  │                              └─ attachment_id → UploadFile
  │
  ├─ 1:N ──→ DatasetMetadata (dataset_metadatas)
  │              ├─ name, type: string | number | time
  │              └─ 不存值
  │
  └─ 1:N ──→ DatasetMetadataBinding (dataset_metadata_bindings)
                 ├─ metadata_id → DatasetMetadata.id
                 └─ document_id → Document.id   ← "哪些文档用了这个字段"
                                  （值在 Document.doc_metadata 里）

DatasetProcessRule
  └─ mode, rules (JSON), created_by/created_at
     rules.examples:
       {
         "pre_processing_rules": [{"id":"remove_extra_spaces","enabled":true}, ...],
         "segmentation": {"delimiter":"\n\n","max_tokens":1024, "chunk_overlap":50},
         "parent_mode": "paragraph"   // 仅 hierarchical
       }

Embedding (embeddings)            ← 缓存层，hash 去重
  ├─ model_name, provider_name, hash (text hash)
  └─ embedding (BinaryData, pickle)

DatasetKeywordTable                ← 仅 ECONOMY 用
  ├─ dataset_id, keywords_table (JSONB: {keyword → [index_node_id, ...]})
  └─ updated_at

DocumentSegmentSummary             ← Summary index 才用
  ├─ chunk_id → DocumentSegment.id
  ├─ summary_content, status
  └─ index_node_id / index_node_hash  (summary 自身也向量化)

AppDatasetJoin                     ← 把 dataset 绑到 app
```

**没有的表**（以免找错）：
- ❌ 没有 `DocumentMetadataValue` 这种单独的"文档-字段-值"三列表——值直接塞在 `Document.doc_metadata` JSONB。
- ❌ 没有 `DocumentSegment.metadata`——chunk 上**没有**自定义 metadata 字段，metadata 永远是 document 级别的。
- ❌ `DocumentSegment` 不存 child_chunks 的 JSON 镜像——用 `child_chunks` property 实时查。

---

## 9. 端到端示例：从上传 → 编辑 chunk → 加 metadata → 被检索

```bash
# 0. base
HOST=https://api.dify.ai
KEY=<DATASET_API_KEY>
DS=<dataset_id>

# 1. 上传一份 PDF，自动切分
curl -X POST "$HOST/v1/datasets/$DS/document/create_by_file" \
  -H "Authorization: Bearer $KEY" \
  -F 'data={"indexing_technique":"high_quality","process_rule":{"mode":"automatic","rules":{"segmentation":{"max_tokens":512}}}};type=application/json' \
  -F 'file=@./handbook.pdf'
# → 拿到 document.id

# 2. 列出 chunk（看 status 是不是 completed）
curl "$HOST/v1/datasets/$DS/documents/$DOC/segments?limit=20&status=completed" \
  -H "Authorization: Bearer $KEY"

# 3. 改一个 chunk（QA 模式必须带 answer）
curl -X POST "$HOST/v1/datasets/$DS/documents/$DOC/segments/$SEG" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "segment": {
      "content": "Dify 是一个开源的大模型应用开发平台。",
      "answer": "它是开源的 LLM 应用开发平台。",
      "keywords": ["Dify","LLM","开源"]
    }
  }'

# 4. 给这个文档加一个自定义 metadata 字段（一次性）
curl -X POST "$HOST/v1/datasets/$DS/metadata" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"type":"string","name":"department"}'
# → 拿到 field_id
# 启内置字段（可选）
curl -X POST "$HOST/v1/datasets/$DS/metadata/built-in/enable" \
  -H "Authorization: Bearer $KEY"

# 5. 给文档写 metadata 值（partial_update=true 保留其他字段）
curl -X POST "$HOST/v1/datasets/$DS/documents/metadata" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "operation_data": [{
      "document_id": "'$DOC'",
      "metadata_list": [
        {"id":"'$FIELD'","name":"department","value":"finance"}
      ],
      "partial_update": true
    }]
  }'

# 6. 用 metadata 过滤 + 检索
curl -X POST "$HOST/v1/datasets/$DS/retrieve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "query": "Dify 怎么部署？",
    "retrieval_model": {
      "metadata_filtering_mode": "manual",
      "metadata_filtering_conditions": {
        "logical_operator": "and",
        "conditions": [
          {"name":"department","comparison_operator":"is","value":"finance"}
        ]
      }
    },
    "top_k": 3
  }'
```

---

## 10. 常见坑

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 改 chunk 改了一半又被改 | 第二次改失败 / 500 | 等前端"保存中"结束；后端有 Redis 锁 |
| 改 chunk 后向量没变 | 检索还能召回旧内容 | 改 `content` 才会触发重索引；只改 `keywords` 在 HIGH_QUALITY 模式下不会重建向量（只在 ECONOMY 倒排下生效） |
| 改 chunk 后 `Document.word_count` 漂了 | UI 显示文档字数不准 | Dify 内部会维护 `Document.word_count += Δ`，但**手动 SQL 改 segment 不会维护**，要走 API |
| QA 模式没传 `answer` | 422 / ValueError | `qa_model` 必填 `answer`；前端会自动补 |
| partial_update 忘了写 | 其他 metadata 全被清空 | 永远显式带 `partial_update: true` |
| 改了 metadata 字段名 | Document.doc_metadata 里的 key 没动 → 检索/列表显示不出值 | 改名后**手动**把 `Document.doc_metadata` 里的 key 也改掉 |
| 删了 metadata 字段定义 | Document.doc_metadata 里的值还在 | 业务侧需要自己清；Dify 不主动清 |
| hierarchical 模式改 parent 不想重建 child | `regenerate_child_chunks` 不传默认 False | 想重建就显式 `"regenerate_child_chunks": true`，会触发 LLM 重新切分 |
| 大批量改 chunk | 烧钱 | 改 content 会调 embedding 计费接口算 tokens；改 keywords 只在 ECONOMY 下重倒排 |
| 自托管 1.9.x 找不到 `PUT /documents/{id}/metadata` | 404 | 那个端点是 1.10+ 加的，老版本只有 `POST /documents/metadata` 批量写 |
| 内置 metadata 改不了 | `uploader` 是系统字段 | 内置字段值由系统维护；想覆盖就关掉内置，用自定义字段 |
| `Dataset.doc_form` 看不到 | doc_form 在 Document 上不在 Dataset 上 | 改 chunk 行为看 `Document.doc_form`（dataset 概念上没 doc_form） |

---

## 附：API 一句话速查

```
# Segment
POST   /v1/datasets/{ds}/documents/{doc}/segments
GET    /v1/datasets/{ds}/documents/{doc}/segments?page=&limit=&status=&keyword=
GET    /v1/datasets/{ds}/documents/{doc}/segments/{seg}
POST   /v1/datasets/{ds}/documents/{doc}/segments/{seg}      # update
DELETE /v1/datasets/{ds}/documents/{doc}/segments/{seg}
POST   /v1/datasets/{ds}/documents/{doc}/segments/batch       # 批量删

# ChildChunk
POST   /v1/datasets/{ds}/documents/{doc}/segments/{seg}/child_chunks
GET    /v1/datasets/{ds}/documents/{doc}/segments/{seg}/child_chunks
PATCH  /v1/datasets/{ds}/documents/{doc}/segments/{seg}/child_chunks/{cc}
DELETE /v1/datasets/{ds}/documents/{doc}/segments/{seg}/child_chunks/{cc}

# Metadata
GET    /v1/datasets/{ds}/metadata
POST   /v1/datasets/{ds}/metadata
PATCH  /v1/datasets/{ds}/metadata/{meta_id}
DELETE /v1/datasets/{ds}/metadata/{meta_id}
GET    /v1/datasets/{ds}/metadata/built-in
POST   /v1/datasets/{ds}/metadata/built-in/{enable|disable}
POST   /v1/datasets/{ds}/documents/metadata                   # 批量写文档值
PUT    /v1/datasets/{ds}/documents/{doc}/metadata             # 单文档写值（1.10+）

# 检索（要 metadata 过滤就用它）
POST   /v1/datasets/{ds}/retrieve
```

---

*系列：*
- *上篇：[`2026-07-07_dify_rag_deepdive.md`](2026-07-07_dify_rag_deepdive.md) 切分 / 标注 / 检索召回全链路*
- *本篇：Chunk 编辑 + Metadata CURD 的 model / schema / 上下游*
