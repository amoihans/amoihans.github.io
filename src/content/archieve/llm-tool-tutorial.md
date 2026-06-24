# Func Calling
- Tools Descs -> Json schema
- llm根据desc选择 返回工具和带参数的json调用
- msg.finish_reason == "tool_calls":  
- 可以并行tool_call
```json
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",          # 工具的唯一标识，模型输出 tool_calls 时会用这个名字
            "description": "查询指定城市的实时天气，包含气温、天气状况、风向风速，仅支持中国大陆城市",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "城市名称，如「北京」「上海」，不要带省份前缀"
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"],
                        "description": "温度单位，默认用摄氏度"
                    }
                },
                "required": ["city"]
            }
        }
    }
]
```
## 如何训练出来的
- 预训练 只会描述工具调用意图 不知道怎么调
- SFT 监督微调
 - 一开始模型只有生成能力 没有工具调用
 - 给模型喂了大量 工具调用示范对话 来判断要不要调 输出调用格式 解决会不会调用的问题
- RLHF 基于人类反馈的强化学习
 - 训练打分器 奖励模型 学会什么时候调工具 建立调用边界 减少误调
 - 因为SFT里看的都是调用 所以调的场景占了大多数 简单问题也调
- RLAIF AI代替人工打分

- 数据哪里来
 - 人工标注手写 少量高质量
 - 模型自动生成 大量蒸馏

# MCP
