# 应用层
- HTTP 无状态
 - 1.0 短链接 缓存机制为 Last-Modified标记在服务器端的最后一次修改 请求头中If-Modified-Since（填 Last-Mod）向服务器询问
  - 如果确实没有修改过 Server返回 304 Not Modified 表示可以从浏览器用缓存 反之 返回新的200响应
 - 1.1 TCP 默认开启长连接Keep_alive 一个TCP可以被多个HTTP复用 带宽优化 Partial Content
  - 增加了Cache Control Entity Tag  If-Match
 - 2 TCP 多路复用 并行传输 减少HTTP队头阻塞 头部压缩 仍存在TCP队头阻塞
 - 3 QUIC 基于UDP 降低连接建立开销 缓解TCP队头阻塞

- websocket 
 - 全双工
 - 心跳机制 ping pong帧

- SMTP 
 - 邮件发送 邮件服务器的转发 TCP
- POP3 IMAP
 - 用户从服务器拉邮件 TCP

- FTP
 - 两条连接
 - 控制连接
 - 数据连接

- Telnet 23
 - 明文传输 所以被SSH 22替代

- RTP
 - 基于UDP
 - 实时音视频

- DNS
 - UDP为主 也有TCP
 - 先查浏览器缓存
 - 本地解析器（服务提供商提供的服务器）
 - 根服务器 世界上只有13组 我国没有
 - 顶级域名服务器 com org net edu等
 - 权威服务器
- 工作流程
 - 递归 洋葱模型 本地直接请求根 后续根单独请求 最后由根返回
 - 迭代 让本地DNS依次请求 根 顶级 权威


HTTPS
- HTTP + TLS（由SSL演化 SSL已废弃
- HTTP明文传输
- 通信用对称加密 也即一个密钥
- 对称加密的密钥通过非对称（公私钥）加密在握手时协商生成 RSA ECDHE
 - 公钥加密 私钥解密
  - 最开始可以假冒身份 伪装服务器的身份 用攻击者的公钥来替代服务器公钥
  - 所以需要CA证书（受信任的第三方 证书有签名
  - C 向 Server请求时一定要先获取S的证书 根据签名来校验合法性（通过第三方给的公钥来解密 此时是公钥解密 私钥加密

设有服务器 S，客户端 C，和第三方信赖机构 CA。
S 信任 CA，CA 是知道 S 公钥的，CA 向 S 颁发证书。并附上 CA 私钥对消息摘要的加密签名。
S 获得 CA 颁发的证书，将该证书传递给 C。
C 获得 S 的证书，信任 CA 并知晓 CA 公钥，使用 CA 公钥对 S 证书上的签名解密，同时对消息进行散列处理，得到摘要。比较摘要，验证 S 证书的真实性。
如果 C 验证 S 证书是真实的，则信任 S 的公钥（在 S 证书中）。

RPC 不是协议 是一种远程方法调用 让调远程的方法像本地函数一样 
- HTTP 面向资源，RPC 面向方法；HTTP 对外，RPC 对内；RPC 性能更好。
- 默认使用 Protobuf 作为 IDL 和消息序列化格式
- RPC 框架通常会和治理能力绑在一起，比如超时控制、负载均衡、服务发现、熔断降级、链路追踪、调用统计等。gRPC（基于HTTP 2） 官方介绍里也提到，它支持负载均衡、Tracing、健康检查和认证等可插拔能力。
## TCP 传输层 
面向字节流 相反UOP面向报文
握手
- C -> S SYN seq=x 等待S确认
- S -> C SYN + ACK 同意 seq=y ack=x + 1
- C -> S ACK ack=y+1 连接变为ESTABLISHED
挥手
- 任意一方 以C为例 FIN seq=u
- S ACK ack=u+1 此时连接处于半关闭
- S 还是S FIN seq=v ack还是上一个u+1
- C ACK ack=v+1 等待2MSL后C关闭（在最大报文生存时间内有可能ACK会丢 所以要等待）

数据可靠性
- 超时重传 ARQ
- 滑动窗口 流量控制
- 基于数据块传输 拥塞控制
- 失序数据会重新排序

TCP和UDP可以使用同一个端口 按协议区分
## 状态码
1x 信息码
2x 成功 201已创建新资源 202已接收还未处理 204 NotContent处理了但是没返回内容
3x 重定向 301永久 302临时
4x 客户端错误 400 Bad Request  401未认证 403非法请求被拒绝 
5x 服务器错误 502 Bad Gateway 
## 端口汇总
HTTP	80	TCP	Web 页面访问
HTTPS	443	TCP / QUIC	加密 Web 访问
WebSocket	80 / 443	TCP	双向实时通信
SMTP	25 / 465 / 587	TCP	邮件发送和转发
POP3	110 / 995	TCP	邮件接收
IMAP	143 / 993	TCP	邮件接收和同步
FTP	20 / 21	TCP	文件传输
SSH	22	TCP	安全远程登录和文件传输
Telnet	23	TCP	明文远程登录
DNS	53	UDP / TCP	域名解析
RTP	动态端口（偶数），RTCP 用相邻奇数	UDP 为主	实时音视频传输

# 网络层
## ARP 
IP -> MAC 通过广播 单播响应来解析地址
分为局域网内和跨局域网的寻址
## NAT 
私网公网映射