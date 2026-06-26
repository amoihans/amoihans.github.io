# 传统NLP
- 一个完整的任务拆分为好几个
 - 分词
 - 词性
 - 实体
 - 意图
 - 任务模型
- 错误会积累传导
- 任务越细分 模型越多 标注成本越高

# BERT
- 创新：预训练+微调
- MLM 掩码语言模型 遮蔽15% 然后模型根据上下文猜测 填空题
- NSP 下一句预测  两个句子 判断是否是连续的
- 预训练 + 海量无标注文本
- 解决了特征通用问题 可以根据不同的头 服务不同的下游任务
- 模型学习到看懂文字的能力 但输出的是 token的向量表示 不是文本

# LLM
核心：预测下一个token
CLM 因果语言模型
自回归 下一步的预测依赖上一步的输出
BERT-0.3B GPT-3 175B
规模上升 能力涌现
Scaling Law
- 模型规模
- 训练数据量
- 训练算力
- 三者可预测：按一定的比例同时放大 模型损失值沿着幂律曲线下降

RNN
- 顺序计算 无法并行 训练极慢
- 长距离梯度消失 很难学到第一个和第800个词的关系

Transformer
- 并行计算 全局连接
- Q查询 K标签 V实际值 用Q去匹配K 计算相似度分数 按分数权重对V加权求和
- Attention(Q, K, V) = softmax(Q · K^T / √d_k) · V
- 除以√d_k是为了减小极端分布 one-hot 梯度消失
- 多头 QKV投影到不同子空间 每组独立计算注意力 捕捉不同的关系
- 自注意力 缺陷是计算对称 不考虑顺序 所以需要位置编码
- 前馈网络FFN 两层全连接加激活函数 补充注意力层学不到的信息 知识层

主流LLM都是Decoder-only
- Encoder: BERT 擅长理解不擅长生成
- Decoder: 因果掩码
- En-De T5 BART En双向理解输入 De单向生成输出
- 适合输入输出是不同文本的任务

为什么都是De?
- 任务被统一成预测下一个token
- 海量无标注文本直接自监督训练
- 能力随规模涌现

多头注意力MHA
- 显存爆炸 每个head要为序列的所有token保存KVCache 占用夸张 memory bound
- 访问存储慢 sftmax的N*N注意力矩阵频繁读写 存在内存带宽瓶颈
- N*N的复杂度

MQA改进
- 暴力共享KV 所有head共享一份KV 只有Q是每个head独立
- KVCache变为1/H
- 表达能力下降

GQA折中改进
- 分组查询注意力
- H个head分为Q组 每组共享一个KVCache
- 存在甜蜜点 显存大幅下降但效果几乎不损失

MLA改进
- 不共享KVCache
- 每个token的K/V通过降维投影压缩到低维 需要时投影回来

Flash Attention 
- HBM 高带宽显存 大而慢 N*N在其上读写
- SRAM 片上缓存 小而快
- 思路 QKV切成小块在SRAM上计算 + 在线softmax 计算结果增量更新

# 位置编码
- 绝对位置编码 sin cos 在每个位置固定 加到embedding 简单 长距离效果下降
- 旋转位置编码RoPE 不加 而且旋转QK 位置越后旋转角度越大 两个token计算注意力时 QK点积带上了相对距离信息 长上下文可外推 兼容现代推理优化 主流
- 线性偏执注意力 ALiBi 距离惩罚

# 分词器
- 字符级 字符本身语义信息太少
- 词级别 会出现OOV 未登录词 中文分词错了下游全错
- 子词 上面二者的甜蜜点 可以理解为语素 类似 -ist -ism 常见的有 BPE Unigram WordPiece
 - BPE 从最小字符开始反复合并 直到词汇表达到预设大小
 
# 模型训练
- 预训练 做预测下一个token的事情
- SFT 续写机器变成对话机器 训练格式从连续长文本 变为 （指令，期望回答）对 避免无限续写 学习回答格式
- RLHF 对齐 人类打分 训练奖励模型 -> 对话风格 SFT后的都是Post-Training
    - 强化学习算法PPO来调整参数 让答案获得尽可能高的分
    - DPO 直接偏好优化 不需要奖励模型 （问题，好回答， 差回答）三元组训练

# 微调
- 微调是最后手段
- 一般先few shot 、RAG解决
- LoRA改小部分参数 Low Rank Adaptation 降低参数 不改原模型 用小矩阵打补丁
- QLoRA 改 + 量化 降低显存
- 和 SFT 、DPO 正交

# 温度
- 温度越高 概率分布越均匀 候选词之间差别越小 
- T = 1 临界点 概率分布不变
- T=0永远选概率最高的
- TOPK 限制候选词数量 假设为N 则永远只从概率TOPN的里面选
- TOPP 累加概率 概率内的词为候选词 前N个词到了概率p 则候选为前N

# KVCache
- 对单次推理的优化 自回归生成
- 每次生成新token都要对前面的所有token计算注意力 N个token总计算量N^3 
- KVCache缓存前面所有token的KV 每次新token只计算自己的 Q K V 计算量降到N^2
- 显存会一直占用 优化：量化 PagedAttention MQA GQA
 - 量化 FP16 ->INT8 甚至 INT4（当前甜蜜点） 高精度浮点数映射到低精度整数
 - 分页 vLLM创新 来自OS的虚拟内存 KVCache切成Block 请求拿逻辑Block列表去访问物理Block 利用率提升

# Prompt Caching
- 对有相同前缀的prompt 保留KVCache 跳过计算 复用KVCache
- 对不同请求之间的缓存共享
- Claude的做法：显示标记缓存端点 OPENAI是自动缓存
- 固定内容一定要放在前面 动态的放后面

# Prompt构造
- 角色
- 任务
- 上下文 背景信息
- 格式
- 示例
用XML标签包裹
CoT触发词：请先分步分析 再给出结论

# MoE
混合专家模型
- 每层的FFN替换成N个并行的专家网络 token进入MoE层根据Router选专家
- 总参数（知识量）大但激活参数（推理成本）小
- 要添加负载均衡 以防专家被Router偏爱
- 训练难度高 显存占用高 Router不稳定 分布式并行复杂 因为涉及多个专家 通信开销增加

传统的Dense模型(标准Transformer)
- 每个Token推理都要走一遍模型的全部参数
- 参数越多 推理增加
- MoE打破了参数和推理成本的绑定

# 推理框架
推理存在的问题
- 显存碎片
- 批处理调度低效
- 重复计算


vLLM
- PagedAttention
- 连续批处理 请求异步加入和退出
SGLang
- RadixAttention 多请求共享前缀组织为树结构
TGI
- HuggingFace生态
llama.cpp
- CPU 边缘设备事实标准

# 模型选择
- GPT-5.5 / o 复杂推理 多模态 代码
- Claude Sonnet / Opus 长文本 代码 Agent