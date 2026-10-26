-- NULL preserves the existing behavior: use the selected slicer profile's default.
ALTER TABLE jobs ADD COLUMN support_angle INTEGER
  CHECK(support_angle IS NULL OR (typeof(support_angle) = 'integer' AND support_angle BETWEEN 0 AND 90));
