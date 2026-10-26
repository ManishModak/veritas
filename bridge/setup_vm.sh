#!/bin/bash
# Loads the Veritas tables into Zetaris on the Zetaris host (run as root, after `docker compose up` and verify.sh).
#   1. a Postgres container `veritas-pg` on the Zetaris compose network, holding facts/quarters/beneish/mdna_*;
#   2. the SQL bridge (zetaris_bridge.py) as a systemd service on 127.0.0.1:8787;
#   3. Zetaris registrations through the bridge: CREATE DATASOURCE veritas_pg + REGISTER DATASOURCE TABLE.
# Expects the CSVs in /root/veritas/data/out and this folder in /root/veritas/bridge.
# Usage: bash /root/veritas/bridge/setup_vm.sh
set -euo pipefail
V=/root/veritas
NET=zetaris_default
ENVF=/root/veritas-pg.env
[ -f $ENVF ] || echo "PGPASS=$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)" > $ENVF
chmod 600 $ENVF; source $ENVF

if ! docker ps --format '{{.Names}}' | grep -qx veritas-pg; then
  docker run -d --name veritas-pg --restart unless-stopped --network $NET \
    -e POSTGRES_DB=veritas -e POSTGRES_USER=veritas -e POSTGRES_PASSWORD="$PGPASS" \
    -v $V/data/out:/data:ro postgres:16-alpine
  until docker exec veritas-pg pg_isready -U veritas -d veritas -q; do sleep 2; done
fi

docker exec -i veritas-pg psql -q -v ON_ERROR_STOP=1 -U veritas -d veritas <<'SQL'
DROP TABLE IF EXISTS facts, quarters, beneish, mdna_index, mdna_paragraphs;
CREATE TABLE facts (cik bigint, company text, role text, fy_end date, concept text, tag text,
                    value double precision, accn text, filed date);
CREATE TABLE quarters (cik bigint, company text, fy_end date, q_end date, revenue double precision,
                       rev_tag text, rev_accn text, rev_filed date, derived boolean,
                       receivables double precision, ar_accn text, ar_filed text);
CREATE TABLE beneish (cik bigint, company text, role text, sic text, enforcement text, fy_end date,
                      dsri double precision, gmi double precision, aqi double precision, sgi double precision,
                      depi double precision, sgai double precision, tata double precision, lvgi double precision,
                      m_score double precision, flagged text);
CREATE TABLE mdna_index (cik bigint, company text, form text, period date, filed date, accn text, doc text,
                         url text, file text, chars int, error text);
CREATE TABLE mdna_paragraphs (cik bigint, period date, para_no int, text text, url text);
\copy facts FROM '/data/facts.csv' CSV HEADER
\copy quarters FROM '/data/quarters.csv' CSV HEADER
\copy beneish FROM '/data/beneish.csv' CSV HEADER
\copy mdna_index FROM '/data/mdna_index.csv' CSV HEADER
\copy mdna_paragraphs FROM '/data/mdna_paragraphs.csv' CSV HEADER
SELECT 'facts', count(*) FROM facts UNION ALL SELECT 'quarters', count(*) FROM quarters
UNION ALL SELECT 'beneish', count(*) FROM beneish UNION ALL SELECT 'mdna_index', count(*) FROM mdna_index
UNION ALL SELECT 'mdna_paragraphs', count(*) FROM mdna_paragraphs;
SQL

[ -x /root/venv/bin/python ] || { python3 -m venv /root/venv && /root/venv/bin/pip install -q JayDeBeApi; }
JAR=$(ls /root/zetaris-platform/jdbc/*.jar | head -1)
U=$(grep '^ZETARIS_ADMIN_EMAIL=' /root/zetaris-platform/.env | cut -d= -f2-)
P=$(grep '^ZETARIS_ADMIN_PASSWORD=' /root/zetaris-platform/.env | cut -d= -f2-)
cat > /etc/systemd/system/zetaris-bridge.service <<EOF
[Unit]
Description=Veritas Zetaris SQL bridge
After=docker.service
[Service]
Environment=ZETARIS_USER=$U
Environment=ZETARIS_PASSWORD=$P
ExecStart=/root/venv/bin/python $V/bridge/zetaris_bridge.py --jar $JAR
Restart=always
[Install]
WantedBy=multi-user.target
EOF
chmod 600 /etc/systemd/system/zetaris-bridge.service
systemctl daemon-reload; systemctl enable -q --now zetaris-bridge; systemctl restart zetaris-bridge
until curl -sf localhost:8787/health >/dev/null; do sleep 1; done

sql() { curl -s localhost:8787/sql -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"sql": sys.argv[1]}))' "$1")"; echo; }
sql "CREATE DATASOURCE veritas_pg DESCRIBE BY \"Veritas as-filed SEC facts\" OPTIONS (jdbcdriver \"org.postgresql.Driver\", jdbcurl \"jdbc:postgresql://veritas-pg:5432/veritas\", username \"veritas\", password \"$PGPASS\", fetchsize \"1000\")"
for t in facts quarters beneish mdna_index mdna_paragraphs; do sql "REGISTER DATASOURCE TABLE '$t' FROM veritas_pg"; done
sql "SELECT concept, value, accn FROM veritas_pg.facts WHERE cik = 1336917 AND fy_end = '2015-12-31' AND concept = 'revenue'"

# Live REST source: SIC industry names from company_dns V4 (Zetaris getting-started recipe 12, V4 part),
# so the cohort query federates the Postgres facts with a REST API in one Lightning SQL statement.
sql 'CREATE LIGHTNING DATABASE COMPANY_DNS DESCRIBE BY "company_dns SIC reference data - section, division, group, class"'
sql 'CREATE LIGHTNING REST TABLE sic_codes_v4_raw FROM COMPANY_DNS REQUEST(endpoint "https://company-dns.mediumroast.io/V4.0/na/sic/code/%25", method "get", response_type "json", http_encoding "URLENCODED") HEADER (user-agent "veritas modakm.dev@gmail.com") BODY ()'
sql 'CACHE TABLE company_dns.sic_codes_v4_raw'
sql 'CREATE SCHEMASTORE CONTAINER company_dns'
# SEC filers carry SIC codes at three levels: class (3674), group (2040 = group 204 + "0") and
# division (2300 = division 23 + "00"). sic_names gives every level one code -> name row.
# company_dns has no 3576 (Arista), so joins against it are LEFT JOINs.
sql 'CREATE SCHEMASTORE VIEW sic_names WITH CONTAINER company_dns AS SELECT DISTINCT item.class_id AS code, item.class_desc AS name, "class" AS level FROM company_dns.sic_codes_v4_raw LATERAL VIEW explode(data) AS item UNION SELECT DISTINCT concat(item.group_id, "0") AS code, item.group_desc AS name, "group" AS level FROM company_dns.sic_codes_v4_raw LATERAL VIEW explode(data) AS item UNION SELECT DISTINCT concat(item.division_id, "00") AS code, item.division_desc AS name, "division" AS level FROM company_dns.sic_codes_v4_raw LATERAL VIEW explode(data) AS item'
sql "SELECT b.sic, s.level, s.name, count(*) AS company_years FROM veritas_pg.beneish b LEFT JOIN company_dns.sic_names s ON b.sic = s.code GROUP BY b.sic, s.level, s.name ORDER BY b.sic"
