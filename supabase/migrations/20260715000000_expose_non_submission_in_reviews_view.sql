-- Expose a per-student/assignment `is_non_submission` flag on the gradebook
-- recalculation view so the gradebook can distinguish "earned a 0" from
-- "never submitted, graded anyway" (issue #644).
--
-- Background: when an instructor "grades anyway" a student who never submitted,
-- create_manual_submission_internal inserts a content-less stub submission
-- (submitted_via='manual', repository IS NULL, sha IS NULL). Once graded, that
-- stub carries a real score and is indistinguishable from an earned score in the
-- gradebook. This flag surfaces the stub so the recalculation pipeline can mark
-- the gradebook cell as missing.
--
-- The `repo_mode <> 'no_submission'` gate is essential: no_submission-mode
-- assignments give EVERY student a manual stub by design, so those must NOT be
-- treated as non-submissions. Every other mode (including upload assignments,
-- repo_mode='none') treats a manual stub as a genuine non-submitter. This mirrors
-- the existing convention in the bulk-assign UI.
--
-- Recreated verbatim from 20260322120000_per_student_grading_totals.sql (the
-- current definer) with the single added `is_non_submission` passthrough.

DROP VIEW IF EXISTS public.submissions_with_reviews_by_round_for_assignment;

CREATE OR REPLACE VIEW public.submissions_with_reviews_by_round_for_assignment
WITH (security_invoker = 'true')
AS
WITH
  all_submissions AS (
    SELECT ur.private_profile_id, a.class_id, s.assignment_id, a.slug AS assignment_slug, s.id AS submission_id,
      (s.submitted_via = 'manual' AND s.repository IS NULL AND s.sha IS NULL AND a.repo_mode <> 'no_submission') AS is_non_submission
    FROM public.submissions s
    JOIN public.assignments a ON a.id = s.assignment_id
    JOIN public.user_roles ur ON (ur.class_id = a.class_id AND ur.role = 'student'::public.app_role AND ur.disabled = false AND ur.private_profile_id = s.profile_id)
    WHERE s.is_active = true AND s.assignment_group_id IS NULL
    UNION ALL
    SELECT agm.profile_id AS private_profile_id, a.class_id, s.assignment_id, a.slug AS assignment_slug, s.id AS submission_id,
      (s.submitted_via = 'manual' AND s.repository IS NULL AND s.sha IS NULL AND a.repo_mode <> 'no_submission') AS is_non_submission
    FROM public.submissions s
    JOIN public.assignments a ON a.id = s.assignment_id
    JOIN public.assignment_groups_members agm ON (agm.assignment_id = s.assignment_id AND agm.assignment_group_id = s.assignment_group_id)
    JOIN public.user_roles ur ON (ur.class_id = a.class_id AND ur.role = 'student'::public.app_role AND ur.disabled = false AND ur.private_profile_id = agm.profile_id)
    WHERE s.is_active = true AND s.assignment_group_id IS NOT NULL
  )
SELECT
  bs.class_id, bs.assignment_id, bs.assignment_slug,
  bs.private_profile_id AS student_private_profile_id,
  coalesce(agg.scores_by_round_private, '{}'::jsonb) AS scores_by_round_private,
  coalesce(agg.scores_by_round_public, '{}'::jsonb) AS scores_by_round_public,
  agg.individual_scores,
  agg.per_student_grading_totals,
  bs.is_non_submission
FROM all_submissions bs
JOIN LATERAL (
  SELECT
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE true) AS scores_by_round_private,
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE x.released) AS scores_by_round_public,
    (SELECT sr2.individual_scores FROM public.submission_reviews sr2
     WHERE sr2.submission_id = bs.submission_id
     AND sr2.id = (SELECT s.grading_review_id FROM public.submissions s WHERE s.id = bs.submission_id)
    ) AS individual_scores,
    (SELECT sr3.per_student_grading_totals FROM public.submission_reviews sr3
     WHERE sr3.submission_id = bs.submission_id
     AND sr3.id = (SELECT s2.grading_review_id FROM public.submissions s2 WHERE s2.id = bs.submission_id)
    ) AS per_student_grading_totals
  FROM (
    SELECT DISTINCT ON (r.review_round) r.review_round, sr.total_score, sr.released, sr.completed_at, sr.id
    FROM public.submission_reviews sr
    JOIN public.rubrics r ON r.id = sr.rubric_id
    WHERE sr.submission_id = bs.submission_id
    ORDER BY r.review_round, sr.completed_at DESC NULLS LAST, sr.id DESC
  ) x
) agg ON true;

COMMENT ON VIEW public.submissions_with_reviews_by_round_for_assignment IS
  'One row per student per assignment with per-review_round score maps, individual_scores, per_student_grading_totals for split rubrics, and is_non_submission (true when the active submission is a content-less instructor-created stub on an assignment that expected a real submission).';
