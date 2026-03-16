"use client";

import Image from "next/image";
import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";

import { expertProfile } from "@/lib/agent-config";
import {
  createBrowserMonitorReport,
  parseKeywordInput,
  type FocusArea,
  type MonitorReport,
  type Timeframe,
} from "@/lib/monitor";

import styles from "./monitor-dashboard.module.css";

type FormState = {
  topic: string;
  keywords: string;
  focus: FocusArea;
  timeframe: Timeframe;
  note: string;
  manualSignals: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  report?: MonitorReport;
};

const focusOptions: Array<{ value: FocusArea; label: string }> = [
  { value: "brand", label: "品牌监测" },
  { value: "crisis", label: "危机预警" },
  { value: "campaign", label: "传播复盘" },
  { value: "competitor", label: "竞品分析" },
];

const timeframeOptions: Array<{ value: Timeframe; label: string }> = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const loadingPhases = [
  "搜集公开新闻 RSS",
  "新闻分析员归纳来源与叙事",
  "社媒监测员合并手工补充线索",
  "报告总控生成风险判断与动作建议",
];

const initialForm: FormState = {
  topic: "",
  keywords: "",
  focus: "brand",
  timeframe: "24h",
  note: "",
  manualSignals: "",
};

function formatCollectedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function buildUserPrompt(form: FormState) {
  const lines = [
    `主题：${form.topic}`,
    `监测模式：${focusOptions.find((item) => item.value === form.focus)?.label}`,
    `时间窗：${timeframeOptions.find((item) => item.value === form.timeframe)?.label}`,
  ];

  if (form.keywords.trim()) {
    lines.push(`关键词：${form.keywords}`);
  }

  if (form.note.trim()) {
    lines.push(`分析要求：${form.note.trim()}`);
  }

  if (form.manualSignals.trim()) {
    lines.push("补充线索：已附加手工社媒/评论信号");
  }

  return lines.join("\n");
}

function riskBadgeClass(level: MonitorReport["riskLevel"]) {
  if (level === "高") {
    return styles.badgeHigh;
  }

  if (level === "中") {
    return styles.badgeMedium;
  }

  return styles.badgeLow;
}

export default function MonitorDashboard() {
  const [form, setForm] = useState<FormState>(initialForm);
  const deferredKeywords = useDeferredValue(form.keywords);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [isPending, startTransition] = useTransition();

  const parsedKeywords = useMemo(
    () => parseKeywordInput(deferredKeywords),
    [deferredKeywords],
  );

  useEffect(() => {
    if (!isLoading) {
      setPhaseIndex(0);
      return;
    }

    const timer = window.setInterval(() => {
      setPhaseIndex((current) => (current + 1) % loadingPhases.length);
    }, 1200);

    return () => window.clearInterval(timer);
  }, [isLoading]);

  const previewText = useMemo(() => {
    const focusLabel =
      focusOptions.find((item) => item.value === form.focus)?.label ?? "品牌监测";
    const timeframeLabel =
      timeframeOptions.find((item) => item.value === form.timeframe)?.label ?? "24 小时";

    if (!form.topic.trim()) {
      return "输入一个品牌、产品、事件或人物名，我们会自动拼出监测查询。";
    }

    const keywords = parsedKeywords.length > 0 ? `，并补充关键词 ${parsedKeywords.join(" / ")}` : "";

    return `将在 ${timeframeLabel} 范围内，以“${form.topic.trim()}”为核心，按 ${focusLabel} 视角抓取公开信号${keywords}。`;
  }, [form.focus, form.timeframe, form.topic, parsedKeywords]);

  const busy = isLoading || isPending;

  const applyPreset = (index: number) => {
    const preset = expertProfile.quickPrompts[index];

    if (!preset) {
      return;
    }

    setForm({
      topic: preset.topic,
      focus: preset.focus,
      timeframe: preset.timeframe,
      keywords: preset.keywords,
      note: preset.note,
      manualSignals: "",
    });
    setError(null);
  };

  const updateField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.topic.trim()) {
      setError("先输入一个监测主题，比如品牌名、活动名或热点事件。");
      return;
    }

    setError(null);
    setIsLoading(true);

    const userText = buildUserPrompt(form);
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        text: userText,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const report = await createBrowserMonitorReport({
        topic: form.topic,
        keywords: parseKeywordInput(form.keywords),
        focus: form.focus,
        timeframe: form.timeframe,
        note: form.note,
        manualSignals: form.manualSignals,
      });

      const messageText = `${report.executiveSummary}\n\n${report.reportLead}`;

      startTransition(() => {
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: messageText,
            createdAt: new Date().toISOString(),
            report,
          },
        ]);
      });
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : "监测任务执行失败。";

      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.shell}>
      <header className={styles.masthead}>
        <div className={styles.brand}>
          <div className={styles.avatarRing}>
            <Image
              className={styles.avatar}
              src={expertProfile.iconUrl}
              alt={expertProfile.name}
              width={48}
              height={48}
            />
          </div>
          <div className={styles.brandText}>
            <div className={styles.eyebrow}>
              <span>Opinion Agent</span>
              基于公开配置复刻
            </div>
            <h1 className={styles.title}>{expertProfile.name}</h1>
            <p className={styles.subtitle}>{expertProfile.description}</p>
          </div>
        </div>
        <div className={styles.headerAside}>
          <div className={styles.statusPill}>
            <span className={styles.statusDot} />
            本地工作台已就绪
          </div>
          <div className={styles.modelPill}>{expertProfile.model}</div>
        </div>
      </header>

      <div className={styles.grid}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarInner}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className={styles.panelTitle}>监测任务配置</h2>
                <p className={styles.panelMeta}>
                  输入主题、关键词和分析目标后，Agent 会抓取公开信号并输出结构化快报。
                </p>
              </div>
              <form className={styles.form} onSubmit={handleSubmit}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="topic">
                    监测主题
                    <span className={styles.fieldHint}>必填</span>
                  </label>
                  <input
                    id="topic"
                    className={styles.input}
                    value={form.topic}
                    onChange={(event) => updateField("topic", event.target.value)}
                    placeholder="例如：蜜雪冰城、理想汽车、某新品发布会"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="keywords">
                    关键词补充
                    <span className={styles.fieldHint}>逗号分隔</span>
                  </label>
                  <textarea
                    id="keywords"
                    className={styles.textarea}
                    value={form.keywords}
                    onChange={(event) => updateField("keywords", event.target.value)}
                    placeholder="门店, 客诉, 联名, 价格, 热搜"
                  />
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>监测视角</div>
                  <div className={styles.segmented}>
                    {focusOptions.map((option) => (
                      <button
                        key={option.value}
                        className={`${styles.segmentButton} ${form.focus === option.value ? styles.segmentActive : ""}`}
                        type="button"
                        onClick={() => updateField("focus", option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>时间窗</div>
                  <div className={styles.segmented}>
                    {timeframeOptions.map((option) => (
                      <button
                        key={option.value}
                        className={`${styles.segmentButton} ${form.timeframe === option.value ? styles.segmentActive : ""}`}
                        type="button"
                        onClick={() => updateField("timeframe", option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="note">
                    分析要求
                    <span className={styles.fieldHint}>可选</span>
                  </label>
                  <textarea
                    id="note"
                    className={styles.textarea}
                    value={form.note}
                    onChange={(event) => updateField("note", event.target.value)}
                    placeholder="例如：突出负面风险、列出核心媒体观点、给出公关动作建议。"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="manualSignals">
                    手工补充信号
                    <span className={styles.fieldHint}>支持 [来源] 内容</span>
                  </label>
                  <textarea
                    id="manualSignals"
                    className={styles.textarea}
                    value={form.manualSignals}
                    onChange={(event) => updateField("manualSignals", event.target.value)}
                    placeholder="[微博] 评论集中吐槽配送延迟&#10;[小红书] 用户分享新品口味翻车&#10;[客服] 今日咨询量明显上升"
                  />
                </div>

                <div className={styles.previewCard}>
                  <div className={styles.previewLabel}>即将执行</div>
                  <div className={styles.previewQuery}>{previewText}</div>
                  <div className={styles.previewMeta}>
                    <span className={styles.miniTag}>{form.topic.trim() || "待输入主题"}</span>
                    <span className={styles.miniTag}>
                      {focusOptions.find((item) => item.value === form.focus)?.label}
                    </span>
                    <span className={styles.miniTag}>
                      {timeframeOptions.find((item) => item.value === form.timeframe)?.label}
                    </span>
                  </div>
                </div>

                <div className={styles.submitRow}>
                  <button className={styles.submitButton} type="submit" disabled={busy}>
                    {busy ? "监测中..." : "启动监测任务"}
                  </button>
                </div>

                {error ? <div className={styles.errorText}>{error}</div> : null}
              </form>

              <div className={styles.helperPanel}>
                <div className={styles.helperList}>
                  {expertProfile.capabilities.map((item) => (
                    <div className={styles.helperItem} key={item.title}>
                      <div className={styles.helperTitle}>{item.title}</div>
                      <div className={styles.helperDescription}>{item.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </aside>

        <main className={styles.workspace}>
          <section className={`${styles.panel} ${styles.hero}`}>
            <div className={styles.heroTop}>
              <div className={styles.heroLead}>
                <div className={styles.heroKicker}>Public Signal Desk</div>
                <h2 className={styles.heroTitle}>让热点、风险和情绪变化尽早浮出水面。</h2>
                <p className={styles.heroDescription}>
                  这个版本参考了目标 Minimax expert 的公开配置，保留了“新闻分析员、社媒监测员、报告总控”三段式工作流。它会先抓公开新闻信号，再合并你补充的评论或客服线索，最后输出快报与行动建议。
                </p>
                <div className={styles.chipGrid}>
                  {expertProfile.quickPrompts.map((prompt, index) => (
                    <button
                      key={prompt.title}
                      className={styles.presetChip}
                      type="button"
                      onClick={() => applyPreset(index)}
                    >
                      {prompt.title}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.heroRadar}>
                <div>
                  <div className={styles.previewLabel}>多角色编排</div>
                  <div className={styles.radarGrid}>
                    <div className={styles.radarSweep} />
                    <div className={styles.radarDot} />
                    <div className={styles.radarDot} />
                    <div className={styles.radarDot} />
                  </div>
                </div>
                <div className={styles.radarMeta}>
                  <div className={styles.radarMetaItem}>
                    <div className={styles.radarMetaLabel}>公开信号</div>
                    <div className={styles.radarMetaValue}>Google News + Bing RSS</div>
                  </div>
                  <div className={styles.radarMetaItem}>
                    <div className={styles.radarMetaLabel}>社媒补充</div>
                    <div className={styles.radarMetaValue}>支持手工粘贴微博/小红书/客服记录</div>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.stack}>
              <div className={styles.stackGrid}>
                {expertProfile.subAgents.map((agent) => (
                  <div className={styles.stackCard} key={agent.name}>
                    <div className={styles.stackName}>{agent.name}</div>
                    <div className={styles.stackDesc}>{agent.description}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.conversation}>
              {messages.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyCard}>
                    <div className={styles.emptyTitle}>建议这样开始</div>
                    <div className={styles.emptyText}>
                      先输入一个主题，再补充 3 到 6 个关键词。若你已经有微博评论、客服记录、论坛帖子等原始线索，直接粘到左侧“手工补充信号”里，结果会更接近真实舆情。
                    </div>
                    <div className={styles.signalChecklist}>
                      <div className={styles.signalRow}>
                        <div className={styles.signalIndex}>1</div>
                        <div>用“品牌 / 产品 / 人物 / 事件”作为主主题。</div>
                      </div>
                      <div className={styles.signalRow}>
                        <div className={styles.signalIndex}>2</div>
                        <div>用“投诉 / 热搜 / 联名 / 事故 / 维权”等词缩小搜索范围。</div>
                      </div>
                      <div className={styles.signalRow}>
                        <div className={styles.signalIndex}>3</div>
                        <div>把关键社媒评论按 `[来源] 内容` 的形式贴进来，便于一起判断。</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={styles.messages}>
                  {messages.map((message) => {
                    if (message.role === "user") {
                      return (
                      <article className={styles.userBubble} key={message.id}>
                        <div className={styles.messageMeta}>
                          任务请求 · {formatCollectedAt(message.createdAt)}
                        </div>
                        <div className={styles.messageText}>{message.text}</div>
                      </article>
                      );
                    }

                    const report = message.report;
                    const maxTimeline = report
                      ? Math.max(...report.timeline.map((item) => item.count), 1)
                      : 1;

                    return (
                      <article className={styles.assistantCard} key={message.id}>
                        <div className={styles.assistantHeader}>
                          <div className={styles.assistantTitle}>
                            <div className={styles.avatarRing}>
                              <Image
                                className={styles.avatar}
                                src={expertProfile.iconUrl}
                                alt={expertProfile.name}
                                width={48}
                                height={48}
                              />
                            </div>
                            <div>
                              <h3>{expertProfile.name} 输出报告</h3>
                              <p>{formatCollectedAt(message.createdAt)} 生成</p>
                            </div>
                          </div>
                          {report ? (
                            <span className={`${styles.badge} ${riskBadgeClass(report.riskLevel)}`}>
                              {report.riskLevel} 风险
                            </span>
                          ) : null}
                        </div>

                        <div className={styles.summary}>{message.text}</div>

                        {report ? (
                          <>
                            <div className={styles.metrics}>
                              <div className={styles.metricCard}>
                                <div className={styles.metricLabel}>总信号量</div>
                                <div className={styles.metricValue}>{report.totalSignals}</div>
                                <div className={styles.metricSub}>公开新闻 + 手工补充</div>
                              </div>
                              <div className={styles.metricCard}>
                                <div className={styles.metricLabel}>风险评分</div>
                                <div className={styles.metricValue}>{report.riskScore}</div>
                                <div className={styles.metricSub}>越高越需要快速响应</div>
                              </div>
                              <div className={styles.metricCard}>
                                <div className={styles.metricLabel}>情绪判断</div>
                                <div className={styles.metricValue}>{report.sentiment.label}</div>
                                <div className={styles.metricSub}>
                                  负向 {report.sentiment.negative}%
                                </div>
                              </div>
                              <div className={styles.metricCard}>
                                <div className={styles.metricLabel}>高频主题</div>
                                <div className={styles.metricValue}>
                                  {report.topThemes[0] ?? "暂无"}
                                </div>
                                <div className={styles.metricSub}>
                                  {report.topThemes.slice(1, 3).join(" / ") || "等待更多信号"}
                                </div>
                              </div>
                            </div>

                            <div className={styles.analysisGrid}>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>报告总控结论</div>
                                <div className={styles.analysisText}>{report.reportLead}</div>
                              </div>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>情绪分布</div>
                                <div className={styles.meter}>
                                  <div className={styles.meterRow}>
                                    <span>正向</span>
                                    <div className={styles.meterTrack}>
                                      <div
                                        className={`${styles.meterFill} ${styles.fillPositive}`}
                                        style={{ width: `${report.sentiment.positive}%` }}
                                      />
                                    </div>
                                    <span>{report.sentiment.positive}%</span>
                                  </div>
                                  <div className={styles.meterRow}>
                                    <span>中性</span>
                                    <div className={styles.meterTrack}>
                                      <div
                                        className={`${styles.meterFill} ${styles.fillNeutral}`}
                                        style={{ width: `${report.sentiment.neutral}%` }}
                                      />
                                    </div>
                                    <span>{report.sentiment.neutral}%</span>
                                  </div>
                                  <div className={styles.meterRow}>
                                    <span>负向</span>
                                    <div className={styles.meterTrack}>
                                      <div
                                        className={`${styles.meterFill} ${styles.fillNegative}`}
                                        style={{ width: `${report.sentiment.negative}%` }}
                                      />
                                    </div>
                                    <span>{report.sentiment.negative}%</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className={styles.analysisGrid}>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>新闻分析员</div>
                                <div className={styles.analysisText}>{report.newsDesk}</div>
                              </div>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>社媒监测员</div>
                                <div className={styles.analysisText}>{report.socialDesk}</div>
                              </div>
                            </div>

                            <div className={styles.analysisGrid}>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>高频主题簇</div>
                                <div className={styles.themeRow}>
                                  {report.topThemes.map((theme) => (
                                    <span className={styles.themeChip} key={theme}>
                                      {theme}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>时间走势</div>
                                <div className={styles.timeline}>
                                  {report.timeline.map((point) => (
                                    <div className={styles.timelineRow} key={point.label}>
                                      <span>{point.label}</span>
                                      <div className={styles.timelineTrack}>
                                        <div
                                          className={styles.timelineFill}
                                          style={{ width: `${(point.count / maxTimeline) * 100}%` }}
                                        />
                                      </div>
                                      <span>{point.count}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className={styles.analysisGrid}>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>来源分布</div>
                                <div className={styles.sourcesGrid}>
                                  {report.sources.map((source) => (
                                    <div className={styles.sourceRow} key={source.name}>
                                      <span className={styles.sourceName}>{source.name}</span>
                                      <span className={styles.sourceCount}>{source.count} 条</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>建议动作</div>
                                <div className={styles.actionsList}>
                                  {report.actions.map((action, index) => (
                                    <div className={styles.actionItem} key={action}>
                                      <span className={styles.actionBullet}>{index + 1}</span>
                                      <span>{action}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className={styles.analysisCard}>
                              <div className={styles.analysisLabel}>最新高相关信号</div>
                              <div className={styles.highlightsList}>
                                {report.highlights.map((item) => (
                                  <div className={styles.highlightItem} key={item.id}>
                                    <div className={styles.highlightHeader}>
                                      <div className={styles.highlightTitle}>{item.title}</div>
                                      <span
                                        className={`${styles.badge} ${riskBadgeClass(
                                          item.riskFlag ? "高" : item.sentiment === "negative" ? "中" : "低",
                                        )}`}
                                      >
                                        {item.source}
                                      </span>
                                    </div>
                                    <div className={styles.highlightMeta}>
                                      {formatCollectedAt(item.publishedAt)} ·{" "}
                                      {item.channel === "manual" ? "手工补充" : "公开新闻"}
                                    </div>
                                    <div className={styles.highlightSummary}>{item.summary}</div>
                                    {item.link ? (
                                      <a
                                        className={styles.highlightLink}
                                        href={item.link}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        打开原始链接
                                      </a>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className={styles.footerNote}>{report.coverageNote}</div>
                          </>
                        ) : null}
                      </article>
                    );
                  })}

                  {isLoading ? (
                    <div className={styles.loadingCard}>
                      <div className={styles.loadingBody}>
                        <div className={styles.loadingPulse} />
                        <div>
                          <div className={styles.assistantTitle}>
                            <div>
                              <h3>监测任务执行中</h3>
                              <p>正在抓公开信号并编排多角色分析。</p>
                            </div>
                          </div>
                          <div className={styles.loadingText}>
                            这个过程会依次抓 RSS、去重、做情绪与风险分析，然后生成结构化快报。你可以继续完善左侧配置，下一轮任务会直接沿用。
                          </div>
                        </div>
                        <div className={styles.phasePills}>
                          {loadingPhases.map((phase, index) => (
                            <span
                              key={phase}
                              className={`${styles.phasePill} ${phaseIndex === index ? styles.phaseActive : ""}`}
                            >
                              {phase}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
