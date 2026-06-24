# 1. 背景
- LLM知识冻结
- 离线向量化准备知识
 - 文档加载
 - 文档切割
 - 向量化 bge text-embedding
 - 入库
    - chroma
    - milvus 
    - qdrant
    - weaviate
    - lancedb
- 在线检索知识
 - query处理 问题改写为标准化
 - 向量检索（粗排）top-k 例如top20
 - rerank (精排) 问题+候选chunk 准但是慢 选最终top3-5
 - 生成prompt

## 特点
- 知识热更新
- 答案溯源（来自chunk
- 私有数据随时更新
- 解决幻觉 事实错误

## 与微调
- 知识训练进模型 更新权重参数
- 深度定制模型输出
- 成本高 标注数据 GPU训练
- 知识更新麻烦 不可能每次微调

rag
- 检索增加响应延时
- 检索不到相应的知识也不准
- 复杂问题没法推理
- 缺乏全局理解

通常情况二者可结合
- FT做输出格式 风格等的微调
- RAG补充外部私有知识

## 文档切割
### chunk结构
- vec 索引
- content 原文
- metadata 标签