import type * as XLSXType from "xlsx";

import {
  parseKeywordInput,
  type FocusArea,
  type MonitorReport,
  type MonitorRequest,
  type Timeframe,
} from "@/lib/monitor";

export type SpreadsheetModule = typeof XLSXType;

export interface WorkbookColumnOption {
  index: number;
  letter: string;
  header: string;
  label: string;
  sampleValues: string[];
}

export interface WorkbookSheetMeta {
  name: string;
  rowCount: number;
  colCount: number;
  startRow: number;
  endRow: number;
  rangeRef: string;
  headerDetected: boolean;
  nextEmptyColumn: string;
  columns: WorkbookColumnOption[];
  previewRows: Array<{ rowNumber: number; cells: string[] }>;
  suggestedColumns: {
    topic: string;
    keywords: string;
    focus: string;
    timeframe: string;
    note: string;
    manualSignals: string;
  };
}

export interface AttachmentWorkbookMeta {
  fileName: string;
  fileSize: number;
  sheetCount: number;
  sheets: WorkbookSheetMeta[];
}

export interface AttachmentTaskConfig {
  sheetName: string;
  headerEnabled: boolean;
  headerRowNumber: number;
  dataStartRow: number;
  dataEndRow: number;
  topicColumn: string;
  keywordsColumn: string;
  focusColumn: string;
  timeframeColumn: string;
  noteColumn: string;
  manualSignalsColumn: string;
  taskPrompt: string;
  outputMode: "append" | "specified";
  outputStartColumn: string;
}

export interface ImportedTopicRow {
  id: string;
  rowNumber: number;
  topic: string;
  keywordsText: string;
  focus?: FocusArea;
  timeframe?: Timeframe;
  note: string;
  manualSignals: string;
}

export interface AttachmentBatch {
  fileName: string;
  sheetName: string;
  rows: ImportedTopicRow[];
  previewRows: ImportedTopicRow[];
  totalRowsScanned: number;
  matchedRows: number;
  skippedRows: number;
  warnings: string[];
  headerEnabled: boolean;
  headerRowNumber: number;
  resultStartColumn: string;
  resultHeaders: string[];
  topicColumnLabel: string;
  taskPrompt: string;
}

export interface ImportDefaults {
  keywords: string;
  focus: FocusArea;
  timeframe: Timeframe;
  note: string;
  manualSignals: string;
}

export interface WorkbookWritebackSummary {
  generatedAt: string;
  writtenRows: number;
  failedRows: number;
  outputFileName: string;
  resultStartColumn: string;
}

export const IMPORT_TEMPLATE_COLUMNS = [
  "主题",
  "关键词",
  "监测视角",
  "时间窗",
  "分析要求",
  "补充信号",
] as const;

export const RESULT_HEADERS = [
  "舆情任务状态",
  "风险等级",
  "风险评分",
  "情绪判断",
  "高频主题",
  "监测摘要",
  "建议动作",
  "写入时间",
] as const;

export const ATTACHMENT_PREVIEW_LIMIT = 5;
export const PREVIEW_COLUMN_LIMIT = 6;
export const PREVIEW_ROW_LIMIT = 4;

const HEADER_ALIASES = {
  topic: ["主题", "监测主题", "topic", "name", "subject", "品牌", "事件"],
  keywords: ["关键词", "keyword", "keywords", "监测词", "扩展词"],
  focus: ["监测视角", "监测模式", "focus", "mode", "视角", "模式"],
  timeframe: ["时间窗", "timeframe", "window", "周期", "时效"],
  note: ["分析要求", "note", "备注", "说明", "要求"],
  manualSignals: [
    "补充信号",
    "手工补充信号",
    "manualsignals",
    "signals",
    "线索",
    "社媒线索",
  ],
} satisfies Record<string, string[]>;

type HeaderField = keyof typeof HEADER_ALIASES;

function normalizeInlineText(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMultilineText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeHeaderKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_()[\]{}:：/\\-]+/g, "")
    .trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readCellValue(
  XLSX: SpreadsheetModule,
  sheet: XLSXType.WorkSheet,
  rowIndex: number,
  columnIndex: number,
) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[address];
  return normalizeInlineText(cell?.w ?? cell?.v ?? "");
}

function setCellValue(
  XLSX: SpreadsheetModule,
  sheet: XLSXType.WorkSheet,
  rowIndex: number,
  columnIndex: number,
  value: string | number,
) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cellValue = typeof value === "number" ? value : String(value);

  sheet[address] =
    typeof cellValue === "number"
      ? { t: "n", v: cellValue }
      : { t: "s", v: cellValue };

  const range = typeof sheet["!ref"] === "string"
    ? XLSX.utils.decode_range(sheet["!ref"])
    : { s: { r: rowIndex, c: columnIndex }, e: { r: rowIndex, c: columnIndex } };

  range.s.r = Math.min(range.s.r, rowIndex);
  range.s.c = Math.min(range.s.c, columnIndex);
  range.e.r = Math.max(range.e.r, rowIndex);
  range.e.c = Math.max(range.e.c, columnIndex);
  sheet["!ref"] = XLSX.utils.encode_range(range);
}

function parseFocus(value: string): FocusArea | undefined {
  const normalized = value.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (
    normalized.includes("危机") ||
    normalized.includes("crisis") ||
    normalized.includes("风险")
  ) {
    return "crisis";
  }

  if (
    normalized.includes("竞品") ||
    normalized.includes("对比") ||
    normalized.includes("competitor")
  ) {
    return "competitor";
  }

  if (
    normalized.includes("传播") ||
    normalized.includes("活动") ||
    normalized.includes("campaign")
  ) {
    return "campaign";
  }

  if (
    normalized.includes("品牌") ||
    normalized.includes("口碑") ||
    normalized.includes("brand")
  ) {
    return "brand";
  }

  return undefined;
}

function parseTimeframe(value: string): Timeframe | undefined {
  const normalized = value.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (
    normalized.includes("24h") ||
    normalized.includes("24小时") ||
    normalized.includes("1d") ||
    normalized === "1天"
  ) {
    return "24h";
  }

  if (
    normalized.includes("7d") ||
    normalized.includes("7天") ||
    normalized.includes("一周")
  ) {
    return "7d";
  }

  if (
    normalized.includes("30d") ||
    normalized.includes("30天") ||
    normalized.includes("一个月") ||
    normalized.includes("1月")
  ) {
    return "30d";
  }

  return undefined;
}

function detectHeaderRow(values: string[]) {
  const indexes: Partial<Record<HeaderField, number>> = {};
  let matches = 0;

  values.forEach((cell, index) => {
    const normalized = normalizeHeaderKey(cell);

    (Object.keys(HEADER_ALIASES) as HeaderField[]).forEach((field) => {
      if (indexes[field] !== undefined) {
        return;
      }

      const matched = HEADER_ALIASES[field].some(
        (alias) => normalizeHeaderKey(alias) === normalized,
      );

      if (matched) {
        indexes[field] = index;
        matches += 1;
      }
    });
  });

  return {
    indexes,
    matched: matches > 0,
  };
}

function getSheetMeta(
  XLSX: SpreadsheetModule,
  sheet: XLSXType.WorkSheet,
  name: string,
) {
  const rangeRef = typeof sheet["!ref"] === "string" ? sheet["!ref"] : "A1:A1";
  const range = XLSX.utils.decode_range(rangeRef);
  const startRow = range.s.r + 1;
  const endRow = range.e.r + 1;
  const rowCount = endRow - startRow + 1;
  const colCount = range.e.c - range.s.c + 1;
  const firstRowValues = Array.from({ length: colCount }, (_, offset) =>
    readCellValue(XLSX, sheet, range.s.r, range.s.c + offset),
  );
  const header = detectHeaderRow(firstRowValues);

  const columns = Array.from({ length: colCount }, (_, offset) => {
    const index = range.s.c + offset;
    const letter = XLSX.utils.encode_col(index);
    const headerText = readCellValue(XLSX, sheet, range.s.r, index);
    const sampleValues: string[] = [];

    for (
      let rowIndex = header.matched ? range.s.r + 1 : range.s.r;
      rowIndex <= range.e.r && sampleValues.length < 3;
      rowIndex += 1
    ) {
      const value = readCellValue(XLSX, sheet, rowIndex, index);
      if (value) {
        sampleValues.push(value);
      }
    }

    return {
      index,
      letter,
      header: headerText,
      label: headerText ? `${letter} · ${headerText}` : `列 ${letter}`,
      sampleValues,
    };
  });

  const previewRows = Array.from(
    {
      length: Math.min(PREVIEW_ROW_LIMIT, rowCount),
    },
    (_, offset) => {
      const rowIndex = range.s.r + offset;
      return {
        rowNumber: rowIndex + 1,
        cells: Array.from(
          {
            length: Math.min(PREVIEW_COLUMN_LIMIT, colCount),
          },
          (_, columnOffset) =>
            readCellValue(XLSX, sheet, rowIndex, range.s.c + columnOffset),
        ),
      };
    },
  );

  const findSuggestedColumn = (field: HeaderField) => {
    const aliasSet = new Set(
      HEADER_ALIASES[field].map((alias) => normalizeHeaderKey(alias)),
    );
    const matchedColumn = columns.find((column) =>
      aliasSet.has(normalizeHeaderKey(column.header)),
    );

    if (matchedColumn) {
      return matchedColumn.letter;
    }

    if (field === "topic") {
      return columns[0]?.letter ?? "A";
    }

    return "";
  };

  return {
    name,
    rowCount,
    colCount,
    startRow,
    endRow,
    rangeRef,
    headerDetected: header.matched,
    nextEmptyColumn: XLSX.utils.encode_col(range.e.c + 1),
    columns,
    previewRows,
    suggestedColumns: {
      topic: findSuggestedColumn("topic"),
      keywords: findSuggestedColumn("keywords"),
      focus: findSuggestedColumn("focus"),
      timeframe: findSuggestedColumn("timeframe"),
      note: findSuggestedColumn("note"),
      manualSignals: findSuggestedColumn("manualSignals"),
    },
  } satisfies WorkbookSheetMeta;
}

function getSheetByName(meta: AttachmentWorkbookMeta, sheetName: string) {
  return meta.sheets.find((sheet) => sheet.name === sheetName) ?? meta.sheets[0] ?? null;
}

function sanitizeColumnRef(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z]/g, "");
}

function decodeColumnRef(
  XLSX: SpreadsheetModule,
  sheetMeta: WorkbookSheetMeta,
  value: string,
) {
  const normalized = sanitizeColumnRef(value);
  if (!normalized) {
    return null;
  }

  const columnIndex = XLSX.utils.decode_col(normalized);
  if (
    Number.isNaN(columnIndex) ||
    columnIndex < sheetMeta.columns[0]?.index ||
    columnIndex > sheetMeta.columns[sheetMeta.columns.length - 1]?.index + RESULT_HEADERS.length
  ) {
    return null;
  }

  return columnIndex;
}

function buildMergedTaskNote(rowNote: string, taskPrompt: string, fallbackNote: string) {
  return [taskPrompt, rowNote, fallbackNote]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("；");
}

export function buildWorkbookMetaFromFile(
  XLSX: SpreadsheetModule,
  workbook: XLSXType.WorkBook,
  file: File,
): AttachmentWorkbookMeta {
  const sheets = workbook.SheetNames.map((name) =>
    getSheetMeta(XLSX, workbook.Sheets[name], name),
  );

  return {
    fileName: file.name,
    fileSize: file.size,
    sheetCount: sheets.length,
    sheets,
  };
}

export function createInitialTaskConfig(
  meta: AttachmentWorkbookMeta,
  taskPromptSeed = "",
): AttachmentTaskConfig {
  const primarySheet = meta.sheets[0];

  if (!primarySheet) {
    return {
      sheetName: "",
      headerEnabled: true,
      headerRowNumber: 1,
      dataStartRow: 2,
      dataEndRow: 2,
      topicColumn: "A",
      keywordsColumn: "",
      focusColumn: "",
      timeframeColumn: "",
      noteColumn: "",
      manualSignalsColumn: "",
      taskPrompt: taskPromptSeed,
      outputMode: "append",
      outputStartColumn: "B",
    };
  }

  const headerRowNumber = primarySheet.headerDetected ? primarySheet.startRow : 0;
  const dataStartRow = primarySheet.headerDetected
    ? Math.min(primarySheet.startRow + 1, primarySheet.endRow)
    : primarySheet.startRow;

  return {
    sheetName: primarySheet.name,
    headerEnabled: primarySheet.headerDetected,
    headerRowNumber,
    dataStartRow,
    dataEndRow: primarySheet.endRow,
    topicColumn: primarySheet.suggestedColumns.topic || primarySheet.columns[0]?.letter || "A",
    keywordsColumn: primarySheet.suggestedColumns.keywords,
    focusColumn: primarySheet.suggestedColumns.focus,
    timeframeColumn: primarySheet.suggestedColumns.timeframe,
    noteColumn: primarySheet.suggestedColumns.note,
    manualSignalsColumn: primarySheet.suggestedColumns.manualSignals,
    taskPrompt: taskPromptSeed,
    outputMode: "append",
    outputStartColumn: primarySheet.nextEmptyColumn,
  };
}

export function updateTaskConfigForSheet(
  meta: AttachmentWorkbookMeta,
  current: AttachmentTaskConfig,
  sheetName: string,
) {
  const sheet = getSheetByName(meta, sheetName);
  if (!sheet) {
    return current;
  }

  const headerRowNumber = sheet.headerDetected ? sheet.startRow : 0;
  const dataStartRow = sheet.headerDetected
    ? Math.min(sheet.startRow + 1, sheet.endRow)
    : sheet.startRow;

  return {
    ...current,
    sheetName: sheet.name,
    headerEnabled: sheet.headerDetected,
    headerRowNumber,
    dataStartRow,
    dataEndRow: sheet.endRow,
    topicColumn: sheet.suggestedColumns.topic || sheet.columns[0]?.letter || "A",
    keywordsColumn: sheet.suggestedColumns.keywords,
    focusColumn: sheet.suggestedColumns.focus,
    timeframeColumn: sheet.suggestedColumns.timeframe,
    noteColumn: sheet.suggestedColumns.note,
    manualSignalsColumn: sheet.suggestedColumns.manualSignals,
    outputStartColumn: sheet.nextEmptyColumn,
  };
}

export function describeColumn(
  meta: AttachmentWorkbookMeta,
  sheetName: string,
  columnLetter: string,
) {
  const sheet = getSheetByName(meta, sheetName);
  if (!sheet) {
    return columnLetter || "未选择";
  }

  const normalized = sanitizeColumnRef(columnLetter);
  const column = sheet.columns.find((item) => item.letter === normalized);
  if (!column) {
    return normalized || "未选择";
  }

  return column.label;
}

export function getWorkbookSheetMeta(
  meta: AttachmentWorkbookMeta,
  sheetName: string,
) {
  return getSheetByName(meta, sheetName);
}

export function normalizeTaskConfig(
  meta: AttachmentWorkbookMeta,
  config: AttachmentTaskConfig,
) {
  const sheet = getSheetByName(meta, config.sheetName);

  if (!sheet) {
    return config;
  }

  const headerRowNumber = config.headerEnabled
    ? clamp(
        config.headerRowNumber || sheet.startRow,
        sheet.startRow,
        sheet.endRow,
      )
    : 0;
  const minimumDataRow = config.headerEnabled ? headerRowNumber + 1 : sheet.startRow;
  const dataStartRow = clamp(
    config.dataStartRow || minimumDataRow,
    Math.min(minimumDataRow, sheet.endRow),
    sheet.endRow,
  );
  const dataEndRow = clamp(
    config.dataEndRow || sheet.endRow,
    dataStartRow,
    sheet.endRow,
  );

  return {
    ...config,
    sheetName: sheet.name,
    headerRowNumber,
    dataStartRow,
    dataEndRow,
    topicColumn:
      sanitizeColumnRef(config.topicColumn) || sheet.suggestedColumns.topic || "A",
    keywordsColumn: sanitizeColumnRef(config.keywordsColumn),
    focusColumn: sanitizeColumnRef(config.focusColumn),
    timeframeColumn: sanitizeColumnRef(config.timeframeColumn),
    noteColumn: sanitizeColumnRef(config.noteColumn),
    manualSignalsColumn: sanitizeColumnRef(config.manualSignalsColumn),
    outputStartColumn:
      config.outputMode === "specified"
        ? sanitizeColumnRef(config.outputStartColumn) || sheet.nextEmptyColumn
        : sheet.nextEmptyColumn,
    taskPrompt: config.taskPrompt.trim(),
  };
}

export function createAttachmentBatch(
  XLSX: SpreadsheetModule,
  workbook: XLSXType.WorkBook,
  meta: AttachmentWorkbookMeta,
  rawConfig: AttachmentTaskConfig,
): AttachmentBatch {
  const config = normalizeTaskConfig(meta, rawConfig);
  const sheetMeta = getSheetByName(meta, config.sheetName);

  if (!sheetMeta) {
    throw new Error("未找到可读取的工作表。");
  }

  const worksheet = workbook.Sheets[sheetMeta.name];
  const topicColumnIndex = decodeColumnRef(XLSX, sheetMeta, config.topicColumn);

  if (topicColumnIndex === null) {
    throw new Error("请先指定一个有效的主题列。");
  }

  const keywordsColumnIndex = decodeColumnRef(XLSX, sheetMeta, config.keywordsColumn);
  const focusColumnIndex = decodeColumnRef(XLSX, sheetMeta, config.focusColumn);
  const timeframeColumnIndex = decodeColumnRef(XLSX, sheetMeta, config.timeframeColumn);
  const noteColumnIndex = decodeColumnRef(XLSX, sheetMeta, config.noteColumn);
  const manualSignalsColumnIndex = decodeColumnRef(
    XLSX,
    sheetMeta,
    config.manualSignalsColumn,
  );
  const resultStartColumnIndex =
    config.outputMode === "specified"
      ? XLSX.utils.decode_col(config.outputStartColumn)
      : XLSX.utils.decode_col(sheetMeta.nextEmptyColumn);
  const rows: ImportedTopicRow[] = [];
  const warnings = new Set<string>();
  let skippedRows = 0;

  for (
    let rowIndex = config.dataStartRow - 1;
    rowIndex <= config.dataEndRow - 1;
    rowIndex += 1
  ) {
    const topic = readCellValue(XLSX, worksheet, rowIndex, topicColumnIndex);

    if (!topic) {
      skippedRows += 1;
      continue;
    }

    const rawFocus = focusColumnIndex === null
      ? ""
      : readCellValue(XLSX, worksheet, rowIndex, focusColumnIndex);
    const rawTimeframe = timeframeColumnIndex === null
      ? ""
      : readCellValue(XLSX, worksheet, rowIndex, timeframeColumnIndex);
    const focus = parseFocus(rawFocus);
    const timeframe = parseTimeframe(rawTimeframe);

    if (rawFocus && !focus) {
      warnings.add(`第 ${rowIndex + 1} 行的监测视角未识别，已改用默认配置。`);
    }

    if (rawTimeframe && !timeframe) {
      warnings.add(`第 ${rowIndex + 1} 行的时间窗未识别，已改用默认配置。`);
    }

    rows.push({
      id: `row-${rowIndex + 1}-${topic}`,
      rowNumber: rowIndex + 1,
      topic,
      keywordsText:
        keywordsColumnIndex === null
          ? ""
          : normalizeMultilineText(
              readCellValue(XLSX, worksheet, rowIndex, keywordsColumnIndex),
            ),
      focus,
      timeframe,
      note:
        noteColumnIndex === null
          ? ""
          : normalizeMultilineText(
              readCellValue(XLSX, worksheet, rowIndex, noteColumnIndex),
            ),
      manualSignals:
        manualSignalsColumnIndex === null
          ? ""
          : normalizeMultilineText(
              readCellValue(XLSX, worksheet, rowIndex, manualSignalsColumnIndex),
            ),
    });
  }

  if (!rows.length) {
    throw new Error("指定列里没有读取到可监测的主题，请检查工作表、行范围和主题列。");
  }

  if ((config.dataEndRow - config.dataStartRow + 1) * sheetMeta.colCount >= 10000) {
    warnings.add("当前附件规模已超过上万单元格，建议按行范围分批执行，浏览器会更稳定。");
  }

  return {
    fileName: meta.fileName,
    sheetName: sheetMeta.name,
    rows,
    previewRows: rows.slice(0, ATTACHMENT_PREVIEW_LIMIT),
    totalRowsScanned: config.dataEndRow - config.dataStartRow + 1,
    matchedRows: rows.length,
    skippedRows,
    warnings: [...warnings],
    headerEnabled: config.headerEnabled,
    headerRowNumber: config.headerRowNumber,
    resultStartColumn: XLSX.utils.encode_col(resultStartColumnIndex),
    resultHeaders: [...RESULT_HEADERS],
    topicColumnLabel: describeColumn(meta, sheetMeta.name, config.topicColumn),
    taskPrompt: config.taskPrompt,
  };
}

export function buildMonitorRequestFromImportedRow(
  row: ImportedTopicRow,
  defaults: ImportDefaults,
  taskPrompt = "",
): MonitorRequest {
  return {
    topic: row.topic,
    keywords: parseKeywordInput(row.keywordsText || defaults.keywords),
    focus: row.focus ?? defaults.focus,
    timeframe: row.timeframe ?? defaults.timeframe,
    note: buildMergedTaskNote(row.note, taskPrompt, defaults.note) || undefined,
    manualSignals: row.manualSignals || defaults.manualSignals,
  };
}

function buildOutputFileName(fileName: string) {
  return fileName.replace(/\.(xlsx|xls|csv)$/i, "") + "-舆情监测结果.xlsx";
}

export function prepareWorkbookWriteback(
  XLSX: SpreadsheetModule,
  workbook: XLSXType.WorkBook,
  batch: AttachmentBatch,
) {
  if (!batch.headerEnabled || batch.headerRowNumber <= 0) {
    return;
  }

  const worksheet = workbook.Sheets[batch.sheetName];
  const startColumnIndex = XLSX.utils.decode_col(batch.resultStartColumn);

  batch.resultHeaders.forEach((header, offset) => {
    setCellValue(
      XLSX,
      worksheet,
      batch.headerRowNumber - 1,
      startColumnIndex + offset,
      header,
    );
  });
}

export function writeMonitorResultToWorkbook(
  XLSX: SpreadsheetModule,
  workbook: XLSXType.WorkBook,
  batch: AttachmentBatch,
  rowNumber: number,
  report: MonitorReport | null,
  errorText = "",
) {
  const worksheet = workbook.Sheets[batch.sheetName];
  const startColumnIndex = XLSX.utils.decode_col(batch.resultStartColumn);
  const summary = report
    ? `${report.executiveSummary} ${report.reportLead}`.trim()
    : errorText;
  const values = report
    ? [
        "已完成",
        report.riskLevel,
        report.riskScore,
        report.sentiment.label,
        report.topThemes.slice(0, 4).join(" / "),
        summary,
        report.actions.slice(0, 3).join("；"),
        new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Shanghai",
        }).format(new Date()),
      ]
    : [
        "失败",
        "",
        "",
        "",
        "",
        summary,
        "",
        new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Shanghai",
        }).format(new Date()),
      ];

  values.forEach((value, offset) => {
    setCellValue(XLSX, worksheet, rowNumber - 1, startColumnIndex + offset, value);
  });
}

export function downloadWorkbook(
  XLSX: SpreadsheetModule,
  workbook: XLSXType.WorkBook,
  originalFileName: string,
) {
  const outputFileName = buildOutputFileName(originalFileName);
  XLSX.writeFile(workbook, outputFileName, {
    compression: true,
  });
  return outputFileName;
}

export function createWritebackSummary(
  originalFileName: string,
  batch: AttachmentBatch,
  writtenRows: number,
  failedRows: number,
): WorkbookWritebackSummary {
  return {
    generatedAt: new Date().toISOString(),
    writtenRows,
    failedRows,
    outputFileName: buildOutputFileName(originalFileName),
    resultStartColumn: batch.resultStartColumn,
  };
}
