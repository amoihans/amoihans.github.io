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

提供 AI 接工具的行业标准 类似USB
- Tool 副作用操作
- Resources 只读数据
- Prompts 提示词模板
通信
- JSON-RPC
 两种传输
 - stdio 本地子进程工具
 - streamable HTTP HTTP服务工具 /mcp 新方案 一个端点 短请求返回JSON响应 长请求SSE流
 - HTTP + SSE (老版本 ) 双端点 GET端开SSE长链接收推送 POST端点发送请求
之前
- 接外部工具 碎片化 难复用 强绑定
现在
- 工具提供方实现MCP Server
- 使用方直接对接 
组成
- HOST 调用MCP的系统 调用多个cs的MCP
- Tools Resources Prompts
- JSON-RPC
接入示例
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/yourname/Documents"
      ]
    }
  }
}

{
  "mcpServers": {
    "calculator": {
      "command": "python",
      "args": [
        "/path/to/your/calculator_server.py"
      ]
    }
  }
}
```
代码
```py
import asyncio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# 1. 创建一个 Server 实例，名字叫 "calculator"
app = Server("calculator")

# 2. 定义工具列表 (告诉 Client 我有什么功能)
@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="add_numbers",
            description="计算两个数字的和",
            inputSchema={
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "第一个数字"},
                    "b": {"type": "number", "description": "第二个数字"}
                },
                "required": ["a", "b"]
            }
        )
    ]

# 3. 实现工具的具体逻辑
@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "add_numbers":
        a = arguments.get("a", 0)
        b = arguments.get("b", 0)
        result = a + b
        
        # 返回结果，必须是 TextContent 格式
        return [
            TextContent(
                type="text",
                text=f"计算结果: {result}"
            )
        ]
    
    # 如果工具名不认识，返回错误
    return [TextContent(type="text", text=f"未知工具: {name}")]

# 4. 启动 Server (使用标准输入输出模式)
async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
```
不支持MCP协议的推理模型
- 推理模型有思维链 不能中途打断 思维链结束才生成答案
- 工具调用是多轮交互 有中途暂停 不支持FC 因此不支持MCP
- 有折中方案 例如 COT结束后再FC
# Skill
包含
- 指令 SKILL.MD文件
- 脚本 函数
- 模板 操作步骤
与PROMPT区别
- 被Agent自动发现按需加载
与MCP区别
- 告诉Agent怎么用工具和数据

结构
```shell
code-review/                  # Skill 文件夹，名字就是这个 Skill 的标识
├── SKILL.md                  # 核心指令文件（必须有）
├── scripts/                  # 可选：可执行的脚本
│   └── check_security.py     # 比如一个安全检查脚本
├── references/               # 可选：参考文档
│   └── review_standards.md   # 比如团队的审查标准文档
└── assets/                   # 可选：模板、资源文件
    └── report_template.md    # 比如审查报告的输出模板
```
渐进式披露
- 一开始只看 name + desc
- 加载SKILL.md正文 读取指令
- 加载assets里面的模板

# A2A
- 单个Agent有自己的上下文和SKILL
- 并行处理
- 调度Agent委托一个任务就创建一个Task 接收方执行 把结果作为Task的产出artifacts返回

状态
- submitted -> working
- completed
- failed

通知方式
- 主动轮询
- 完成后回调
# 协议
websocket
- 全双工
- 有状态 -> 扩展麻烦 代理和防火墙穿透
- 支持非文本传输
- TCP
sse
- 单向 文本传输 HTTP1.1连接数有限
- 基于HTTP 无状态
- Accept: text/event-stream
- data: 响应体无限长 

webrtc
- udp 丢包不等重传 用插值算法填补
- 用音质损失换低时延
- 内置回声消除 噪声抑制 自适应码率
- 是一套协议族 SRTP RTCP DTLS UDP
- ICE 建立NAT穿透 SDP作为信令
- NAT穿透 STURN TURN服务器

# 网关
litellm
- 多模型统一接口
- API key集中管理
- 限流和配额
- 语义缓存
- 负载均衡 故障转移