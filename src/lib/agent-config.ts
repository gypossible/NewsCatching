export const expertProfile = {
  id: 361210101146458,
  name: "舆情监测助手",
  description:
    "一个专业的舆情监测和分析助手，聚焦品牌监测、危机预警、热点追踪、竞品分析与分析报告生成。",
  iconUrl:
    "https://cdn.hailuoai.com/matrix_agent/20260130/image_tool/output/101232_3ff6/workspace/imgs/opinion_monitor_icon.png",
  model: "MiniMax-M2.1",
  note:
    "当前版本基于公开新闻 RSS 与手工补充信号运行，后续可以继续接微博、抖音、小红书或企业内部数据源。",
  capabilities: [
    {
      title: "关键词监测",
      detail: "围绕品牌、人物、事件或产品词，持续抓取公开信号并形成关注清单。",
    },
    {
      title: "热点追踪",
      detail: "汇总近时段高频主题，识别舆论焦点转移与讨论升温节点。",
    },
    {
      title: "情绪分析",
      detail: "对采集到的标题、摘要与手工补充信号做正负向判断与风险评分。",
    },
    {
      title: "报告生成",
      detail: "输出快报、深度报告骨架、行动建议和后续观察列表。",
    },
  ],
  subAgents: [
    {
      name: "新闻分析员",
      description: "负责公开新闻、媒体报道和来源分布的梳理与研判。",
    },
    {
      name: "社媒监测员",
      description: "负责微博、小红书、评论区、客服工单等补充信号的归纳。",
    },
    {
      name: "报告总控",
      description: "汇总各路信号，输出风险等级、趋势结论与沟通建议。",
    },
  ],
  quickPrompts: [
    {
      title: "品牌晨报",
      topic: "瑞幸咖啡",
      focus: "brand" as const,
      timeframe: "24h" as const,
      keywords: "门店, 联名, 用户反馈, 咖啡, 价格",
      note: "输出今天的品牌声量快报，优先看负面反馈与媒体提法变化。",
    },
    {
      title: "危机预警",
      topic: "理想汽车",
      focus: "crisis" as const,
      timeframe: "7d" as const,
      keywords: "事故, 维权, 安全, 召回, 投诉",
      note: "识别是否存在升级为危机事件的信号，并给出响应动作。",
    },
    {
      title: "竞品对比",
      topic: "茶饮市场",
      focus: "competitor" as const,
      timeframe: "7d" as const,
      keywords: "蜜雪冰城, 霸王茶姬, 喜茶, 奈雪",
      note: "对比主要竞品讨论热度、媒体视角和情绪分布差异。",
    },
    {
      title: "活动复盘",
      topic: "新品发布会",
      focus: "campaign" as const,
      timeframe: "30d" as const,
      keywords: "发布会, 口碑, 传播, 热搜, 讨论",
      note: "生成活动复盘草稿，突出声量走势、亮点和改进建议。",
    },
  ],
};
