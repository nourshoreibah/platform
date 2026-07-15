import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import type { SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

type AssignmentWithRubric = Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

/**
 * Regression coverage for issue #644: distinguish "earned a 0" from "never
 * submitted, graded anyway" in the instructor gradebook.
 *
 * When an instructor "grades anyway" a student who never submitted,
 * create_manual_submission inserts a content-less stub submission
 * (submitted_via='manual', repository/sha NULL). Once graded, the stub carries a
 * real score. The recalculation pipeline now marks the corresponding
 * gradebook_column_students row as is_missing=true so the gradebook can render
 * it distinctly from an earned score. The signal is gated on
 * repo_mode <> 'no_submission' (where manual stubs are the design-normal state
 * and must NOT be treated as missing).
 */
test.describe("Gradebook: graded non-submitters read as missing (#644)", () => {
  test.describe.configure({ mode: "serial" });

  const runPrefix = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let course: Course;
  let instructor: TestingUser;
  let nonSubmitter: TestingUser;
  let realSubmitter: TestingUser;
  let instructorClient: SupabaseClient<Database>;

  // A normal assignment (repo_mode defaults to 'template_only_staff' — a
  // submission is expected) and a no_submission assignment (manual stubs are
  // normal there and must NOT be flagged missing).
  let normalAssignment: AssignmentWithRubric;
  let noSubmissionAssignment: AssignmentWithRubric;

  /** Direct RPC caller so we can pass explicit null args like edgeFunctions.ts does. */
  async function createManualStub(client: SupabaseClient<Database>, assignment_id: number, profile_id: string) {
    const { data, error } = await (client.rpc as CallableFunction)("create_manual_submission", {
      p_assignment_id: assignment_id,
      p_profile_id: profile_id,
      p_assignment_group_id: null
    });
    if (error) throw new Error(`create_manual_submission failed: ${(error as { message: string }).message}`);
    return data as number;
  }

  /** Kick the async recalculation worker in case the pg_net/edge chain stalls. */
  async function kickRecalculation(classId: number) {
    await supabase
      .from("gradebook_row_recalc_state")
      .update({ is_recalculating: false })
      .eq("class_id", classId)
      .eq("is_recalculating", true);
    const edgeSecret = process.env.EDGE_FUNCTION_SECRET || process.env.EDGE_FUNCTION_SECRET_OVERRIDE;
    if (edgeSecret) {
      await supabase.functions
        .invoke("gradebook-column-recalculate", { headers: { "x-edge-function-secret": edgeSecret } })
        .catch(() => {});
    }
    await supabase.rpc("invoke_gradebook_recalculation_background_task").catch(() => {});
  }

  /** Resolve the auto-created gradebook column for an assignment (dependencies.assignments contains its id). */
  async function gradebookColumnForAssignment(assignmentId: number): Promise<number> {
    const { data, error } = await supabase
      .from("gradebook_columns")
      .select("id, dependencies")
      .eq("class_id", course.id)
      .contains("dependencies", { assignments: [assignmentId] });
    if (error) throw new Error(`Failed to resolve gradebook column: ${error.message}`);
    if (!data || data.length === 0) throw new Error(`No gradebook column for assignment ${assignmentId}`);
    return data[0].id;
  }

  /** Poll a gradebook_column_students row until it matches, kicking recalculation if it lags. */
  async function pollGcs(
    columnId: number,
    studentId: string,
    predicate: (row: { score: number | null; is_missing: boolean | null }) => boolean
  ): Promise<{ score: number | null; is_missing: boolean | null }> {
    let last: { score: number | null; is_missing: boolean | null } = { score: null, is_missing: null };
    let kicks = 0;
    await expect(async () => {
      const { data, error } = await supabase
        .from("gradebook_column_students")
        .select("score, is_missing")
        .eq("class_id", course.id)
        .eq("student_id", studentId)
        .eq("gradebook_column_id", columnId)
        .eq("is_private", true)
        .single();
      if (error) throw new Error(`Failed to read gradebook_column_students: ${error.message}`);
      last = data as { score: number | null; is_missing: boolean | null };
      if (!predicate(last) && kicks < 5) {
        kicks++;
        await kickRecalculation(course.id);
      }
      expect(predicate(last)).toBe(true);
    }).toPass({ timeout: 120_000 });
    return last;
  }

  /** Grade a submission's grading review by attaching points to a grading-review rubric check. */
  async function gradeSubmission(submissionId: number, assignment: AssignmentWithRubric, points: number) {
    const { data: sub, error: subErr } = await supabase
      .from("submissions")
      .select("grading_review_id, class_id")
      .eq("id", submissionId)
      .single();
    if (subErr || !sub?.grading_review_id) throw new Error(`No grading review for submission ${submissionId}`);

    const gradingCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2");
    if (!gradingCheck) throw new Error("Expected 'Grading Review Check 2' on the assignment rubric");

    const { error: commentErr } = await supabase.from("submission_comments").insert({
      submission_id: submissionId,
      submission_review_id: sub.grading_review_id,
      rubric_check_id: gradingCheck.id,
      class_id: sub.class_id,
      author: instructor.private_profile_id,
      comment: "Graded via #644 regression test",
      points,
      released: true,
      eventually_visible: true,
      regrade_request_id: null
    });
    if (commentErr) throw new Error(`Failed to insert grading comment: ${commentErr.message}`);
    await supabase.from("submission_reviews").update({ released: true }).eq("id", sub.grading_review_id);
  }

  test.beforeAll(async () => {
    course = await createClass({ name: `Non-submitter Missing ${runPrefix}` });

    [instructor, nonSubmitter, realSubmitter] = await createUsersInClass([
      {
        name: "NSM Instructor",
        public_profile_name: "NSM Pseudonym Instructor",
        email: `nsm-instructor-${SAFE_ID}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "NSM Non Submitter",
        public_profile_name: "NSM Pseudonym Non Submitter",
        email: `nsm-nonsub-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "NSM Real Submitter",
        public_profile_name: "NSM Pseudonym Real Submitter",
        email: `nsm-realsub-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    instructorClient = await createAuthenticatedClient(instructor);

    // Normal assignment (submission expected). insertAssignment builds a rubric
    // and the assignment-insert trigger auto-creates its gradebook column.
    normalAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toUTCString(),
      release_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: `NSM Normal ${runPrefix}`
    });

    noSubmissionAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toUTCString(),
      release_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: `NSM NoSubmission ${runPrefix}`,
      repo_mode: "no_submission"
    });
  });

  test("graded non-submitter stub on a normal assignment is marked missing", async () => {
    const columnId = await gradebookColumnForAssignment(normalAssignment.id);
    const stubId = await createManualStub(instructorClient, normalAssignment.id, nonSubmitter.private_profile_id);

    // Sanity: it really is a content-less manual stub.
    const { data: stub } = await supabase
      .from("submissions")
      .select("submitted_via, repository, sha")
      .eq("id", stubId)
      .single();
    expect(stub?.submitted_via).toBe("manual");
    expect(stub?.repository).toBeNull();
    expect(stub?.sha).toBeNull();

    await gradeSubmission(stubId, normalAssignment, 5);

    const row = await pollGcs(columnId, nonSubmitter.private_profile_id, (r) => r.is_missing === true);
    expect(row.is_missing).toBe(true);
  });

  test("real submission scoring low is NOT marked missing (earned score stays a score)", async () => {
    const columnId = await gradebookColumnForAssignment(normalAssignment.id);
    const submission = await insertPreBakedSubmission({
      student_profile_id: realSubmitter.private_profile_id,
      assignment_id: normalAssignment.id,
      class_id: course.id
    });
    await gradeSubmission(submission.submission_id, normalAssignment, 1);

    const row = await pollGcs(columnId, realSubmitter.private_profile_id, (r) => r.score !== null);
    expect(row.is_missing).toBe(false);
  });

  test("graded stub on a no_submission assignment is NOT marked missing (design-normal)", async () => {
    const columnId = await gradebookColumnForAssignment(noSubmissionAssignment.id);
    const stubId = await createManualStub(instructorClient, noSubmissionAssignment.id, nonSubmitter.private_profile_id);
    await gradeSubmission(stubId, noSubmissionAssignment, 5);

    const row = await pollGcs(columnId, nonSubmitter.private_profile_id, (r) => r.score !== null);
    expect(row.is_missing).toBe(false);
  });
});
