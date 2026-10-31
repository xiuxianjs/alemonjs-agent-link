// src/dictionary/history.ts
const dictionarySources = {
	y2016: {
		title: "新华社：2016流行语",
		url: "https://www.xinhuanet.com/politics/2016-12/17/c_1120135910.htm"
	},
	y2017: {
		title: "教育部：2017网络用语",
		url: "https://www.moe.gov.cn/s78/A19/moe_814/201712/t20171219_321948.html"
	},
	y2018: {
		title: "人民网：2018网络用语",
		url: "https://edu.people.com.cn/n1/2018/1220/c1006-30477481.html"
	},
	y2019: {
		title: "教育部：2019网络用语",
		url: "https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/201912/t20191202_410477.html"
	},
	y2020: {
		title: "教育部：2020网络用语",
		url: "https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202012/t20201204_503560.html"
	},
	y2021: {
		title: "中国大学生在线：2021网络用语",
		url: "https://dxs.moe.gov.cn/zx/a/jj/211207/1739940.shtml"
	},
	y2022: {
		title: "人民论坛：2022年度流行语分析",
		url: "https://paper.people.com.cn/rmlt/html/2023-02/20/content_25984584.htm"
	},
	y2023: {
		title: "中国青年网：2023流行语",
		url: "https://news.youth.cn/jsxw/202312/t20231205_14945078.htm"
	},
	y2023b: {
		title: "商务印书馆：2023汉语盘点",
		url: "https://www.cp.com.cn/Content/2024/01-02/1642250518.html"
	},
	y2024: {
		title: "快科技：抖音2024年度热梗（凤凰网转载）",
		url: "https://i.ifeng.com/c/8fRNtgLej2w"
	},
	y2024b: {
		title: "国家语言资源监测网络媒体中心：历年榜单",
		url: "https://nlp.ccnu.edu.cn/conference/15"
	},
	y2025: {
		title: "新华社：2025年度网络流行语",
		url: "https://app.xinhuanet.com/news/article.html?articleId=d5f1a0210686fc9d33d13681d706b2f4"
	}
};
const dictionaryHistory = [
	{
		term: "洪荒之力",
		aliases: [],
		year: 2016,
		platforms: ["跨平台"],
		definition: "夸张地说已经用出全部力气，常用于努力后的自嘲。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "吃瓜群众",
		aliases: ["吃瓜"],
		year: 2016,
		platforms: ["跨平台"],
		definition: "围观热闹的人；围观不代表传闻已被证实。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "友谊的小船说翻就翻",
		aliases: ["友谊的小船", "友谊的小船，说翻就翻"],
		year: 2016,
		platforms: ["跨平台"],
		definition: "用翻船比喻朋友因小事闹别扭，多用于玩笑，不必理解为正式绝交。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "葛优躺",
		aliases: [],
		year: 2016,
		platforms: ["跨平台"],
		definition: "形容整个人瘫靠着放空的姿态，常用来表达疲惫或想休息。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "套路",
		aliases: ["全是套路"],
		year: 2016,
		platforms: ["跨平台"],
		definition: "指有设计的说法或做法，网络语境常吐槽被引导、被算计；也有普通方法之义。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "蓝瘦香菇",
		aliases: ["蓝瘦，香菇"],
		year: 2016,
		platforms: ["跨平台"],
		definition: "难受、想哭的谐音式表达，不是食物名称。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "小目标",
		aliases: ["定个小目标"],
		year: 2016,
		platforms: ["跨平台"],
		definition: "可以认真指阶段目标，也可反讽看似轻描淡写、实际很难达到的目标。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "一言不合就",
		aliases: [],
		year: 2016,
		platforms: ["跨平台"],
		definition: "固定造句模板，夸张地形容突然或动不动就做某事，不一定真的发生争执。",
		sourceIds: ["y2016"],
		checkedAt: "2026-10-31"
	},
	{
		term: "打call",
		aliases: ["打call支持"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "表示为人或事应援、喝彩，不是要求拨电话。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "尬聊",
		aliases: [],
		year: 2017,
		platforms: ["跨平台"],
		definition: "对话缺乏话题却勉强继续的尴尬交流。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "扎心了老铁",
		aliases: ["扎心了，老铁"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "熟人式地表达被一句话戳中痛点，不一定在指责对方。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "皮皮虾我们走",
		aliases: ["皮皮虾，我们走"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "搞怪地表示出发或带人离开，不是实际交通安排。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "惊不惊喜意不意外",
		aliases: ["惊不惊喜，意不意外"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "强调出乎预料，可表示惊喜，也可反讽突然遇到麻烦。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "还有这种操作",
		aliases: ["还有这种操作？"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "对意想不到的办法或发展表示惊讶。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "你的良心不会痛吗",
		aliases: ["你的良心不会痛吗？"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "夸张质问，多带调侃；不能据此断言对方品行。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "你有freestyle吗",
		aliases: ["freestyle"],
		year: 2017,
		platforms: ["跨平台"],
		definition: "询问即兴发挥能力的梗；音乐场景仍可能是字面意思。",
		sourceIds: ["y2017"],
		checkedAt: "2026-10-31"
	},
	{
		term: "锦鲤",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "借幸运鱼形象指好运的人或祈求好运，不意味着转发能改变运气。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "杠精",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "贬义地指为反对而争辩的人；不同意见本身不是抬杠，不宜直接给用户贴标签。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "佛系",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "形容不过度争抢、随缘的态度，不等于宗教信仰。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "确认过眼神",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "借对上眼神表达已经认出某类人或事的造句梗。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "官宣",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "指正式公开宣布，个人使用也可能只是郑重分享消息。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "C位",
		aliases: ["c位"],
		year: 2018,
		platforms: ["跨平台"],
		definition: "指群体的中心或最受关注的位置。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "土味情话",
		aliases: [],
		year: 2018,
		platforms: ["跨平台"],
		definition: "故意用俗套、双关或转折制造亲近与尴尬笑点的情话。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "皮一下",
		aliases: ["皮一下很开心"],
		year: 2018,
		platforms: ["跨平台"],
		definition: "表示故意开个小玩笑或做一点调皮举动，不是越界免责理由。",
		sourceIds: ["y2018"],
		checkedAt: "2026-10-31"
	},
	{
		term: "柠檬精",
		aliases: [],
		year: 2019,
		platforms: ["跨平台"],
		definition: "自嘲或调侃羡慕得发酸的人，不是认真的人格诊断。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "好嗨哟",
		aliases: [],
		year: 2019,
		platforms: ["跨平台"],
		definition: "夸张表达兴奋、开心，也可带反讽。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "是个狠人",
		aliases: [],
		year: 2019,
		platforms: ["跨平台"],
		definition: "调侃某人的做法果断、出人意料或对自己下得去手。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "雨女无瓜",
		aliases: [],
		year: 2019,
		platforms: ["跨平台"],
		definition: "与你无关的谐音梗，不是讨论雨或瓜。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "硬核",
		aliases: [],
		year: 2019,
		platforms: ["跨平台"],
		definition: "形容内容、实力或做法扎实强劲；具体褒贬看场景。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "道路千万条安全第一条",
		aliases: ["道路千万条，安全第一条"],
		year: 2019,
		platforms: ["跨平台"],
		definition: "用熟悉的警示句式提醒注意安全，也被用于仿写。",
		sourceIds: ["y2019"],
		checkedAt: "2026-10-31"
	},
	{
		term: "秋天的第一杯奶茶",
		aliases: [],
		year: 2020,
		platforms: ["跨平台"],
		definition: "借季节里的饮品表达关心与仪式感，不等于对方有义务送礼。",
		sourceIds: ["y2020"],
		checkedAt: "2026-10-31"
	},
	{
		term: "奥利给",
		aliases: [],
		year: 2020,
		platforms: ["跨平台"],
		definition: "表示加油、振奋或强烈肯定的喊话梗，具体含义结合场景。",
		sourceIds: ["y2020"],
		checkedAt: "2026-10-31"
	},
	{
		term: "好家伙",
		aliases: [],
		year: 2020,
		platforms: ["跨平台"],
		definition: "表示惊讶、佩服或无奈的感叹，不一定真在评价人品。",
		sourceIds: ["y2020"],
		checkedAt: "2026-10-31"
	},
	{
		term: "集美",
		aliases: [],
		year: 2020,
		platforms: ["跨平台"],
		definition: "姐妹的谐音式亲昵称呼，关系与对方接受程度优先。",
		sourceIds: ["y2020"],
		checkedAt: "2026-10-31"
	},
	{
		term: "云监工",
		aliases: [],
		year: 2020,
		platforms: ["跨平台"],
		definition: "通过网络画面围观施工或其他进程的调侃，不代表拥有现场监督权。",
		sourceIds: ["y2020"],
		checkedAt: "2026-10-31"
	},
	{
		term: "YYDS",
		aliases: ["永远的神"],
		year: 2021,
		platforms: ["跨平台"],
		definition: "永远的神的拼音首字母缩写，用于强烈赞叹，也可反讽。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "破防",
		aliases: ["破防了"],
		year: 2021,
		platforms: ["跨平台"],
		definition: "从防线被突破引申为情绪被触动，可能感动也可能恼怒，不能见词就扣心情。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "绝绝子",
		aliases: [],
		year: 2021,
		platforms: ["跨平台"],
		definition: "夸张表达很棒或非常强烈的感受，讽刺语境也可能指糟糕。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "躺平",
		aliases: [],
		year: 2021,
		platforms: ["跨平台"],
		definition: "表示暂时退出高压竞争或降低欲望，不等于承诺永久放弃生活。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "伤害性不高侮辱性极强",
		aliases: ["伤害性不高，侮辱性极强"],
		year: 2021,
		platforms: ["跨平台"],
		definition: "夸张描述实际损失不大、心理落差却很强的尴尬场面。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "我看不懂但我大受震撼",
		aliases: ["我看不懂，但我大受震撼"],
		year: 2021,
		platforms: ["跨平台"],
		definition: "对难理解却有强烈冲击的内容感叹，不代表已经理解或认可。",
		sourceIds: ["y2021"],
		checkedAt: "2026-10-31"
	},
	{
		term: "栓Q",
		aliases: ["栓q", "我真的会谢"],
		year: 2022,
		platforms: ["跨平台"],
		definition: "由thank you的音译玩法延伸，常吐槽无语、无奈，不总是真道谢。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "大冤种",
		aliases: ["冤种"],
		year: 2022,
		platforms: ["跨平台"],
		definition: "自嘲花了冤枉钱或吃了亏；不宜用来羞辱真实用户。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "退退退",
		aliases: ["退！退！退！"],
		year: 2022,
		platforms: ["跨平台"],
		definition: "用夸张驱赶语气表达想赶走烦恼或不想接受的事，不是有效法术。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "嘴替",
		aliases: [],
		year: 2022,
		platforms: ["跨平台"],
		definition: "说出了自己想说却没说出口的话的人或内容。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "服了你个老六",
		aliases: ["你个老六", "老六"],
		year: 2022,
		platforms: ["跨平台"],
		definition: "游戏和聊天中吐槽意外、隐蔽或出其不意的行为，可能亲昵也可能不满。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "雪糕刺客",
		aliases: [],
		year: 2022,
		platforms: ["跨平台"],
		definition: "调侃外观平常、结账时才发现价格超预期的雪糕，也引申到其他高价商品。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "精神内耗",
		aliases: [],
		year: 2022,
		platforms: ["跨平台"],
		definition: "日常比喻反复纠结、自我消耗的体验，不是临床诊断。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "拿捏",
		aliases: [],
		year: 2022,
		platforms: ["跨平台"],
		definition: "形容把握住技巧、节奏或对方反应，也可能是在开玩笑。",
		sourceIds: ["y2022"],
		checkedAt: "2026-10-31"
	},
	{
		term: "显眼包",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "形容在人群中特别抢眼、爱展示或自带笑点的人，可褒可贬，不自动等于冒犯。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "搭子",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "围绕吃饭、运动或游戏等具体活动结成的伙伴，不自动意味着恋爱。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "双向奔赴",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "双方都愿意付出和靠近，不要求关系必须浪漫。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "多巴胺穿搭",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "用明亮、鲜艳搭配营造愉快感的穿搭说法，不是实际神经递质检测。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "特种兵式旅游",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "调侃短时间密集打卡多处景点的旅行方式，不是军事训练。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "质疑理解成为",
		aliases: [
			"质疑",
			"理解",
			"成为"
		],
		year: 2023,
		platforms: ["跨平台"],
		definition: "描述从不认同到理解、再到自己也变成同类的态度转折模板。",
		sourceIds: ["y2023"],
		checkedAt: "2026-10-31"
	},
	{
		term: "主打一个",
		aliases: ["主打一个XX"],
		year: 2023,
		platforms: ["跨平台"],
		definition: "造句模板，突出某种态度或特点，常用于自嘲。",
		sourceIds: ["y2023b"],
		checkedAt: "2026-10-31"
	},
	{
		term: "命运的齿轮开始转动",
		aliases: [],
		year: 2023,
		platforms: ["跨平台"],
		definition: "用戏剧化说法描述一个后来显得重要的转折，不是确定的命运预测。",
		sourceIds: ["y2023b"],
		checkedAt: "2026-10-31"
	},
	{
		term: "city不city",
		aliases: ["city不city啊"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "短视频语境中调侃洋气、都市感或新鲜刺激的感觉，不是严格的城市等级标准。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "偷感",
		aliases: ["偷感很重"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "调侃做事拘谨、怕被注意的状态，不表示真的实施偷窃。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "passion",
		aliases: ["人生需要passion"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "用热情、干劲的呼喊鼓励投入，不要求持续亢奋。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "头好痒要长脑子了",
		aliases: ["头好痒，要长脑子了"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "学到东西后故作惊讶的自嘲；真实头痒应按字面理解。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "我有一个帽衫",
		aliases: [],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "短视频中的穿帽衫外形反差梗，适合熟悉素材时接话，不照搬评价用户外貌。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "嘻嘻不嘻嘻",
		aliases: ["嘻嘻，不嘻嘻"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "用前后对比描述开心突然变成失落或尴尬。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "那咋了",
		aliases: [],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "口语式反问，玩梗时可表达不再内耗；对方倾诉时用它可能显得敷衍。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "已读乱回",
		aliases: [],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "调侃看完消息后故意答非所问，认真提问不能借此敷衍。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "next level",
		aliases: ["nextlevel"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "形容进入更高水平或新阶段，也可夸张描述变化。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "坏猫之歌",
		aliases: [],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "围绕猫咪调皮行为的歌曲与二创梗，不把宠物玩笑当真实罪行。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "尔滨你让我感到陌生",
		aliases: ["尔滨，你让我感到陌生"],
		year: 2024,
		platforms: ["抖音", "跨平台"],
		definition: "以哈尔滨旅游服务变化表达熟悉地方出现新面貌，也用于仿写。",
		sourceIds: ["y2024"],
		checkedAt: "2026-10-31"
	},
	{
		term: "班味",
		aliases: ["班味儿"],
		year: 2024,
		platforms: ["跨平台"],
		definition: "调侃工作带来的疲惫、拘谨或职业习惯，不是真实气味。",
		sourceIds: ["y2024b"],
		checkedAt: "2026-10-31"
	},
	{
		term: "松弛感",
		aliases: [],
		year: 2024,
		platforms: ["跨平台"],
		definition: "形容面对事情不紧绷、较自在的状态，不代表没有准备或责任。",
		sourceIds: ["y2024b"],
		checkedAt: "2026-10-31"
	},
	{
		term: "含金量还在上升",
		aliases: [],
		year: 2024,
		platforms: ["跨平台"],
		definition: "夸张描述某件事的价值随更多信息或对比继续显现。",
		sourceIds: ["y2024b"],
		checkedAt: "2026-10-31"
	},
	{
		term: "敬自己一杯",
		aliases: [],
		year: 2025,
		platforms: ["跨平台"],
		definition: "借敬酒句式肯定自己的坚持和经历，不必真的饮酒。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	},
	{
		term: "助我破鼎",
		aliases: [],
		year: 2025,
		platforms: ["跨平台"],
		definition: "借突破束缚的意象表达求助或希望冲破困境，不表示真实法术。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	},
	{
		term: "基础不基础",
		aliases: ["基础的", "不基础的"],
		year: 2025,
		platforms: ["跨平台"],
		definition: "造句模板，区分表面日常与背后不容易的能力、坚持或条件。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	},
	{
		term: "千百次练习只为这一刻",
		aliases: [],
		year: 2025,
		platforms: ["跨平台"],
		definition: "以重复练习衬托关键时刻，既可认真励志，也可用于反差玩笑。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	},
	{
		term: "如何呢又能怎",
		aliases: ["如何呢，又能怎"],
		year: 2025,
		platforms: ["跨平台"],
		definition: "以口语反问表达看开一点或无奈，不适合打断严肃倾诉。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	},
	{
		term: "来财",
		aliases: [],
		year: 2025,
		platforms: ["跨平台"],
		definition: "表达期待收入或好运；也可指歌曲相关二创，不保证实际收益。",
		sourceIds: ["y2025"],
		checkedAt: "2026-10-31"
	}
];

export { dictionaryHistory, dictionarySources };