# NLP任务
- 中文分词 CWS
- 子词划分
 - Byte Pair Encoding
 - WordPiece
 - Unigram
 - SentencePiece
- 词性标注 PartOfSpeechTagging
 - 依赖RNN和LSTM
- 文本分类
- 实体识别 NER
- 关系抽取 RE
- 文本摘要
 - 抽取式 来自原文
 - 生成式
- 机器翻译 MT
## 词向量
- VSM 向量空间模型
- N-gram 马尔可夫链式规则假设 每个词出现的概率依赖于前面 N - 1个词 uni -> bi -> tri -> n
- Word2Vec 词袋模型
## 神经网络分类

### FNN 前馈
- 输入到输出层单向流动 无循环
- 一般各层全连接
- MLP 多层感知机
### CNN 卷积
- 参数量远远小于全连接
### RNN 循环
- 包含环和重复网络 
- 可以使用历史信息
- 衍生 LSTM 长短记忆网络
- 捕捉时序信息
缺点
- 无法并行 虽然参数量不大 但计算时间成本高
- 远距离的关系难以捕捉

