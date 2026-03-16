import {
  parseKeywordInput,
  type FocusArea,
  type MonitorRequest,
  type Timeframe,
} from "@/lib/monitor";

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

export interface ImportedTopicResult {
  rows: ImportedTopicRow[];
  skippedRows: number;
  truncated: boolean;
  warnings: string[];
  headerDetected: boolean;
}

export interface ImportDefaults {
  keywords: string;
  focus: FocusArea;
  timeframe: Timeframe;
  note: string;
  manualSignals: string;
}

export const IMPORT_TEMPLATE_COLUMNS = [
  "主题",
  "关键词",
  "监测视角",
  "时间窗",
  "分析要求",
  "补充信号",
] as const;

export const MAX_BATCH_TOPICS = 20;

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

function getCell(row: string[], index: number | undefined) {
  if (index === undefined) {
    return "";
  }

  return row[index] ?? "";
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

function detectHeaderRow(row: string[]) {
  const indexes: Partial<Record<HeaderField, number>> = {};
  let matches = 0;

  row.forEach((cell, index) => {
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

export function parseImportedTopicRows(grid: unknown[][]): ImportedTopicResult {
  const normalizedRows = grid
    .map((row) =>
      Array.isArray(row)
        ? row.map((cell) =>
            typeof cell === "string" ? cell.trim() : normalizeInlineText(cell),
          )
        : [],
    )
    .filter((row) => row.some((cell) => normalizeInlineText(cell)));

  if (!normalizedRows.length) {
    return {
      rows: [],
      skippedRows: 0,
      truncated: false,
      warnings: [],
      headerDetected: false,
    };
  }

  const header = detectHeaderRow(normalizedRows[0]);
  const dataRows = header.matched ? normalizedRows.slice(1) : normalizedRows;
  const warnings = new Set<string>();
  const rows: ImportedTopicRow[] = [];
  let skippedRows = 0;
  let truncated = false;

  dataRows.forEach((row, index) => {
    if (rows.length >= MAX_BATCH_TOPICS) {
      truncated = true;
      return;
    }

    const rowNumber = header.matched ? index + 2 : index + 1;
    const topicIndex = header.indexes.topic ?? 0;
    const topic = normalizeInlineText(getCell(row, topicIndex));

    if (!topic) {
      skippedRows += 1;
      return;
    }

    const keywordsText = normalizeMultilineText(
      getCell(row, header.indexes.keywords ?? 1),
    );
    const rawFocus = normalizeInlineText(getCell(row, header.indexes.focus ?? 2));
    const rawTimeframe = normalizeInlineText(
      getCell(row, header.indexes.timeframe ?? 3),
    );
    const focus = parseFocus(rawFocus);
    const timeframe = parseTimeframe(rawTimeframe);

    if (rawFocus && !focus) {
      warnings.add(`第 ${rowNumber} 行的监测视角未识别，已改用左侧默认配置。`);
    }

    if (rawTimeframe && !timeframe) {
      warnings.add(`第 ${rowNumber} 行的时间窗未识别，已改用左侧默认配置。`);
    }

    rows.push({
      id: `import-${rowNumber}-${topic}`,
      rowNumber,
      topic,
      keywordsText,
      focus,
      timeframe,
      note: normalizeMultilineText(getCell(row, header.indexes.note ?? 4)),
      manualSignals: normalizeMultilineText(
        getCell(row, header.indexes.manualSignals ?? 5),
      ),
    });
  });

  return {
    rows,
    skippedRows,
    truncated,
    warnings: [...warnings],
    headerDetected: header.matched,
  };
}

export function buildMonitorRequestFromImportedRow(
  row: ImportedTopicRow,
  defaults: ImportDefaults,
): MonitorRequest {
  return {
    topic: row.topic,
    keywords: parseKeywordInput(row.keywordsText || defaults.keywords),
    focus: row.focus ?? defaults.focus,
    timeframe: row.timeframe ?? defaults.timeframe,
    note: row.note || defaults.note,
    manualSignals: row.manualSignals || defaults.manualSignals,
  };
}
