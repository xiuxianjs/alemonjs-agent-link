// src/dsh/failure-reply.ts
/** Operational notices are not answers to learn as FAQ or personal opinions. */
const isFailureReply = (text) => /这张图我没认出来|糟糕，网线断了|非常抱歉，我网卡没流量了|服务暂时不可用|模型服务暂时不可用|请稍后再试|回复因内容安全策略未发送|\[沉默\]|这次处理未完成|服务启动失败|工作区暂时无法访问|服务认证未通过|服务未能完成这次请求|暂时无法连接服务|这次请求等待超时|服务返回的内容无法处理|这次任务未完成|暂时无法读取会话信息|这次消息未能进入处理流程/u.test(text);

export { isFailureReply };