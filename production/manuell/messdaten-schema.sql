-- Messdaten-Datenbank für node-red -> Postgres (mTLS, cert-only)
--
-- Manuell einspielen (lokaler Socket = trust, kein Passwort nötig):
--   pct exec <PG-vmid> -- su postgres -c 'psql -f -' < messdaten-schema.sql
--
-- Authentifizierung erfolgt per Client-Zertifikat: node-red präsentiert
-- CN=node-red (/certs/mtls/node-red/cert.pem), daher heißt die Rolle "node-red"
-- und hat KEIN Passwort. Messstellen + Zähler werden danach manuell gepflegt;
-- node-red schreibt ausschließlich in messung.

\set ON_ERROR_STOP on

-- 1. Rolle (passwortlos; Auth per Cert). Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'node-red') THEN
    CREATE ROLE "node-red" LOGIN;
  END IF;
END
$$;

-- 2. Datenbank. CREATE DATABASE kennt kein IF NOT EXISTS und darf nicht in einer
--    Transaktion laufen -> per \gexec nur anlegen, wenn nicht vorhanden.
SELECT 'CREATE DATABASE messdaten OWNER "node-red"'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'messdaten')\gexec

\connect messdaten

-- 3. Schema --------------------------------------------------------------

-- Messstelle: physischer Messpunkt. Manuell gepflegt.
CREATE TABLE IF NOT EXISTS messstelle (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  beschreibung text,
  angelegt_am  timestamptz NOT NULL DEFAULT now()
);

-- Zähler: gehört zu einer Messstelle, gilt für einen Datumsbereich.
-- Zählerwechsel = neuer Satz mit neuem gueltig_von/-bis. gueltig_bis NULL = offen.
CREATE TABLE IF NOT EXISTS zaehler (
  id            serial PRIMARY KEY,
  messstelle_id integer NOT NULL REFERENCES messstelle(id),
  zaehlernummer text NOT NULL,
  einheit       text,                       -- z.B. kWh, m3
  gueltig_von   date NOT NULL,
  gueltig_bis   date,
  UNIQUE (zaehlernummer, gueltig_von)
);
CREATE INDEX IF NOT EXISTS zaehler_nummer_idx ON zaehler (zaehlernummer);

-- Messung: von node-red befüllt. Ein Wert je Zähler+Zeitpunkt (dedupe).
CREATE TABLE IF NOT EXISTS messung (
  id          bigserial PRIMARY KEY,
  zaehler_id  integer NOT NULL REFERENCES zaehler(id),
  gemessen_am timestamptz NOT NULL,
  wert        numeric NOT NULL,
  quelle      text NOT NULL DEFAULT 'node-red',
  UNIQUE (zaehler_id, gemessen_am)
);
CREATE INDEX IF NOT EXISTS messung_zaehler_zeit_idx ON messung (zaehler_id, gemessen_am DESC);

-- 4. Rechte: node-red darf Messwerte schreiben, Stammdaten nur lesen ------
GRANT CONNECT ON DATABASE messdaten TO "node-red";
GRANT USAGE  ON SCHEMA public       TO "node-red";
GRANT SELECT ON messstelle, zaehler TO "node-red";
GRANT SELECT, INSERT ON messung     TO "node-red";
GRANT USAGE, SELECT ON SEQUENCE messung_id_seq TO "node-red";
