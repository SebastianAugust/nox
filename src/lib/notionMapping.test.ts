import { describe, expect, it } from "vitest";
import {
  extractNotionId,
  isCurrentCourse,
  looksDone,
  mapAssignment,
  mapCourse,
  resolveMapping,
  schemaOf,
  toLocalDue,
  type NotionRow,
} from "./notionMapping";

const ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const DASHED = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const COURSE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const row = (properties: NotionRow["properties"], id = DASHED): NotionRow => ({ id, archived: false, properties });

const text = (s: string) => [{ plain_text: s }];
const assignment = row({
  Name: { type: "title", title: text("Essay 2") },
  Deadline: { type: "date", date: { start: "2026-11-05" } },
  Created: { type: "date", date: { start: "2026-10-01" } },
  Course: { type: "relation", relation: [{ id: COURSE.replace(/-/g, "") }] },
  Status: { type: "status", status: { name: "In progress" } },
  Submitted: { type: "checkbox", checkbox: false },
});

describe("extractNotionId", () => {
  it("accepts a raw id with or without dashes", () => {
    expect(extractNotionId(ID)).toBe(DASHED);
    expect(extractNotionId(` ${DASHED.toUpperCase()} `)).toBe(DASHED);
  });

  it("takes the database id from a URL and ignores the view id", () => {
    const view = "ffffffffffffffffffffffffffffffff";
    expect(extractNotionId(`https://www.notion.so/bas/Assignments-${ID}?v=${view}&pvs=4`)).toBe(DASHED);
    expect(extractNotionId(`https://www.notion.so/${ID}`)).toBe(DASHED);
    // A hex-looking title word must not shift the match.
    expect(extractNotionId(`https://notion.so/Feed-cafe-${ID}`)).toBe(DASHED);
  });

  it("returns null when there is no id", () => {
    expect(extractNotionId("https://www.notion.so/bas")).toBeNull();
    expect(extractNotionId("")).toBeNull();
  });
});

describe("resolveMapping", () => {
  const schema = schemaOf([assignment]);

  it("finds every field by type and likely name", () => {
    expect(resolveMapping(schema, {})).toEqual({
      ok: true,
      mapping: { title: "Name", due: "Deadline", course: "Course", status: "Status", done: "Submitted" },
    });
  });

  it("uses a pinned name over the guess", () => {
    const r = resolveMapping(schema, { due: "Created" });
    expect(r.ok && r.mapping.due).toBe("Created");
  });

  it("reports a renamed pinned property instead of crashing", () => {
    const r = resolveMapping(schema, { due: "Due date" });
    expect(r).toEqual({
      ok: false,
      problems: [
        {
          field: "due",
          reason: "missing",
          name: "Due date",
          expected: ["date"],
          available: ["Name", "Deadline", "Created", "Course", "Status", "Submitted"],
        },
      ],
    });
  });

  it("reports a pinned property of the wrong type", () => {
    const r = resolveMapping(schema, { due: "Name" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems[0].reason).toBe("wrongType");
  });

  it("fails clearly when no date property exists", () => {
    const r = resolveMapping({ Name: "title", Notes: "rich_text" }, {});
    expect(!r.ok && r.problems.map((p) => [p.field, p.reason])).toEqual([["due", "none"]]);
  });

  it("leaves optional fields empty rather than guessing wildly", () => {
    const r = resolveMapping({ Name: "title", When: "date", Tags: "multi_select", Kind: "select", Other: "select" }, {});
    expect(r).toEqual({
      ok: true,
      mapping: { title: "Name", due: "When", course: null, status: null, done: null },
    });
  });
});

describe("mapAssignment", () => {
  const mapping = { title: "Name", due: "Deadline", course: "Course", status: "Status", done: "Submitted" };

  it("maps title, due, course name through the relation, status and done", () => {
    const courses = new Map([[COURSE, "Ethics"]]);
    expect(mapAssignment(assignment, mapping, courses)).toEqual({
      notion_id: DASHED,
      name: "Essay 2",
      due_date: "2026-11-05",
      course: "Ethics",
      course_notion_id: COURSE,
      notion_status: "In progress",
      done: false,
      archived: false,
    });
  });

  it("reads done from the status when there is no checkbox", () => {
    const done = row({ ...assignment.properties, Status: { type: "status", status: { name: "Done" } } });
    expect(mapAssignment(done, { ...mapping, done: null }, new Map()).done).toBe(true);
  });

  it("copes with empty values", () => {
    const empty = row({
      Name: { type: "title", title: [] },
      Deadline: { type: "date", date: null },
      Course: { type: "relation", relation: [] },
      Status: { type: "status", status: null },
      Submitted: { type: "checkbox", checkbox: false },
    });
    const m = mapAssignment(empty, mapping, new Map());
    expect([m.name, m.due_date, m.course, m.notion_status]).toEqual(["", null, null, null]);
  });

  it("maps a course row by its title", () => {
    expect(mapCourse(row({ Title: { type: "title", title: text("Ethics") } }, COURSE))).toEqual({
      notion_id: COURSE,
      name: "Ethics",
      status: null,
      semester: null,
    });
  });
});

describe("value helpers", () => {
  it("recognises done-ish values in both languages, not their negations", () => {
    expect(["Done", "Completed", "Selesai", "Sudah dikumpulkan"].map(looksDone)).toEqual([true, true, true, true]);
    expect(["Not done", "Belum selesai", "In progress", "Undone", null].map(looksDone)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("keeps a bare date and turns a date-time into local time", () => {
    expect(toLocalDue("2026-11-05")).toBe("2026-11-05");
    const local = new Date("2026-11-05T23:59:00.000+07:00");
    const p = (n: number) => String(n).padStart(2, "0");
    expect(toLocalDue("2026-11-05T23:59:00.000+07:00")).toBe(
      `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())} ${p(local.getHours())}:${p(local.getMinutes())}`,
    );
    expect(toLocalDue("nonsense")).toBeNull();
  });
});

describe("Bas's student essentials template", () => {
  const COURSE_ID = "11111111-2222-3333-4444-555555555555";
  // Assignments: Name, Date, Done, Courses, Grade, Weight, Weighted Mark.
  const essay = row({
    Name: { type: "title", title: text("Reflection paper") },
    Date: { type: "date", date: { start: "2026-11-05T09:00:00.000+07:00" } },
    Done: { type: "checkbox", checkbox: false },
    Courses: { type: "relation", relation: [{ id: COURSE_ID }] },
    Grade: { type: "number", number: null },
    Weight: { type: "number", number: 0.2 },
    "Weighted Mark": { type: "formula", formula: { type: "number", number: 0 } },
  });

  it("maps the template's names by default", () => {
    expect(resolveMapping(schemaOf([essay]), {})).toEqual({
      ok: true,
      mapping: { title: "Name", due: "Date", course: "Courses", status: null, done: "Done" },
    });
  });

  it("prefers the template names over other likely ones", () => {
    const schema = { ...schemaOf([essay]), "Due date": "date", "Finished?": "checkbox" };
    const r = resolveMapping(schema, {});
    expect(r.ok && [r.mapping.due, r.mapping.done]).toEqual(["Date", "Done"]);
  });

  it("joins the Courses relation to a course name by page id, never a raw id", () => {
    const mapping = { title: "Name", due: "Date", course: "Courses", status: null, done: "Done" };
    const known = mapAssignment(essay, mapping, new Map([[COURSE_ID, "Ethics"]]));
    expect([known.course, known.course_notion_id]).toEqual(["Ethics", COURSE_ID]);
    // Linked to a course that was not synced: no name, and no id shown as one.
    const unknown = mapAssignment(essay, mapping, new Map());
    expect([unknown.course, unknown.course_notion_id]).toEqual([null, COURSE_ID]);
  });

  it("maps a course with its status and term", () => {
    const course = row(
      {
        "Course Name": { type: "title", title: text("Ethics") },
        "Semester/Year": { type: "select", select: { name: "2026/1" } },
        Status: { type: "status", status: { name: "In progress" } },
        "Final Mark": { type: "number", number: null },
      },
      COURSE_ID,
    );
    expect(mapCourse(course)).toEqual({ notion_id: COURSE_ID, name: "Ethics", status: "In progress", semester: "2026/1" });
  });

  it("treats only In progress (or no status) as a current course", () => {
    expect(["In progress", "in progress", "In-Progress", null, ""].map(isCurrentCourse)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["Not Started", "Passed", "Failed", "Dropped"].map(isCurrentCourse)).toEqual([false, false, false, false]);
  });
});
