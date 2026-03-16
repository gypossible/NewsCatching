"use client";

import Image from "next/image";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { expertProfile } from "@/lib/agent-config";
import {
  buildMonitorRequestFromImportedRow,
  IMPORT_TEMPLATE_COLUMNS,
  MAX_BATCH_TOPICS,
  parseImportedTopicRows,
  type ImportedTopicResult,
  type ImportedTopicRow,
} from "@/lib/batch-import";
import {
  createBrowserMonitorReport,
  parseKeywordInput,
  type FocusArea,
  type MonitorReport,
  type MonitorRequest,
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

type ImportedBatch = ImportedTopicResult & {
  fileName: string;
};

type BatchProgress = {
  total: number;
  completed: number;
  currentTopic: string;
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
  "社媒监测员合并附件/手工线索",
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

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

function getFocusLabel(value: FocusArea) {
  return focusOptions.find((item) => item.value === value)?.label ?? "品牌监测";
}

function getTimeframeLabel(value: Timeframe) {
  return timeframeOptions.find((item) => item.value === value)?.label ?? "24 小时";
}

function buildUserPrompt(form: FormState) {
  const lines = [
    `主题：${form.topic}`,
    `监测模式：${getFocusLabel(form.focus)}`,
    `时间窗：${getTimeframeLabel(form.timeframe)}`,
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

function buildBatchUserPrompt(batch: ImportedBatch, form: FormState) {
  const lines = [
    `附件批量监测：${batch.fileName}`,
    `主题数：${batch.rows.length}`,
    `默认监测模式：${getFocusLabel(form.focus)}`,
    `默认时间窗：${getTimeframeLabel(form.timeframe)}`,
  ];

  if (form.keywords.trim()) {
    lines.push(`默认关键词：${form.keywords}`);
  }

  if (batch.skippedRows > 0) {
    lines.push(`跳过空白主题行：${batch.skippedRows}`);
  }

  return lines.join("\n");
}

function buildMonitorRequestFromForm(form: FormState): MonitorRequest {
  return {
    topic: form.topic,
    keywords: parseKeywordInput(form.keywords),
    focus: form.focus,
    timeframe: form.timeframe,
    note: form.note,
    manualSignals: form.manualSignals,
  };
}

function formatKeywordsPreview(raw: string, fallbackRaw = "") {
  const keywords = parseKeywordInput(raw || fallbackRaw);
  return keywords.length > 0 ? keywords.join(" / ") : "仅监测主题词";
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
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [importedBatch, setImportedBatch] = useState<ImportedBatch | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    if (importedBatch?.rows.length) {
      return `附件 ${importedBatch.fileName} 已就绪，将按行批量监测 ${importedBatch.rows.length} 个主题。未在附件里填写的关键词、视角、时间窗和分析要求，会沿用当前左侧配置。`;
    }

    if (!form.topic.trim()) {
      return "输入一个品牌、产品、事件或人物名，我们会自动拼出监测查询。";
    }

    const keywords =
      parsedKeywords.length > 0 ? `，并补充关键词 ${parsedKeywords.join(" / ")}` : "";

    return `将在 ${getTimeframeLabel(form.timeframe)} 范围内，以“${form.topic.trim()}”为核心，按 ${getFocusLabel(form.focus)} 视角抓取公开信号${keywords}。`;
  }, [form.focus, form.timeframe, form.topic, importedBatch, parsedKeywords]);

  const busy = isLoading || isPending;
  const importedRowsPreview = importedBatch?.rows.slice(0, 4) ?? [];
  const activeBatchStep = batchProgress
    ? Math.min(batchProgress.completed + 1, batchProgress.total)
    : null;

  const loadingTitle = batchProgress
    ? `批量监测进行中 ${activeBatchStep}/${batchProgress.total}`
    : "监测任务执行中";
  const loadingDescription = batchProgress
    ? `正在处理“${batchProgress.currentTopic}”。每个主题都会独立抓取公开 RSS、合并附件配置并生成一张报告卡片。`
    : "这个过程会依次抓 RSS、去重、做情绪与风险分析，然后生成结构化快报。你可以继续完善左侧配置，下一轮任务会直接沿用。";

  const appendUserMessage = (text: string) => {
    setMessages((current) => [
      ...current,
      {
        id: createMessageId("user"),
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const appendAssistantMessage = (text: string, report?: MonitorReport) => {
    startTransition(() => {
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("assistant"),
          role: "assistant",
          text,
          createdAt: new Date().toISOString(),
          report,
        },
      ]);
    });
  };

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
    setStatusNote(null);
  };

  const updateField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const clearImportedBatch = () => {
    setImportedBatch(null);
    setStatusNote(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const loadFirstImportedRow = () => {
    const firstRow = importedBatch?.rows[0];

    if (!firstRow) {
      return;
    }

    setForm((current) => ({
      topic: firstRow.topic,
      keywords: firstRow.keywordsText || current.keywords,
      focus: firstRow.focus ?? current.focus,
      timeframe: firstRow.timeframe ?? current.timeframe,
      note: firstRow.note || current.note,
      manualSignals: firstRow.manualSignals || current.manualSignals,
    }));
    setError(null);
    setStatusNote(`已把附件首条主题“${firstRow.topic}”载入左侧表单。`);
  };

  const handleAttachmentChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setError(null);
    setStatusNote(null);

    try {
      const XLSX = await import("xlsx");
      const fileBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(fileBuffer, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];

      if (!firstSheetName) {
        throw new Error("附件里没有可读取的工作表。");
      }

      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        blankrows: false,
        defval: "",
      }) as unknown[][];
      const parsed = parseImportedTopicRows(rows);

      if (!parsed.rows.length) {
        throw new Error("没有识别到可监测主题，请确认第一列或“主题”列存在内容。");
      }

      setImportedBatch({
        fileName: file.name,
        ...parsed,
      });
      setStatusNote(
        parsed.truncated
          ? `已读取 ${file.name}，为保证浏览器稳定，本轮先导入前 ${parsed.rows.length} 个主题。`
          : `已读取 ${file.name}，识别 ${parsed.rows.length} 个主题。缺失列会沿用左侧默认配置。`,
      );
    } catch (attachmentError) {
      const message =
        attachmentError instanceof Error
          ? attachmentError.message
          : "附件读取失败，请重新上传 Excel 或 CSV 文件。";

      setImportedBatch(null);
      setError(message);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.topic.trim()) {
      setError("先输入一个监测主题，比如品牌名、活动名或热点事件。");
      return;
    }

    setError(null);
    setStatusNote(null);
    setIsLoading(true);
    setBatchProgress(null);
    appendUserMessage(buildUserPrompt(form));

    try {
      const report = await createBrowserMonitorReport(buildMonitorRequestFromForm(form));
      appendAssistantMessage(`${report.executiveSummary}\n\n${report.reportLead}`, report);
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

  const handleBatchRun = async () => {
    if (!importedBatch?.rows.length) {
      setError("先上传一个包含主题列表的 Excel 或 CSV 附件。");
      return;
    }

    setError(null);
    setStatusNote(null);
    setIsLoading(true);
    appendUserMessage(buildBatchUserPrompt(importedBatch, form));

    const defaults = {
      keywords: form.keywords,
      focus: form.focus,
      timeframe: form.timeframe,
      note: form.note,
      manualSignals: form.manualSignals,
    };

    let successCount = 0;
    let failedCount = 0;

    try {
      for (const [index, row] of importedBatch.rows.entries()) {
        setBatchProgress({
          total: importedBatch.rows.length,
          completed: index,
          currentTopic: row.topic,
        });

        try {
          const report = await createBrowserMonitorReport(
            buildMonitorRequestFromImportedRow(row, defaults),
          );

          successCount += 1;
          appendAssistantMessage(
            `${report.executiveSummary}\n\n${report.reportLead}`,
            report,
          );
        } catch (batchError) {
          failedCount += 1;
          const message =
            batchError instanceof Error ? batchError.message : "监测失败";

          appendAssistantMessage(`“${row.topic}” 批量监测失败：${message}`);
        }
      }

      setStatusNote(
        `批量任务已完成，成功 ${successCount} 个主题，失败 ${failedCount} 个主题。`,
      );
    } finally {
      setBatchProgress(null);
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

                <div className={styles.importPanel}>
                  <div className={styles.importTop}>
                    <div>
                      <div className={styles.fieldLabel}>
                        附件批量导入
                        <span className={styles.fieldHint}>Excel / CSV</span>
                      </div>
                      <p className={styles.importDescription}>
                        支持上传 `.xlsx`、`.xls`、`.csv`。每一行就是一个监测主题，未填写的列会沿用左侧默认设置。
                      </p>
                    </div>
                    <div className={styles.buttonCluster}>
                      <label
                        className={`${styles.uploadButton} ${busy ? styles.uploadDisabled : ""}`}
                      >
                        上传附件
                        <input
                          ref={fileInputRef}
                          className={styles.fileInput}
                          type="file"
                          accept=".xlsx,.xls,.csv"
                          onChange={handleAttachmentChange}
                          disabled={busy}
                        />
                      </label>
                      {importedBatch ? (
                        <button
                          className={styles.ghostButton}
                          type="button"
                          onClick={clearImportedBatch}
                          disabled={busy}
                        >
                          清空
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className={styles.importFinePrint}>
                    推荐列名：{IMPORT_TEMPLATE_COLUMNS.join(" / ")}。如果没有表头，会默认按前六列依次读取。
                  </div>

                  {importedBatch ? (
                    <div className={styles.importSummary}>
                      <div className={styles.importStats}>
                        <span className={styles.importStat}>{importedBatch.fileName}</span>
                        <span className={styles.importStat}>
                          {importedBatch.rows.length} 个主题
                        </span>
                        <span className={styles.importStat}>
                          {importedBatch.headerDetected ? "已识别表头" : "按列顺序读取"}
                        </span>
                        {importedBatch.skippedRows > 0 ? (
                          <span className={styles.importStat}>
                            跳过 {importedBatch.skippedRows} 行空白主题
                          </span>
                        ) : null}
                      </div>

                      <div className={styles.importRows}>
                        {importedRowsPreview.map((row: ImportedTopicRow) => (
                          <div className={styles.importRow} key={row.id}>
                            <div className={styles.importRowHeader}>
                              <span className={styles.importRowIndex}>第 {row.rowNumber} 行</span>
                              <div className={styles.importRowTitle}>{row.topic}</div>
                            </div>
                            <div className={styles.importRowMeta}>
                              <span className={styles.importMetaTag}>
                                {getFocusLabel(row.focus ?? form.focus)}
                              </span>
                              <span className={styles.importMetaTag}>
                                {getTimeframeLabel(row.timeframe ?? form.timeframe)}
                              </span>
                              <span className={styles.importMetaTag}>
                                {formatKeywordsPreview(row.keywordsText, form.keywords)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {importedBatch.rows.length > importedRowsPreview.length ? (
                        <div className={styles.importFinePrint}>
                          还有 {importedBatch.rows.length - importedRowsPreview.length} 个主题会在批量执行时一起处理。
                        </div>
                      ) : null}

                      {importedBatch.truncated ? (
                        <div className={styles.importWarning}>
                          为保证浏览器稳定，单次批量任务最多处理 {MAX_BATCH_TOPICS} 个主题；如需更多主题，建议分批上传执行。
                        </div>
                      ) : null}

                      {importedBatch.warnings.length > 0 ? (
                        <div className={styles.importWarnings}>
                          {importedBatch.warnings.map((warning) => (
                            <div className={styles.importWarning} key={warning}>
                              {warning}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className={styles.buttonCluster}>
                        <button
                          className={styles.ghostButton}
                          type="button"
                          onClick={loadFirstImportedRow}
                          disabled={busy}
                        >
                          载入首条到表单
                        </button>
                        <button
                          className={styles.secondaryButton}
                          type="button"
                          onClick={handleBatchRun}
                          disabled={busy}
                        >
                          {busy && batchProgress && activeBatchStep
                            ? `批量处理中 ${activeBatchStep}/${batchProgress.total}`
                            : `批量监测 ${importedBatch.rows.length} 个主题`}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className={styles.previewCard}>
                  <div className={styles.previewLabel}>即将执行</div>
                  <div className={styles.previewQuery}>{previewText}</div>
                  <div className={styles.previewMeta}>
                    <span className={styles.miniTag}>
                      {importedBatch?.rows.length
                        ? `${importedBatch.rows.length} 个批量主题`
                        : form.topic.trim() || "待输入主题"}
                    </span>
                    <span className={styles.miniTag}>{getFocusLabel(form.focus)}</span>
                    <span className={styles.miniTag}>{getTimeframeLabel(form.timeframe)}</span>
                  </div>
                </div>

                <div className={styles.submitRow}>
                  <button className={styles.submitButton} type="submit" disabled={busy}>
                    {batchProgress ? "批量任务执行中" : busy ? "监测中..." : "启动单个监测任务"}
                  </button>
                </div>

                {statusNote ? <div className={styles.statusText}>{statusNote}</div> : null}
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
                  这个版本参考了目标 Minimax expert 的公开配置，保留了“新闻分析员、社媒监测员、报告总控”三段式工作流。它会先抓公开新闻信号，再合并你补充的评论、客服线索或 Excel 批量主题，最后输出快报与行动建议。
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
                    <div className={styles.radarMetaLabel}>补充输入</div>
                    <div className={styles.radarMetaValue}>
                      支持手工粘贴与 Excel 批量导入
                    </div>
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
                      你可以单条输入主题，也可以直接上传 Excel 做批量舆情监测。若已经有微博评论、客服记录、论坛帖子等原始线索，继续贴到左侧“手工补充信号”里，结果会更接近真实舆情。
                    </div>
                    <div className={styles.signalChecklist}>
                      <div className={styles.signalRow}>
                        <div className={styles.signalIndex}>1</div>
                        <div>单条任务用“品牌 / 产品 / 人物 / 事件”作为主主题。</div>
                      </div>
                      <div className={styles.signalRow}>
                        <div className={styles.signalIndex}>2</div>
                        <div>批量任务上传 Excel，每行一个主题，可额外带关键词和时间窗。</div>
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
                              <h3>
                                {report ? `${report.topic} 舆情报告` : `${expertProfile.name} 输出报告`}
                              </h3>
                              <p>
                                {formatCollectedAt(message.createdAt)} 生成
                                {report
                                  ? ` · ${getFocusLabel(report.focus)} / ${getTimeframeLabel(report.timeframe)}`
                                  : ""}
                              </p>
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
                              <h3>{loadingTitle}</h3>
                              <p>正在抓公开信号并编排多角色分析。</p>
                            </div>
                          </div>
                          <div className={styles.loadingText}>{loadingDescription}</div>
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
