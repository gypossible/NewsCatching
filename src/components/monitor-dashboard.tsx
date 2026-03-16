"use client";

import type * as XLSXType from "xlsx";

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
  ATTACHMENT_PREVIEW_LIMIT,
  IMPORT_TEMPLATE_COLUMNS,
  buildMonitorRequestFromImportedRow,
  buildWorkbookMetaFromFile,
  createAttachmentBatch,
  createInitialTaskConfig,
  createWritebackSummary,
  describeColumn,
  downloadWorkbook,
  getWorkbookSheetMeta,
  normalizeTaskConfig,
  prepareWorkbookWriteback,
  updateTaskConfigForSheet,
  writeMonitorResultToWorkbook,
  type AttachmentBatch,
  type AttachmentTaskConfig,
  type AttachmentWorkbookMeta,
  type ImportedTopicRow,
  type SpreadsheetModule,
  type WorkbookWritebackSummary,
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

type BatchProgress = {
  total: number;
  completed: number;
  currentTopic: string;
};

type WorkbookRuntime = {
  XLSX: SpreadsheetModule;
  workbook: XLSXType.WorkBook;
};

type AttachmentTaskDialogProps = {
  isOpen: boolean;
  meta: AttachmentWorkbookMeta | null;
  draft: AttachmentTaskConfig | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onUpdate: <K extends keyof AttachmentTaskConfig>(
    field: K,
    value: AttachmentTaskConfig[K],
  ) => void;
  onSheetChange: (sheetName: string) => void;
  onToggleHeader: (enabled: boolean) => void;
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
  "读取附件或公开 RSS",
  "按指定列扫描主题与线索",
  "生成舆情报告并写回结果列",
  "准备导出附件下载",
];

const initialForm: FormState = {
  topic: "",
  keywords: "",
  focus: "brand",
  timeframe: "24h",
  note: "",
  manualSignals: "",
};

const MAX_BATCH_CHAT_REPORTS = 12;

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

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function buildAttachmentPrompt(
  batch: AttachmentBatch,
  config: AttachmentTaskConfig,
  meta: AttachmentWorkbookMeta,
) {
  const lines = [
    `附件批量监测：${meta.fileName}`,
    `工作表：${batch.sheetName}`,
    `读取主题列：${batch.topicColumnLabel}`,
    `行范围：${config.dataStartRow} - ${config.dataEndRow}`,
    `待处理主题：${batch.rows.length}`,
    `结果写回起始列：${batch.resultStartColumn}`,
  ];

  if (config.taskPrompt.trim()) {
    lines.push(`任务要求：${config.taskPrompt.trim()}`);
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

function AttachmentTaskDialog({
  isOpen,
  meta,
  draft,
  busy,
  onClose,
  onConfirm,
  onUpdate,
  onSheetChange,
  onToggleHeader,
}: AttachmentTaskDialogProps) {
  const sheetMeta = useMemo(
    () => (meta && draft ? getWorkbookSheetMeta(meta, draft.sheetName) : null),
    [meta, draft],
  );

  if (!isOpen || !meta || !draft || !sheetMeta) {
    return null;
  }

  const optionalColumnOptions = [
    <option key="empty" value="">
      不读取
    </option>,
    ...sheetMeta.columns.map((column) => (
      <option key={column.letter} value={column.letter}>
        {column.label}
      </option>
    )),
  ];

  return (
    <div className={styles.modalOverlay} role="presentation">
      <div className={styles.modalCard} role="dialog" aria-modal="true">
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.previewLabel}>附件任务设置</div>
            <h3 className={styles.modalTitle}>配置读取列、任务要求和写回位置</h3>
            <p className={styles.modalDescription}>
              这里会决定读哪个工作表、哪一列作为监测主题，以及结果写回到附件的哪一列。
            </p>
          </div>
          <button
            className={styles.modalClose}
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </button>
        </div>

        <div className={styles.modalGrid}>
          <div className={styles.modalPanel}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="sheetName">
                工作表
              </label>
              <select
                id="sheetName"
                className={styles.select}
                value={draft.sheetName}
                onChange={(event) => onSheetChange(event.target.value)}
                disabled={busy}
              >
                {meta.sheets.map((sheet) => (
                  <option key={sheet.name} value={sheet.name}>
                    {sheet.name} · {sheet.rowCount} 行 / {sheet.colCount} 列
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.field}>
              <div className={styles.fieldLabel}>表头设置</div>
              <div className={styles.segmented}>
                <button
                  className={`${styles.segmentButton} ${draft.headerEnabled ? styles.segmentActive : ""}`}
                  type="button"
                  onClick={() => onToggleHeader(true)}
                  disabled={busy}
                >
                  首行为表头
                </button>
                <button
                  className={`${styles.segmentButton} ${!draft.headerEnabled ? styles.segmentActive : ""}`}
                  type="button"
                  onClick={() => onToggleHeader(false)}
                  disabled={busy}
                >
                  无表头
                </button>
              </div>
            </div>

            {draft.headerEnabled ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="headerRowNumber">
                  表头所在行
                </label>
                <input
                  id="headerRowNumber"
                  className={styles.input}
                  type="number"
                  min={sheetMeta.startRow}
                  max={sheetMeta.endRow}
                  value={draft.headerRowNumber || sheetMeta.startRow}
                  onChange={(event) =>
                    onUpdate("headerRowNumber", Number(event.target.value) || sheetMeta.startRow)
                  }
                />
              </div>
            ) : (
              <div className={styles.inlineNotice}>
                无表头模式下，导出时会直接写入结果值，不会自动生成结果列名。
              </div>
            )}

            <div className={styles.fieldPair}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dataStartRow">
                  起始数据行
                </label>
                <input
                  id="dataStartRow"
                  className={styles.input}
                  type="number"
                  min={sheetMeta.startRow}
                  max={sheetMeta.endRow}
                  value={draft.dataStartRow}
                  onChange={(event) =>
                    onUpdate("dataStartRow", Number(event.target.value) || sheetMeta.startRow)
                  }
                />
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dataEndRow">
                  结束数据行
                </label>
                <input
                  id="dataEndRow"
                  className={styles.input}
                  type="number"
                  min={sheetMeta.startRow}
                  max={sheetMeta.endRow}
                  value={draft.dataEndRow}
                  onChange={(event) =>
                    onUpdate("dataEndRow", Number(event.target.value) || sheetMeta.endRow)
                  }
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="topicColumn">
                主题列
                <span className={styles.fieldHint}>必选</span>
              </label>
              <select
                id="topicColumn"
                className={styles.select}
                value={draft.topicColumn}
                onChange={(event) => onUpdate("topicColumn", event.target.value)}
                disabled={busy}
              >
                {sheetMeta.columns.map((column) => (
                  <option key={column.letter} value={column.letter}>
                    {column.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.fieldPair}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="keywordsColumn">
                  关键词列
                </label>
                <select
                  id="keywordsColumn"
                  className={styles.select}
                  value={draft.keywordsColumn}
                  onChange={(event) => onUpdate("keywordsColumn", event.target.value)}
                  disabled={busy}
                >
                  {optionalColumnOptions}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="manualSignalsColumn">
                  补充线索列
                </label>
                <select
                  id="manualSignalsColumn"
                  className={styles.select}
                  value={draft.manualSignalsColumn}
                  onChange={(event) => onUpdate("manualSignalsColumn", event.target.value)}
                  disabled={busy}
                >
                  {optionalColumnOptions}
                </select>
              </div>
            </div>

            <div className={styles.fieldPair}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="focusColumn">
                  视角列
                </label>
                <select
                  id="focusColumn"
                  className={styles.select}
                  value={draft.focusColumn}
                  onChange={(event) => onUpdate("focusColumn", event.target.value)}
                  disabled={busy}
                >
                  {optionalColumnOptions}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="timeframeColumn">
                  时间窗列
                </label>
                <select
                  id="timeframeColumn"
                  className={styles.select}
                  value={draft.timeframeColumn}
                  onChange={(event) => onUpdate("timeframeColumn", event.target.value)}
                  disabled={busy}
                >
                  {optionalColumnOptions}
                </select>
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="noteColumn">
                行内任务要求列
              </label>
              <select
                id="noteColumn"
                className={styles.select}
                value={draft.noteColumn}
                onChange={(event) => onUpdate("noteColumn", event.target.value)}
                disabled={busy}
              >
                {optionalColumnOptions}
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="taskPrompt">
                任务要求描述
                <span className={styles.fieldHint}>会参与报告生成与写回</span>
              </label>
              <textarea
                id="taskPrompt"
                className={styles.textarea}
                value={draft.taskPrompt}
                onChange={(event) => onUpdate("taskPrompt", event.target.value)}
                placeholder="例如：重点关注负面投诉和维权风险，并在摘要里给出应对建议。"
              />
            </div>

            <div className={styles.field}>
              <div className={styles.fieldLabel}>结果写回方式</div>
              <div className={styles.segmented}>
                <button
                  className={`${styles.segmentButton} ${draft.outputMode === "append" ? styles.segmentActive : ""}`}
                  type="button"
                  onClick={() => onUpdate("outputMode", "append")}
                  disabled={busy}
                >
                  追加到表尾
                </button>
                <button
                  className={`${styles.segmentButton} ${draft.outputMode === "specified" ? styles.segmentActive : ""}`}
                  type="button"
                  onClick={() => onUpdate("outputMode", "specified")}
                  disabled={busy}
                >
                  指定起始列
                </button>
              </div>
            </div>

            {draft.outputMode === "specified" ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="outputStartColumn">
                  结果起始列
                </label>
                <select
                  id="outputStartColumn"
                  className={styles.select}
                  value={draft.outputStartColumn}
                  onChange={(event) => onUpdate("outputStartColumn", event.target.value)}
                  disabled={busy}
                >
                  {sheetMeta.columns.map((column) => (
                    <option key={column.letter} value={column.letter}>
                      {column.label}
                    </option>
                  ))}
                  <option value={sheetMeta.nextEmptyColumn}>
                    {sheetMeta.nextEmptyColumn} · 追加到表尾
                  </option>
                </select>
              </div>
            ) : (
              <div className={styles.inlineNotice}>
                当前会从 {sheetMeta.nextEmptyColumn} 列开始写入“风险等级、情绪判断、摘要、建议动作”等结果列。
              </div>
            )}
          </div>

          <div className={styles.modalPanel}>
            <div className={styles.modalStats}>
              <span className={styles.importStat}>{meta.fileName}</span>
              <span className={styles.importStat}>{formatFileSize(meta.fileSize)}</span>
              <span className={styles.importStat}>
                {sheetMeta.rowCount} 行 / {sheetMeta.colCount} 列
              </span>
              <span className={styles.importStat}>范围 {sheetMeta.rangeRef}</span>
            </div>

            <div className={styles.analysisCard}>
              <div className={styles.analysisLabel}>推荐列名</div>
              <div className={styles.analysisText}>
                {IMPORT_TEMPLATE_COLUMNS.join(" / ")}
              </div>
            </div>

            <div className={styles.analysisCard}>
              <div className={styles.analysisLabel}>样本预览</div>
              <div className={styles.previewSheet}>
                {sheetMeta.previewRows.map((row) => (
                  <div className={styles.previewSheetRow} key={row.rowNumber}>
                    <span className={styles.previewSheetIndex}>{row.rowNumber}</span>
                    <div className={styles.previewSheetCells}>
                      {row.cells.map((cell, index) => (
                        <span className={styles.previewSheetCell} key={`${row.rowNumber}-${index}`}>
                          {cell || "空"}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.analysisCard}>
              <div className={styles.analysisLabel}>当前读取计划</div>
              <div className={styles.sourcesGrid}>
                <div className={styles.sourceRow}>
                  <span className={styles.sourceName}>主题列</span>
                  <span className={styles.sourceCount}>
                    {describeColumn(meta, draft.sheetName, draft.topicColumn)}
                  </span>
                </div>
                <div className={styles.sourceRow}>
                  <span className={styles.sourceName}>关键词列</span>
                  <span className={styles.sourceCount}>
                    {describeColumn(meta, draft.sheetName, draft.keywordsColumn)}
                  </span>
                </div>
                <div className={styles.sourceRow}>
                  <span className={styles.sourceName}>结果写回</span>
                  <span className={styles.sourceCount}>
                    {draft.outputMode === "append"
                      ? `${sheetMeta.nextEmptyColumn} 列起`
                      : `${draft.outputStartColumn} 列起`}
                  </span>
                </div>
                <div className={styles.sourceRow}>
                  <span className={styles.sourceName}>任务要求</span>
                  <span className={styles.sourceCount}>
                    {draft.taskPrompt.trim() || "沿用默认分析逻辑"}
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.modalActions}>
              <button
                className={styles.ghostButton}
                type="button"
                onClick={onClose}
                disabled={busy}
              >
                取消
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={onConfirm}
                disabled={busy}
              >
                保存任务设置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MonitorDashboard() {
  const [form, setForm] = useState<FormState>(initialForm);
  const deferredKeywords = useDeferredValue(form.keywords);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [attachmentMeta, setAttachmentMeta] = useState<AttachmentWorkbookMeta | null>(null);
  const [attachmentConfig, setAttachmentConfig] = useState<AttachmentTaskConfig | null>(null);
  const [attachmentDraft, setAttachmentDraft] = useState<AttachmentTaskConfig | null>(null);
  const [attachmentBatch, setAttachmentBatch] = useState<AttachmentBatch | null>(null);
  const [writebackSummary, setWritebackSummary] =
    useState<WorkbookWritebackSummary | null>(null);
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workbookRuntimeRef = useRef<WorkbookRuntime | null>(null);

  const parsedKeywords = useMemo(
    () => parseKeywordInput(deferredKeywords),
    [deferredKeywords],
  );

  const activeAttachmentSheet = useMemo(
    () =>
      attachmentMeta && attachmentConfig
        ? getWorkbookSheetMeta(attachmentMeta, attachmentConfig.sheetName)
        : null,
    [attachmentMeta, attachmentConfig],
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
    if (attachmentBatch && attachmentConfig) {
      return `附件 ${attachmentBatch.fileName} 已准备就绪，将读取 ${attachmentBatch.sheetName} 工作表里 ${attachmentBatch.topicColumnLabel} 的数据，在第 ${attachmentConfig.dataStartRow} 到 ${attachmentConfig.dataEndRow} 行内执行监测，并从 ${attachmentBatch.resultStartColumn} 列开始写回结果。`;
    }

    if (attachmentMeta && !attachmentBatch) {
      return `附件 ${attachmentMeta.fileName} 已读取，请先完成“任务设置”对话框，指定主题列、任务要求和写回位置。`;
    }

    if (!form.topic.trim()) {
      return "输入一个品牌、产品、事件或人物名，我们会自动拼出监测查询。";
    }

    const keywords =
      parsedKeywords.length > 0 ? `，并补充关键词 ${parsedKeywords.join(" / ")}` : "";

    return `将在 ${getTimeframeLabel(form.timeframe)} 范围内，以“${form.topic.trim()}”为核心，按 ${getFocusLabel(form.focus)} 视角抓取公开信号${keywords}。`;
  }, [attachmentBatch, attachmentConfig, attachmentMeta, form.focus, form.timeframe, form.topic, parsedKeywords]);

  const busy = isLoading || isPending;
  const activeBatchStep = batchProgress
    ? Math.min(batchProgress.completed + 1, batchProgress.total)
    : null;
  const loadingTitle = batchProgress
    ? `批量监测进行中 ${activeBatchStep}/${batchProgress.total}`
    : "监测任务执行中";
  const loadingDescription = batchProgress
    ? `正在处理“${batchProgress.currentTopic}”。结果会直接写回附件表格中的对应结果列，完成后可下载导出。`
    : "这个过程会依次读取 RSS、筛选信号、生成摘要，再把结果写回到附件里。";

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

  const updateAttachmentDraftField = <K extends keyof AttachmentTaskConfig>(
    field: K,
    value: AttachmentTaskConfig[K],
  ) => {
    setAttachmentDraft((current) => (current ? { ...current, [field]: value } : current));
  };

  const handleAttachmentSheetChange = (sheetName: string) => {
    setAttachmentDraft((current) =>
      current && attachmentMeta
        ? updateTaskConfigForSheet(attachmentMeta, current, sheetName)
        : current,
    );
  };

  const handleHeaderToggle = (enabled: boolean) => {
    setAttachmentDraft((current) => {
      if (!current || !attachmentMeta) {
        return current;
      }

      const sheet = getWorkbookSheetMeta(attachmentMeta, current.sheetName);
      if (!sheet) {
        return current;
      }

      return {
        ...current,
        headerEnabled: enabled,
        headerRowNumber: enabled ? current.headerRowNumber || sheet.startRow : 0,
        dataStartRow: enabled
          ? Math.max(current.dataStartRow, (current.headerRowNumber || sheet.startRow) + 1)
          : Math.max(current.dataStartRow, sheet.startRow),
      };
    });
  };

  const clearAttachmentState = () => {
    setAttachmentMeta(null);
    setAttachmentConfig(null);
    setAttachmentDraft(null);
    setAttachmentBatch(null);
    setWritebackSummary(null);
    setIsTaskDialogOpen(false);
    workbookRuntimeRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const clearImportedBatch = () => {
    clearAttachmentState();
    setStatusNote(null);
    setError(null);
  };

  const loadFirstImportedRow = () => {
    const firstRow = attachmentBatch?.previewRows[0];

    if (!firstRow) {
      return;
    }

    setForm((current) => ({
      topic: firstRow.topic,
      keywords: firstRow.keywordsText || current.keywords,
      focus: firstRow.focus ?? current.focus,
      timeframe: firstRow.timeframe ?? current.timeframe,
      note:
        [attachmentConfig?.taskPrompt, firstRow.note]
          .map((value) => value?.trim() ?? "")
          .filter(Boolean)
          .join("；") || current.note,
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
    setWritebackSummary(null);

    try {
      const XLSX = await import("xlsx");
      const fileBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(fileBuffer, {
        type: "array",
      });
      const meta = buildWorkbookMetaFromFile(XLSX, workbook, file);

      if (!meta.sheets.length) {
        throw new Error("附件里没有可读取的工作表。");
      }

      const initialConfig = createInitialTaskConfig(meta, form.note);
      workbookRuntimeRef.current = {
        XLSX,
        workbook,
      };
      setAttachmentMeta(meta);
      setAttachmentDraft(initialConfig);
      setAttachmentConfig(null);
      setAttachmentBatch(null);
      setIsTaskDialogOpen(true);
      setStatusNote(
        `已读取 ${file.name}，共 ${meta.sheetCount} 个工作表。请在任务设置里指定主题列和结果写回位置。`,
      );
    } catch (attachmentError) {
      clearAttachmentState();
      const message =
        attachmentError instanceof Error
          ? attachmentError.message
          : "附件读取失败，请重新上传 Excel 或 CSV 文件。";
      setError(message);
    }
  };

  const handleSaveAttachmentTask = () => {
    if (!attachmentMeta || !attachmentDraft || !workbookRuntimeRef.current) {
      return;
    }

    try {
      const normalizedConfig = normalizeTaskConfig(attachmentMeta, attachmentDraft);
      const batch = createAttachmentBatch(
        workbookRuntimeRef.current.XLSX,
        workbookRuntimeRef.current.workbook,
        attachmentMeta,
        normalizedConfig,
      );

      setAttachmentConfig(normalizedConfig);
      setAttachmentDraft(normalizedConfig);
      setAttachmentBatch(batch);
      setWritebackSummary(null);
      setIsTaskDialogOpen(false);
      setStatusNote(
        `附件任务已配置完成，共识别 ${batch.rows.length} 个主题，将从 ${batch.resultStartColumn} 列开始写回结果。`,
      );
    } catch (configError) {
      const message =
        configError instanceof Error ? configError.message : "附件任务配置失败。";
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
    if (!attachmentMeta || !attachmentConfig || !attachmentBatch || !workbookRuntimeRef.current) {
      setError("先上传附件并完成任务设置。");
      return;
    }

    setError(null);
    setStatusNote(null);
    setIsLoading(true);
    appendUserMessage(buildAttachmentPrompt(attachmentBatch, attachmentConfig, attachmentMeta));

    const defaults = {
      keywords: form.keywords,
      focus: form.focus,
      timeframe: form.timeframe,
      note: form.note,
      manualSignals: form.manualSignals,
    };

    let successCount = 0;
    let failedCount = 0;
    let hiddenSuccessCount = 0;

    try {
      prepareWorkbookWriteback(
        workbookRuntimeRef.current.XLSX,
        workbookRuntimeRef.current.workbook,
        attachmentBatch,
      );

      for (const [index, row] of attachmentBatch.rows.entries()) {
        setBatchProgress({
          total: attachmentBatch.rows.length,
          completed: index,
          currentTopic: row.topic,
        });

        try {
          const report = await createBrowserMonitorReport(
            buildMonitorRequestFromImportedRow(row, defaults, attachmentConfig.taskPrompt),
          );

          writeMonitorResultToWorkbook(
            workbookRuntimeRef.current.XLSX,
            workbookRuntimeRef.current.workbook,
            attachmentBatch,
            row.rowNumber,
            report,
          );

          successCount += 1;

          if (index < MAX_BATCH_CHAT_REPORTS) {
            appendAssistantMessage(
              `${report.executiveSummary}\n\n${report.reportLead}`,
              report,
            );
          } else {
            hiddenSuccessCount += 1;
          }
        } catch (batchError) {
          failedCount += 1;
          const message =
            batchError instanceof Error ? batchError.message : "监测失败";

          writeMonitorResultToWorkbook(
            workbookRuntimeRef.current.XLSX,
            workbookRuntimeRef.current.workbook,
            attachmentBatch,
            row.rowNumber,
            null,
            message,
          );

          appendAssistantMessage(`“${row.topic}” 批量监测失败：${message}`);
        }

        if ((index + 1) % 3 === 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          });
        }
      }

      if (hiddenSuccessCount > 0) {
        appendAssistantMessage(
          `另有 ${hiddenSuccessCount} 个主题已完成监测并写回附件。为避免页面一次性渲染过多报告卡片，这部分结果没有逐条展开，但已经包含在导出文件里。`,
        );
      }

      const summary = createWritebackSummary(
        attachmentMeta.fileName,
        attachmentBatch,
        successCount,
        failedCount,
      );

      setWritebackSummary(summary);
      setStatusNote(
        `批量任务已完成，成功 ${successCount} 个主题，失败 ${failedCount} 个主题。结果已写回内存中的附件，点击“导出写回附件”即可下载。`,
      );
    } finally {
      setBatchProgress(null);
      setIsLoading(false);
    }
  };

  const handleDownloadWorkbook = () => {
    if (!attachmentMeta || !workbookRuntimeRef.current) {
      return;
    }

    const outputFileName = downloadWorkbook(
      workbookRuntimeRef.current.XLSX,
      workbookRuntimeRef.current.workbook,
      attachmentMeta.fileName,
    );
    setStatusNote(`已导出 ${outputFileName}。`);
  };

  return (
    <>
      <AttachmentTaskDialog
        isOpen={isTaskDialogOpen}
        meta={attachmentMeta}
        draft={attachmentDraft}
        busy={busy}
        onClose={() => setIsTaskDialogOpen(false)}
        onConfirm={handleSaveAttachmentTask}
        onUpdate={updateAttachmentDraftField}
        onSheetChange={handleAttachmentSheetChange}
        onToggleHeader={handleHeaderToggle}
      />

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
                          <span className={styles.fieldHint}>Excel / CSV / 写回导出</span>
                        </div>
                        <p className={styles.importDescription}>
                          上传后会弹出任务设置对话框。你可以指定读取某一列作为主题，设置任务要求描述，把监测结果写回指定列，并导出下载更新后的附件。
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

                        {attachmentMeta ? (
                          <button
                            className={styles.ghostButton}
                            type="button"
                            onClick={() => setIsTaskDialogOpen(true)}
                            disabled={busy}
                          >
                            任务设置
                          </button>
                        ) : null}

                        {writebackSummary ? (
                          <button
                            className={styles.secondaryButton}
                            type="button"
                            onClick={handleDownloadWorkbook}
                            disabled={busy}
                          >
                            导出写回附件
                          </button>
                        ) : null}

                        {attachmentMeta ? (
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
                      推荐列名：{IMPORT_TEMPLATE_COLUMNS.join(" / ")}。大文件会按你指定的列和行范围读取，避免一次性把整张表渲染到页面里。
                    </div>

                    {attachmentMeta ? (
                      <div className={styles.importSummary}>
                        <div className={styles.importStats}>
                          <span className={styles.importStat}>{attachmentMeta.fileName}</span>
                          <span className={styles.importStat}>
                            {attachmentMeta.sheetCount} 个工作表
                          </span>
                          <span className={styles.importStat}>
                            {formatFileSize(attachmentMeta.fileSize)}
                          </span>
                          {activeAttachmentSheet ? (
                            <span className={styles.importStat}>
                              {activeAttachmentSheet.rowCount} 行 / {activeAttachmentSheet.colCount} 列
                            </span>
                          ) : null}
                        </div>

                        {attachmentBatch && attachmentConfig ? (
                          <>
                            <div className={styles.importRows}>
                              {attachmentBatch.previewRows.map((row: ImportedTopicRow) => (
                                <div className={styles.importRow} key={row.id}>
                                  <div className={styles.importRowHeader}>
                                    <span className={styles.importRowIndex}>
                                      第 {row.rowNumber} 行
                                    </span>
                                    <div className={styles.importRowTitle}>{row.topic}</div>
                                  </div>
                                  <div className={styles.importRowMeta}>
                                    <span className={styles.importMetaTag}>
                                      {describeColumn(
                                        attachmentMeta,
                                        attachmentConfig.sheetName,
                                        attachmentConfig.topicColumn,
                                      )}
                                    </span>
                                    <span className={styles.importMetaTag}>
                                      {formatKeywordsPreview(row.keywordsText, form.keywords)}
                                    </span>
                                    <span className={styles.importMetaTag}>
                                      输出从 {attachmentBatch.resultStartColumn} 列开始
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {attachmentBatch.rows.length > ATTACHMENT_PREVIEW_LIMIT ? (
                              <div className={styles.importFinePrint}>
                                还有 {attachmentBatch.rows.length - ATTACHMENT_PREVIEW_LIMIT} 个主题会在批量执行时继续处理，界面只展示样本行。
                              </div>
                            ) : null}

                            <div className={styles.sourcesGrid}>
                              <div className={styles.sourceRow}>
                                <span className={styles.sourceName}>工作表</span>
                                <span className={styles.sourceCount}>{attachmentBatch.sheetName}</span>
                              </div>
                              <div className={styles.sourceRow}>
                                <span className={styles.sourceName}>读取主题列</span>
                                <span className={styles.sourceCount}>
                                  {attachmentBatch.topicColumnLabel}
                                </span>
                              </div>
                              <div className={styles.sourceRow}>
                                <span className={styles.sourceName}>扫描行范围</span>
                                <span className={styles.sourceCount}>
                                  {attachmentConfig.dataStartRow} - {attachmentConfig.dataEndRow}
                                </span>
                              </div>
                              <div className={styles.sourceRow}>
                                <span className={styles.sourceName}>结果写回列</span>
                                <span className={styles.sourceCount}>
                                  {attachmentBatch.resultStartColumn} 起
                                </span>
                              </div>
                              <div className={styles.sourceRow}>
                                <span className={styles.sourceName}>任务要求</span>
                                <span className={styles.sourceCount}>
                                  {attachmentBatch.taskPrompt || "沿用默认分析逻辑"}
                                </span>
                              </div>
                            </div>

                            {attachmentBatch.warnings.length > 0 ? (
                              <div className={styles.importWarnings}>
                                {attachmentBatch.warnings.map((warning) => (
                                  <div className={styles.importWarning} key={warning}>
                                    {warning}
                                  </div>
                                ))}
                              </div>
                            ) : null}

                            {writebackSummary ? (
                              <div className={styles.analysisCard}>
                                <div className={styles.analysisLabel}>写回结果</div>
                                <div className={styles.analysisText}>
                                  已写回 {writebackSummary.writtenRows} 行，失败 {writebackSummary.failedRows} 行。
                                  结果文件名为 {writebackSummary.outputFileName}。
                                </div>
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
                                  : `批量监测并写回 ${attachmentBatch.rows.length} 行`}
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className={styles.inlineNotice}>
                            附件已读取，下一步请点“任务设置”，指定要读取的列与写回位置。
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div className={styles.previewCard}>
                    <div className={styles.previewLabel}>即将执行</div>
                    <div className={styles.previewQuery}>{previewText}</div>
                    <div className={styles.previewMeta}>
                      <span className={styles.miniTag}>
                        {attachmentBatch?.rows.length
                          ? `${attachmentBatch.rows.length} 个附件主题`
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
                    这个版本参考了目标 Minimax expert 的公开配置，保留了“新闻分析员、社媒监测员、报告总控”三段式工作流。它会先抓公开新闻信号，再合并你补充的评论、客服线索或 Excel 批量主题，最后输出快报、写回附件并支持导出下载。
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
                      <div className={styles.radarMetaLabel}>附件能力</div>
                      <div className={styles.radarMetaValue}>
                        可指定读取列、写回结果并导出下载
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
                        你可以单条输入主题，也可以直接上传 Excel 做批量舆情监测。上传后先在对话框里指定“读取哪一列”“任务要求怎么写”“结果写回到哪一列”，再启动批量任务。
                      </div>
                      <div className={styles.signalChecklist}>
                        <div className={styles.signalRow}>
                          <div className={styles.signalIndex}>1</div>
                          <div>上传 `.xlsx / .xls / .csv` 后，会先读取工作表结构和列信息。</div>
                        </div>
                        <div className={styles.signalRow}>
                          <div className={styles.signalIndex}>2</div>
                          <div>在任务设置里选择主题列、行范围和写回起始列，可处理上万单元格的大表。</div>
                        </div>
                        <div className={styles.signalRow}>
                          <div className={styles.signalIndex}>3</div>
                          <div>批量跑完后，直接导出带结果列的新附件，不用手工复制回表格。</div>
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
                                  {report
                                    ? `${report.topic} 舆情报告`
                                    : `${expertProfile.name} 输出报告`}
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
                                            item.riskFlag
                                              ? "高"
                                              : item.sentiment === "negative"
                                                ? "中"
                                                : "低",
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
    </>
  );
}
