/**
 * Turning Notion database rows into Nox's assignment and course rows. Pure:
 * no imports, so it is easy to test.
 *
 * Each field (title, due date, course, status, done) can be pinned to a
 * property name in Settings. Left empty, it is found by property type and a
 * likely name, so a renamed column keeps working where it can. A pinned name
 * that no longer exists (or has the wrong type) is reported as a problem
 * instead of crashing the sync; the last good data stays in place.
 */

export type NotionProperty = { type: string; [key: string]: unknown };
export type NotionRow = { id: string; archived: boolean; properties: Record<string, NotionProperty> };

export type Field = "title" | "due" | "course" | "status" | "done";
export type MappingConfig = Partial<Record<Field, string>>;
export type Mapping = { title: string; due: string; course: string | null; status: string | null; done: string | null };

export type MappingProblem = {
  field: Field;
  /** missing: the pinned name is not in the database; wrongType: it is, but
   * with a type Nox cannot read; none: nothing suitable was found. */
  reason: "missing" | "wrongType" | "none";
  name?: string;
  expected: string[];
  available: string[];
};

export type MappingResult = { ok: true; mapping: Mapping } | { ok: false; problems: MappingProblem[] };

const TYPES: Record<Field, string[]> = {
  title: ["title"],
  due: ["date"],
  course: ["relation", "select", "multi_select", "rich_text"],
  status: ["status", "select"],
  done: ["checkbox", "status", "select"],
};

const LIKELY: Record<Field, RegExp> = {
  title: /./,
  due: /due|deadline|tenggat|batas|date|tanggal/i,
  course: /course|matkul|mata\s*kuliah|class|kelas|subject/i,
  status: /status/i,
  done: /done|selesai|complete|finished|submitted|kumpul/i,
};

const REQUIRED: Field[] = ["title", "due"];

/**
 * Bas's "student essentials" assignments database. Tried first when a field
 * is not pinned; if a name is missing or has another type, the type-based
 * guess below still runs. Grade, Weight and Weighted Mark are not read.
 */
export const DEFAULT_NAMES: Partial<Record<Field, string>> = {
  title: "Name",
  due: "Date",
  course: "Courses",
  done: "Done",
};

/** The courses database of the same template. */
export const COURSE_DEFAULTS = { title: "Course Name", status: "Status", semester: "Semester/Year" };

/** Property name → type, from the first row (every row shares the schema). */
export function schemaOf(rows: NotionRow[]): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const [name, prop] of Object.entries(rows[0]?.properties ?? {})) schema[name] = prop.type;
  return schema;
}

function pick(field: Field, schema: Record<string, string>, taken: Set<string>): string | null {
  const fits = Object.keys(schema).filter((n) => TYPES[field].includes(schema[n]) && !taken.has(n));
  const preferred = DEFAULT_NAMES[field];
  if (preferred && fits.includes(preferred)) return preferred;
  if (field === "title") return fits[0] ?? null;
  // Prefer a likely name, in type order (a relation beats a select for course).
  for (const type of TYPES[field]) {
    const named = fits.find((n) => schema[n] === type && LIKELY[field].test(n));
    if (named) return named;
  }
  // Without a telling name, only the first type is safe to guess (a lone date
  // is the due date; a lone select is not necessarily the course).
  const sameType = fits.filter((n) => schema[n] === TYPES[field][0]);
  if (field === "due") return sameType[0] ?? null;
  return sameType.length === 1 ? sameType[0] : null;
}

/** Decide which property feeds each field. */
export function resolveMapping(schema: Record<string, string>, config: MappingConfig): MappingResult {
  const available = Object.keys(schema);
  const problems: MappingProblem[] = [];
  const chosen: Partial<Record<Field, string | null>> = {};
  const taken = new Set<string>();

  // Pinned names first, so auto-detection never steals them.
  const fields: Field[] = ["title", "due", "course", "status", "done"];
  for (const field of fields) {
    const name = config[field]?.trim();
    if (!name) continue;
    if (!(name in schema)) {
      problems.push({ field, reason: "missing", name, expected: TYPES[field], available });
    } else if (!TYPES[field].includes(schema[name])) {
      problems.push({ field, reason: "wrongType", name, expected: TYPES[field], available });
    } else {
      chosen[field] = name;
      taken.add(name);
    }
  }
  for (const field of fields) {
    if (config[field]?.trim()) continue;
    const name = pick(field, schema, taken);
    chosen[field] = name;
    if (name) taken.add(name);
    else if (REQUIRED.includes(field)) problems.push({ field, reason: "none", expected: TYPES[field], available });
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    mapping: {
      title: chosen.title!,
      due: chosen.due!,
      course: chosen.course ?? null,
      status: chosen.status ?? null,
      done: chosen.done ?? null,
    },
  };
}

// ── Reading property values ──

type RichText = { plain_text?: string }[];

const plain = (v: unknown) =>
  Array.isArray(v) ? (v as RichText).map((t) => t.plain_text ?? "").join("").trim() : "";

const optionName = (v: unknown) => (v && typeof v === "object" && "name" in v ? String((v as { name: unknown }).name) : null);

/** Notion ids come dashed in some places and bare in others. */
export function normalizeId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  return hex.length === 32
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : id.toLowerCase();
}

/** A value that reads as finished, in English or Indonesian. */
export function looksDone(text: string | null): boolean {
  if (!text) return false;
  if (/\b(not|belum|un)\b|^not\s|^un/i.test(text)) return false;
  return /\b(done|complete|completed|finished|submitted|selesai|sudah|terkumpul|dikumpulkan)\b/i.test(text);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Notion's date start → Nox's local due string: a bare date stays as is, a
 * date-time becomes local "YYYY-MM-DD HH:MM" (so SQLite's DATE() never
 * shifts it to the UTC day).
 */
export function toLocalDue(start: string | null | undefined): string | null {
  if (!start) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type MappedAssignment = {
  notion_id: string;
  name: string;
  due_date: string | null;
  course: string | null;
  course_notion_id: string | null;
  notion_status: string | null;
  done: boolean;
  archived: boolean;
};

function textOf(prop: NotionProperty | undefined): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(prop[prop.type]) || null;
    case "select":
    case "status":
      return optionName(prop[prop.type]);
    case "multi_select":
      return optionName((prop.multi_select as unknown[] | undefined)?.[0]);
    default:
      return null;
  }
}

/** One assignment row. `courseNames` maps normalized course page id → name. */
export function mapAssignment(row: NotionRow, mapping: Mapping, courseNames: Map<string, string>): MappedAssignment {
  const p = row.properties;
  const date = p[mapping.due]?.date as { start?: string } | null | undefined;

  let course: string | null = null;
  let courseId: string | null = null;
  const courseProp = mapping.course ? p[mapping.course] : undefined;
  if (courseProp?.type === "relation") {
    const first = (courseProp.relation as { id: string }[] | undefined)?.[0]?.id;
    if (first) {
      courseId = normalizeId(first);
      course = courseNames.get(courseId) ?? null;
    }
  } else {
    course = textOf(courseProp);
  }

  const status = mapping.status ? textOf(p[mapping.status]) : null;
  const doneProp = mapping.done ? p[mapping.done] : undefined;
  const done =
    doneProp?.type === "checkbox" ? doneProp.checkbox === true : looksDone(doneProp ? textOf(doneProp) : status);

  return {
    notion_id: normalizeId(row.id),
    name: textOf(p[mapping.title]) ?? "",
    due_date: toLocalDue(date?.start),
    course,
    course_notion_id: courseId,
    notion_status: status,
    done,
    archived: row.archived,
  };
}

export type MappedCourse = {
  notion_id: string;
  name: string;
  /** Notion's status text ("In progress", "Passed", ...), or null. */
  status: string | null;
  semester: string | null;
};

/** The named property if it has one of `types`, else the first of `types[0]`. */
function propByName(row: NotionRow, name: string, types: string[]): NotionProperty | undefined {
  const named = row.properties[name];
  if (named && types.includes(named.type)) return named;
  return Object.values(row.properties).find((p) => p.type === types[0]);
}

/** One course row: id, title, status and term. Null without a title. */
export function mapCourse(row: NotionRow): MappedCourse | null {
  const name = textOf(propByName(row, COURSE_DEFAULTS.title, ["title"]));
  if (!name) return null;
  return {
    notion_id: normalizeId(row.id),
    name,
    status: textOf(propByName(row, COURSE_DEFAULTS.status, ["status", "select"])),
    semester: textOf(row.properties[COURSE_DEFAULTS.semester]),
  };
}

/**
 * A course counts as current while its status is "In progress" (any case,
 * also "Sedang berjalan"). Without a status column there is nothing to go
 * by, so it counts as current.
 */
export function isCurrentCourse(status: string | null | undefined): boolean {
  if (status === null || status === undefined || !status.trim()) return true;
  return /^(in[\s_-]*progress|sedang\s+berjalan|berjalan|ongoing|current)$/i.test(status.trim());
}

/**
 * A database id from whatever was pasted: a raw id (with or without dashes)
 * or a full Notion URL (the id is the 32 hex digits at the end of the path;
 * the `?v=` view id is ignored). Null when there is none.
 */
export function extractNotionId(input: string): string | null {
  const path = input.trim().split(/[?#]/)[0];
  const dashed = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  if (dashed) return normalizeId(dashed[dashed.length - 1]);
  const bare = path.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi);
  return bare ? normalizeId(bare[bare.length - 1]) : null;
}
