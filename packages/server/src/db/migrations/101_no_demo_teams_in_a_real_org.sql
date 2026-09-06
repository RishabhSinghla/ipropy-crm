-- The demo groups are gone from real orgs.
--
-- Four groups ("Inside Sales", "Field Sales — West", "Post-Sales & Collections",
-- "Marketing") were seeded into every install, including this one's production
-- database, where they mean nothing. They surfaced in the owner picker on a
-- lead as "Teams — Field Sales — West" (the reported bug) and nothing on this
-- org ever assigned anybody to them.
--
-- The engine (ipy_group / ipy_group_member) is deliberately kept: assignment
-- rules, sharing grants and telephony routing can still target a group, and an
-- admin can create a real one if the org ever wants that. Only the demo rows go.
--
-- Two assignment rules pointed at them. "Channel partner leads to CP manager"
-- and the high-value rule never matched a group this org uses, so those rules
-- are removed rather than left dangling at a group that no longer exists —
-- create-only seeding means the seed will not put them back, and the
-- round-robin default ("Everything else") is unaffected.

DELETE FROM ipy_assignment_rule
 WHERE target_group_id IN (SELECT id FROM ipy_group WHERE name IN
        ('Inside Sales', 'Field Sales — West', 'Post-Sales & Collections', 'Marketing'));

DELETE FROM ipy_group_member
 WHERE group_id IN (SELECT id FROM ipy_group WHERE name IN
        ('Inside Sales', 'Field Sales — West', 'Post-Sales & Collections', 'Marketing'));

DELETE FROM ipy_group
 WHERE name IN ('Inside Sales', 'Field Sales — West', 'Post-Sales & Collections', 'Marketing');
