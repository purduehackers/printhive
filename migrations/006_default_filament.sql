ALTER TABLE materials ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1));
ALTER TABLE material_colors ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1));
UPDATE materials SET is_default = 1 WHERE id = (SELECT id FROM materials ORDER BY id ASC LIMIT 1);
UPDATE material_colors SET is_default = 1 WHERE id IN (SELECT MIN(id) FROM material_colors GROUP BY material_id);
CREATE UNIQUE INDEX materials_single_default ON materials(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX material_colors_single_default ON material_colors(material_id, is_default) WHERE is_default = 1;
