# 主流程
- 候选智能体 * N 并行 产出N条候选SQL
- 决策智能体 1 带工具复核
- 成功的SQL -> save_example 下次同类题直接召回
- 知识 不是prompt 是可以检索的资产 按问题语义召回 加规则会稀释检索池 通用知识常驻 检索池留下场景规则

# 工具
- Schema 数据库 table column
- 模糊枚举检索
- 知识检索 列画像 业务规则 示例
- 存储相关的工具 heavenbase
举例
- expand_synonyms  folks -> customers
- get_db_info get_tab_info
- get_column_info
- search_columns search_values
- get_examples few-shot


# 其他
- BIRD的metadata -> desc 官方给出的列语义的说明 还有取值不同的含义
- 317条规则 3833条示例 手工示例仅47条 1.2%
- 决策智能体不是选赢家 而是选唯一正确的答案
- harness: 控制决策智能体 返回的一定是SQL 而不是答案 也不是纯文本 要调用submitsql工具
- 候选智能体有两种模式 混合+纯净（一个供应商

# 官方管线
- Profiling
- General rules
- PerDB hint rules
- Example
- Eval pass
- Judge induce
- Eval pass
- sumbit