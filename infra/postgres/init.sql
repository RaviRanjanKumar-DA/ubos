-- Runs once when the dev database volume is created.
-- Two runtime roles: ubos_app is subject to row-level security (tenant APIs);
-- ubos_platform bypasses it (Platform Console only). Dev-only passwords.
CREATE ROLE ubos_app LOGIN PASSWORD 'ubos_app_dev';
CREATE ROLE ubos_platform LOGIN PASSWORD 'ubos_platform_dev' BYPASSRLS;
