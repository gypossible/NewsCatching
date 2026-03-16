import { XMLParser } from "fast-xml-parser";

export type FocusArea = "brand" | "crisis" | "campaign" | "competitor";
export type Timeframe = "24h" | "7d" | "30d" | "1y";

export interface MonitorRequest {
  topic: string;
  keywords: string[];
  focus: FocusArea;
  timeframe: Timeframe;
  note?: string;
  manualSignals?: string;
}

export interface MonitorSignal {
  id: string;
  title: string;
  link?: string;
  source: string;
  summary: string;
  publishedAt: string;
  channel: "news" | "manual";
  sentiment: "positive" | "neutral" | "negative";
  riskFlag: boolean;
}

export interface MonitorReport {
  topic: string;
  focus: FocusArea;
  timeframe: Timeframe;
  collectedAt: string;
  totalSignals: number;
  riskLevel: "低" | "中" | "高";
  riskScore: number;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    label: string;
  };
  topThemes: string[];
  executiveSummary: string;
  newsDesk: string;
  socialDesk: string;
  reportLead: string;
  actions: string[];
  timeline: Array<{ label: string; count: number }>;
  sources: Array<{ name: string; count: number }>;
  highlights: MonitorSignal[];
  coverageNote: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: true,
  trimValues: true,
});

type FeedMode = "direct" | "proxy";

const POSITIVE_TERMS = [
  "支持",
  "利好",
  "增长",
  "创新",
  "回暖",
  "认可",
  "好评",
  "满意",
  "提振",
  "突破",
  "领先",
  "合作",
  "升级",
  "高光",
  "点赞",
];

const NEGATIVE_TERMS = [
  "投诉",
  "维权",
  "翻车",
  "争议",
  "危机",
  "下架",
  "封禁",
  "处罚",
  "事故",
  "谣言",
  "裁员",
  "暴跌",
  "崩盘",
  "差评",
  "失望",
  "泄露",
  "违规",
  "举报",
  "召回",
  "质疑",
];

const RISK_TERMS = [
  "事故",
  "处罚",
  "举报",
  "召回",
  "危机",
  "维权",
  "投诉",
  "违法",
  "暴跌",
  "爆雷",
  "致歉",
  "封禁",
  "停摆",
  "下架",
  "泄露",
  "火灾",
  "伤亡",
];

const TOKEN_STOPWORDS = new Set([
  "相关",
  "进行",
  "发布",
  "表示",
  "公司",
  "品牌",
  "市场",
  "用户",
  "产品",
  "事件",
  "问题",
  "平台",
  "舆情",
  "监测",
  "分析",
  "情况",
  "消息",
  "最新",
  "回应",
  "媒体",
  "方面",
  "今天",
  "目前",
  "已经",
  "因为",
  "可以",
  "以及",
  "我们",
  "他们",
  "此次",
  "这个",
  "那个",
]);

const FOCUS_LABELS: Record<FocusArea, string> = {
  brand: "品牌监测",
  crisis: "危机预警",
  campaign: "传播复盘",
  competitor: "竞品分析",
};

const TIMEFRAME_HOURS: Record<Timeframe, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "1y": 24 * 365,
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function shortenText(value: string | undefined, maxLength = 36) {
  const normalized = normalizeText(value ?? "");
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function safeDate(value?: string) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  return date;
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function formatBucket(date: Date, timeframe: Timeframe) {
  if (timeframe === "24h") {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai",
    }).format(date);
  }

  if (timeframe === "1y") {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      timeZone: "Asia/Shanghai",
    }).format(date);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function extractDomain(url?: string) {
  if (!url) {
    return "未知来源";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "未知来源";
  }
}

function classifySentiment(text: string) {
  const content = text.toLowerCase();
  const positiveHits = POSITIVE_TERMS.filter((term) => content.includes(term)).length;
  const negativeHits = NEGATIVE_TERMS.filter((term) => content.includes(term)).length;
  const riskFlag = RISK_TERMS.some((term) => content.includes(term));

  if (negativeHits > positiveHits) {
    return { sentiment: "negative" as const, riskFlag };
  }

  if (positiveHits > 0) {
    return { sentiment: "positive" as const, riskFlag };
  }

  return { sentiment: "neutral" as const, riskFlag };
}

function buildQueries(input: MonitorRequest) {
  const baseKeywords = [input.topic, ...input.keywords].filter(Boolean);
  const focusHint =
    input.focus === "crisis"
      ? " 投诉 争议 风险"
      : input.focus === "competitor"
        ? " 竞品 对比 市场"
        : input.focus === "campaign"
          ? " 传播 活动 热度"
          : " 声量 口碑";

  const googleRecency =
    input.timeframe === "24h"
      ? " when:1d"
      : input.timeframe === "7d"
        ? " when:7d"
        : input.timeframe === "30d"
          ? " when:30d"
          : " when:365d";
  const queries = [
    `${baseKeywords.join(" ")}${focusHint}`,
    `${input.topic} 新闻 舆论${focusHint}`,
    `${input.topic} 评论 趋势${focusHint}`,
  ];

  return {
    google: queries.map((query) => `${query}${googleRecency}`),
    bing: queries,
  };
}

function timeframeCutoff(timeframe: Timeframe) {
  return Date.now() - TIMEFRAME_HOURS[timeframe] * 60 * 60 * 1000;
}

function pickSourceName(source: unknown, link?: string) {
  if (typeof source === "string" && source.trim()) {
    return normalizeText(source);
  }

  if (source && typeof source === "object" && "text" in source) {
    const text = String((source as { text?: string }).text ?? "");
    if (text.trim()) {
      return normalizeText(text);
    }
  }

  return extractDomain(link);
}

async function fetchRssFeed(url: string, mode: FeedMode) {
  try {
    if (mode === "proxy") {
      const response = await fetch(
        `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
        {
          cache: "no-store",
        },
      );

      if (!response.ok) {
        return "";
      }

      const data = (await response.json()) as { contents?: string };
      return typeof data.contents === "string" ? data.contents : "";
    }

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OpinionMonitorBot/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    if (!response.ok) {
      return "";
    }

    return response.text();
  } catch {
    return "";
  }
}

function parseRssItems(xml: string) {
  if (!xml) {
    return [];
  }

  try {
    const data = parser.parse(xml);
    const items = toArray(data?.rss?.channel?.item);

    return items
      .map((item: Record<string, unknown>, index) => {
        const title = decodeHtmlEntities(String(item.title ?? ""));
        const summary = decodeHtmlEntities(
          String(item.description ?? item["content:encoded"] ?? ""),
        );
        const link = typeof item.link === "string" ? item.link : undefined;
        const published = safeDate(
          typeof item.pubDate === "string"
            ? item.pubDate
            : typeof item.published === "string"
              ? item.published
              : undefined,
        );
        const source = pickSourceName(item.source, link);
        const sentimentInfo = classifySentiment(`${title} ${summary}`);

        return {
          id: `${source}-${index}-${title}`.toLowerCase(),
          title,
          summary,
          link,
          source,
          publishedAt: published.toISOString(),
          channel: "news" as const,
          ...sentimentInfo,
        };
      })
      .filter((item) => item.title);
  } catch {
    return [];
  }
}

async function collectPublicSignals(input: MonitorRequest, mode: FeedMode) {
  const { google, bing } = buildQueries(input);

  const urls = google.map(
    (query) =>
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
  );

  if (mode === "direct") {
    urls.push(
      ...bing.map(
        (query) =>
          `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=zh-CN`,
      ),
    );
  }

  const xmlList = await Promise.all(urls.map((url) => fetchRssFeed(url, mode)));
  const cutoff = timeframeCutoff(input.timeframe);
  const seen = new Set<string>();

  return xmlList
    .flatMap((xml) => parseRssItems(xml))
    .filter((item) => safeDate(item.publishedAt).getTime() >= cutoff)
    .filter((item) => {
      const key = normalizeText(item.title).toLowerCase();
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        safeDate(right.publishedAt).getTime() - safeDate(left.publishedAt).getTime(),
    )
    .slice(0, mode === "proxy" && input.timeframe === "1y" ? 24 : 16);
}

function parseManualSignals(raw: string | undefined) {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line, index) => {
      const match = line.match(/^\[(.+?)\]\s*(.+)$/);
      const source = match?.[1]?.trim() || "手工补充";
      const title = match?.[2]?.trim() || line;
      const sentimentInfo = classifySentiment(title);

      return {
        id: `manual-${index}-${title}`,
        title,
        link: undefined,
        source,
        summary: "由用户手工补充的社媒/论坛/客服信号。",
        publishedAt: new Date(Date.now() - index * 5 * 60 * 1000).toISOString(),
        channel: "manual" as const,
        ...sentimentInfo,
      };
    });
}

function extractThemes(input: MonitorRequest, signals: MonitorSignal[]) {
  const seed = new Set([input.topic, ...input.keywords]);
  const counter = new Map<string, number>();
  const text = signals.map((signal) => `${signal.title} ${signal.summary}`).join(" ");

  for (const keyword of seed) {
    if (keyword.trim()) {
      counter.set(keyword.trim(), (counter.get(keyword.trim()) ?? 0) + 3);
    }
  }

  const candidates = text.match(/[A-Za-z]{4,}|[\u4e00-\u9fa5]{2,6}/g) ?? [];

  for (const candidate of candidates) {
    const token = candidate.trim();
    if (!token || TOKEN_STOPWORDS.has(token) || token === input.topic) {
      continue;
    }

    counter.set(token, (counter.get(token) ?? 0) + 1);
  }

  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([token]) => token);
}

function buildTimeline(signals: MonitorSignal[], timeframe: Timeframe) {
  const bucketMap = new Map<string, number>();

  for (const signal of signals) {
    const bucket = formatBucket(safeDate(signal.publishedAt), timeframe);
    bucketMap.set(bucket, (bucketMap.get(bucket) ?? 0) + 1);
  }

  return [...bucketMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-7)
    .map(([label, count]) => ({ label, count }));
}

function buildSourceDistribution(signals: MonitorSignal[]) {
  const sourceMap = new Map<string, number>();

  for (const signal of signals) {
    sourceMap.set(signal.source, (sourceMap.get(signal.source) ?? 0) + 1);
  }

  return [...sourceMap.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));
}

function buildSentiment(signals: MonitorSignal[]) {
  const totals = {
    positive: 0,
    neutral: 0,
    negative: 0,
  };

  for (const signal of signals) {
    totals[signal.sentiment] += 1;
  }

  const base = Math.max(signals.length, 1);
  const negativeRatio = totals.negative / base;
  const positiveRatio = totals.positive / base;

  const label =
    negativeRatio >= 0.4
      ? "负向偏高"
      : positiveRatio >= 0.35
        ? "整体积极"
        : "观点分散";

  return {
    positive: Math.round((totals.positive / base) * 100),
    neutral: Math.round((totals.neutral / base) * 100),
    negative: Math.round((totals.negative / base) * 100),
    label,
    totals,
  };
}

function buildRiskLevel(signals: MonitorSignal[], sentiment: ReturnType<typeof buildSentiment>) {
  const negativeWeight = sentiment.totals.negative * 9;
  const riskHits = signals.filter((signal) => signal.riskFlag).length * 12;
  const manualEscalation = signals.filter((signal) => signal.channel === "manual").length * 4;
  const score = clamp(16 + negativeWeight + riskHits + manualEscalation, 8, 96);

  if (score >= 68) {
    return { riskScore: score, riskLevel: "高" as const };
  }

  if (score >= 38) {
    return { riskScore: score, riskLevel: "中" as const };
  }

  return { riskScore: score, riskLevel: "低" as const };
}

function buildExecutiveSummary(
  input: MonitorRequest,
  signals: MonitorSignal[],
  themes: string[],
  riskLevel: "低" | "中" | "高",
  sentiment: ReturnType<typeof buildSentiment>,
) {
  if (!signals.length) {
    return `过去 ${input.timeframe} 内暂未抓到与“${input.topic}”强相关的公开信号，建议补充更具体的关键词或粘贴社媒线索后再次分析。`;
  }

  const latest = signals[0];
  const themeText = themes.slice(0, 4).join(" / ") || input.topic;
  const noteText = shortenText(input.note);

  return `围绕“${input.topic}”已汇总 ${signals.length} 条信号，当前以“${themeText}”为主要讨论面向，情绪判断为“${sentiment.label}”，综合风险等级为 ${riskLevel}。最新一条高相关信号来自 ${latest.source}（${formatDate(
    safeDate(latest.publishedAt),
  )}）。${noteText ? `本轮任务要求聚焦“${noteText}”。` : ""}`;
}

function buildNewsDesk(signals: MonitorSignal[], sources: Array<{ name: string; count: number }>) {
  const newsSignals = signals.filter((signal) => signal.channel === "news");

  if (!newsSignals.length) {
    return "当前没有抓到足够的公开新闻信号，建议扩大关键词范围或增加英文别名。";
  }

  const leadSources = sources
    .filter((item) => item.name !== "手工补充")
    .slice(0, 3)
    .map((item) => `${item.name}${item.count > 1 ? `×${item.count}` : ""}`)
    .join("、");

  return `新闻分析员观察到，公开报道主要集中在 ${leadSources || "主流媒体"}，叙事焦点围绕 ${newsSignals
    .slice(0, 3)
    .map((item) => `“${item.title}”`)
    .join("、")}。建议优先核对标题中的事实描述与时间线是否一致。`;
}

function buildSocialDesk(signals: MonitorSignal[]) {
  const manualSignals = signals.filter((signal) => signal.channel === "manual");

  if (!manualSignals.length) {
    return "社媒监测员尚未收到微博、小红书、评论区或客服工单等补充线索，当前判断主要来自公开新闻 RSS。";
  }

  const negativeManual = manualSignals.filter((signal) => signal.sentiment === "negative");

  return `社媒监测员已接收 ${manualSignals.length} 条手工补充信号，其中 ${negativeManual.length} 条偏负向。用户补充内容主要集中在 ${manualSignals
    .slice(0, 3)
    .map((signal) => signal.source)
    .join("、")}，建议持续补充高热评论与客服原话来提高判断精度。`;
}

function buildReportLead(
  input: MonitorRequest,
  riskLevel: "低" | "中" | "高",
  riskScore: number,
  sentiment: ReturnType<typeof buildSentiment>,
  themes: string[],
) {
  const focusLabel = FOCUS_LABELS[input.focus];
  const themeText = themes.slice(0, 3).join("、") || input.topic;
  const noteText = shortenText(input.note, 28);

  return `${focusLabel}视角下，当前舆情风险评分为 ${riskScore}/100，判定为 ${riskLevel} 风险。建议围绕 ${themeText} 建立后续 watchlist，并重点盯住负向占比 ${sentiment.negative}% 的来源与触发语境。${noteText ? `输出已优先响应“${noteText}”这一任务要求。` : ""}`;
}

function buildActions(
  input: MonitorRequest,
  riskLevel: "低" | "中" | "高",
  signals: MonitorSignal[],
  themes: string[],
) {
  const actions = [
    `补齐“${input.topic}”的核心关键词、别名和竞品词，避免监测漏网。`,
    `把 ${themes.slice(0, 3).join(" / ") || "高频主题"} 设为下一轮持续观察标签。`,
  ];

  if (riskLevel === "高") {
    actions.unshift("在 2 小时内形成统一回应口径，明确事实、时间线与对外问答版本。");
    actions.push("同步客服、PR 与社媒运营，准备高频问题回复模板并观察二次扩散。");
  } else if (riskLevel === "中") {
    actions.unshift("保持 4 小时级别巡检，优先跟踪负向来源是否进入更高影响力媒体。");
    actions.push("准备一版 FAQ 或澄清话术，以便信号继续升温时快速响应。");
  } else {
    actions.unshift("维持日更快报节奏，重点观察是否出现新议题或跨平台迁移。");
    actions.push("把高正向信号沉淀为案例，以便后续活动或品牌内容复用。");
  }

  if (!signals.some((signal) => signal.channel === "manual")) {
    actions.push("补充评论区、客服记录或社区帖子，可显著提升社媒判断准确度。");
  }

  if (input.note?.trim()) {
    actions.push(`按“${shortenText(input.note, 24)}”复核本轮报告重点与结果写回内容。`);
  }

  return actions.slice(0, 5);
}

export function parseKeywordInput(raw: string) {
  return raw
    .split(/[，,\n]/)
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .slice(0, 8);
}

async function createMonitorReportWithMode(
  input: MonitorRequest,
  mode: FeedMode,
): Promise<MonitorReport> {
  const [publicSignals, manualSignals] = await Promise.all([
    collectPublicSignals(input, mode),
    Promise.resolve(parseManualSignals(input.manualSignals)),
  ]);

  const signals = [...manualSignals, ...publicSignals]
    .sort(
      (left, right) =>
        safeDate(right.publishedAt).getTime() - safeDate(left.publishedAt).getTime(),
    )
    .slice(0, 20);

  const themes = extractThemes(input, signals);
  const sentiment = buildSentiment(signals);
  const { riskLevel, riskScore } = buildRiskLevel(signals, sentiment);
  const sources = buildSourceDistribution(signals);

  return {
    topic: input.topic,
    focus: input.focus,
    timeframe: input.timeframe,
    collectedAt: new Date().toISOString(),
    totalSignals: signals.length,
    riskLevel,
    riskScore,
    sentiment: {
      positive: sentiment.positive,
      neutral: sentiment.neutral,
      negative: sentiment.negative,
      label: sentiment.label,
    },
    topThemes: themes,
    executiveSummary: buildExecutiveSummary(input, signals, themes, riskLevel, sentiment),
    newsDesk: buildNewsDesk(signals, sources),
    socialDesk: buildSocialDesk(signals),
    reportLead: buildReportLead(input, riskLevel, riskScore, sentiment, themes),
    actions: buildActions(input, riskLevel, signals, themes),
    timeline: buildTimeline(signals, input.timeframe),
    sources,
    highlights: signals.slice(0, 6),
    coverageNote:
      manualSignals.length > 0
        ? `本次报告已融合公开新闻 RSS 与手工补充的社媒/论坛线索。${input.note?.trim() ? `任务要求：${shortenText(input.note, 40)}。` : ""}`
        : `本次报告仅基于公开新闻 RSS 生成；如需更接近真实舆情，请粘贴微博、小红书或客服记录片段。${input.note?.trim() ? `任务要求：${shortenText(input.note, 40)}。` : ""}`,
  };
}

export async function createMonitorReport(input: MonitorRequest): Promise<MonitorReport> {
  return createMonitorReportWithMode(input, "direct");
}

export async function createBrowserMonitorReport(
  input: MonitorRequest,
): Promise<MonitorReport> {
  return createMonitorReportWithMode(input, "proxy");
}
