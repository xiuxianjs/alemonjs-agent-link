// src/qa/detection.ts
/**
* “为什么/为何”与“怎么用/指令在哪”两类疑问的入口判断。判断保持宽松：
* 只要出现问因词或指令求助词，就查一次问答库；由检索分数和类型决定有没有可用答案。
*/
const whyQuestionPattern = /(为什么|為什麼|为啥|為啥|为何|為何|何故|怎么会|怎麼會|怎么回事|怎麼回事|什么原因|什麼原因|啥原因|\bwhy\b|\bhow come\b|what(?:'s| is) the reason)/iu;
const commandHelpPattern = /((怎么|如何|咋)(用|使用|设置|设|开|关|查|看|发|换|调|改|加|绑|取消|删除|清除|清|开始|新|成为|成|当|提|问|记|忘|禁|静|踢|弄|操作|配|连|搜|搜索|存|保存|收藏|制作|做|引用|回复|恢复|整理|检索|导入|同步|管理|听|读|让|才)|用法|指令|命令|在哪|哪里|入口|\bhelp\b|\bhow to\b|\busage\b)/iu;
const commandTopicPattern = /(提问|chat|取消|cancel|新会话|new|聊天参考|状态|额度|余额|记忆|记住|忘记|群记忆|人格|语气|心情|语音|表情|画图|生图|工具策略|群设置|设置群|我的钥匙|授权钥匙|授权记录|群密钥|个人密钥|模型池|模型列表|当前模型|帮助|清除群数据|清除聊天记录|清除数据|删除数据|清理数据|聊天记录|删除记录|清除记录|清空聊天|清空上下文|清空记录|主动搭话|主动找我|隐私说明|模块状态|我是主人|我的主人|成为主人|开管理|申请管理|管理权限|管理员|唤醒词|禁语|静默|权限|网页|文件|密钥|key|apikey|groupapikey|禁言|踢人|公告|头衔|上下文|对话|艾特|@|＠|叫你|怎么问|怎么记|怎么忘|指令|命令|AI|机器人|图片|搜索|搜|查资料|群名|群成员|群资料|群人数|成员列表|收藏|制作|表情包|b站|bilibili|bv|空间|说说|qzone|记忆来源|恢复记忆|整理记忆|记忆检索|过时记忆|引用|回复|导入|同步)/iu;
const isWhyQuestion = (text) => {
	const value = String(text ?? "").trim();
	return value.length >= 2 && value.length <= 2e3 && whyQuestionPattern.test(value);
};
const isCommandQuestion = (text) => {
	const value = String(text ?? "").trim();
	return value.length >= 2 && value.length <= 2e3 && commandHelpPattern.test(value) && commandTopicPattern.test(value);
};
const isQaQuestion = (text) => isWhyQuestion(text) || isCommandQuestion(text);
/** 问答去重、精确包含和关键词判断共用的归一化方式。 */
const normalizeQaText = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");

export { isCommandQuestion, isQaQuestion, isWhyQuestion, normalizeQaText };