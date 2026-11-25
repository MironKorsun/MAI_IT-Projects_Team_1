ALTER TABLE kim_variants
    ADD COLUMN package_digest text UNIQUE,
    ADD COLUMN package_version text,
    ADD COLUMN instruction text,
    ADD CONSTRAINT kim_variant_number_version UNIQUE (exam_code, number, package_version);
