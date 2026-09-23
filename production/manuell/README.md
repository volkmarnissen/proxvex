# node-red → Postgres (mTLS) Messdaten — manuelles Runbook

Messdaten aus node-red fließen über **mTLS (cert-only)** in die neue Postgres-DB
`messdaten`. Umsetzung **ohne proxvex reconfigure/reinstall** — alles direkt in den
laufenden Containern bzw. in der node-red-UI.

```
modbus2mqtt --mTLS--> mosquitto --mTLS--> node-red --mTLS(cert-only)--> postgres (DB: messdaten)
```

node-red besitzt bereits ein mTLS-Client-Cert `CN=node-red` unter
`/certs/mtls/node-red/{cert,privkey,chain}.pem` (heute für MQTT genutzt). Dasselbe Cert
wird für Postgres wiederverwendet → die DB-Rolle heißt `node-red`.

Dateien in diesem Ordner:
- `messdaten-schema.sql` — DDL (Rolle, DB, Tabellen, Rechte)
- `node-red-postgres-flow.json` — Flow-Vorlage zum Import in die node-red-UI

---

## 1. Postgres-Container finden

```sh
pct list            # vm_id der Postgres heraussuchen
PG=<vmid>           # im Folgenden verwendet
```

## 2. cert-Auth-Status prüfen

```sh
pct exec $PG -- su postgres -c "psql -tAc 'SHOW ssl; SHOW ssl_ca_file;'"
pct exec $PG -- sh -c 'ls -l /certs/chain.pem; cat "$PGDATA/pg_hba.conf"'
```

- **Wenn** `ssl=on`, `ssl_ca_file=/certs/chain.pem` und `pg_hba.conf` bereits eine
  `hostssl … cert`-Zeile enthält → Config ist fertig, weiter mit **Schritt 4**.
- Sonst **Schritt 3**.

## 3. cert-Auth aktivieren (nur falls nötig)

> `ssl_ca_file` und `pg_hba.conf` sind per SIGHUP reloadbar → **kein Neustart**.
> Nur ein Wechsel `ssl off → on` braucht einen Container-Restart.

1. CA bereitstellen: `/certs/chain.pem` muss existieren. Fehlt sie, die CA-Datei dorthin legen.
2. In `$PGDATA/postgresql.conf` sicherstellen / ergänzen:
   ```
   ssl = on
   ssl_cert_file = '/certs/fullchain.pem'
   ssl_key_file  = '/certs/privkey.pem'
   ssl_ca_file   = '/certs/chain.pem'
   ```
3. In `$PGDATA/pg_hba.conf` — lokalen Socket trusted lassen, TCP nur per Cert:
   ```
   # TYPE     DATABASE   USER      ADDRESS      METHOD
   local      all        all                    trust
   hostssl    messdaten  node-red  0.0.0.0/0    cert
   hostssl    messdaten  node-red  ::/0         cert
   ```
   `cert` impliziert `clientcert=verify-full`: gültiges CA-signiertes Cert **und**
   CN == DB-User (`node-red`) erforderlich. Passwortlose Rolle reicht.
4. Übernehmen ohne Neustart:
   ```sh
   pct exec $PG -- su postgres -c "psql -c 'SELECT pg_reload_conf()'"
   ```

## 4. DB + Rolle + Schema anlegen

```sh
pct exec $PG -- su postgres -c 'psql -f -' < messdaten-schema.sql
```

Legt Rolle `node-red` (passwortlos), DB `messdaten` und die Tabellen
`messstelle` / `zaehler` / `messung` mit Rechten an. **Messstellen und Zähler trägst du
danach manuell ein** (node-red hat darauf nur Leserecht), z. B.:

```sql
-- pct exec $PG -- su postgres -c 'psql -d messdaten'
INSERT INTO messstelle (name) VALUES ('Wohnung 1 - Strom');
INSERT INTO zaehler (messstelle_id, zaehlernummer, einheit, gueltig_von)
VALUES ((SELECT id FROM messstelle WHERE name='Wohnung 1 - Strom'),
        '1ESY1234567890', 'kWh', DATE '2026-01-01');
```

## 5. node-red (UI)

1. **Palette Manager** → `node-red-contrib-postgresql` installieren.
2. **settings.js: Certs als `pgSsl` bereitstellen.** Der Config-Node der Postgres-Node
   bietet keine Felder für ca/cert/key, und `tls.connect` braucht die Cert-*Inhalte*,
   nicht Pfade. Daher die Certs einmal beim Boot laden. In `/data/settings.js`
   ergänzen (Datei liest oben bereits `const fs = require('fs')`):
   ```js
   // vor module.exports:
   const pgSsl = {
     ca:   fs.readFileSync('/certs/mtls/node-red/chain.pem'),
     cert: fs.readFileSync('/certs/mtls/node-red/cert.pem'),
     key:  fs.readFileSync('/certs/mtls/node-red/privkey.pem'),
     rejectUnauthorized: true,
   };
   // innerhalb module.exports = { … } ergänzen:
   functionGlobalContext: { pgSsl },
   ```
   Danach node-red neu starten (Container-Restart genügt, kein proxvex reinstall):
   `pct reboot <node-red-vmid>`.
3. **Flow importieren:** `node-red-postgres-flow.json` über Menü → *Import* einfügen.
   - Der `mqtt in`-Node referenziert die bestehende Broker-Config `mqtt-broker-mosquitto`
     (aus dem MQTT-Bridge-Flow). Beim Import ggf. erneut auswählen.
   - Topic-Filter (`modbus2mqtt/#`) und den Function-Node an das **reale modbus2mqtt-
     Topic-/Payload-Format anpassen** (Zählernummer + Wert + Zeitstempel extrahieren).
     Das Format steht erst fest, wenn in `modbus2mqtt-config.yaml` echte `devices`
     konfiguriert sind.
   - Im Function-Node ggf. `host` (Postgres-Hostname) anpassen — er muss zum CN/SAN des
     Postgres-Server-Certs passen, sonst schlägt `rejectUnauthorized:true` fehl.
4. **Deploy.**

Die Live-Verbindung kommt aus `msg.pgConfig` (mTLS), den der Function-Node setzt — der
`postgreSQLConfig`-Node ist nur Platzhalter, damit der `postgresql`-Node valide ist.

---

## Verifikation

```sh
# Cert-Verbindung von außen testen (verbindet OHNE Passwort):
psql "host=<pg-host> dbname=messdaten user=node-red sslmode=verify-full \
      sslrootcert=chain.pem sslcert=cert.pem sslkey=privkey.pem" -c '\dt'

# Passwort-TCP muss abgewiesen werden (cert-only bestaetigt).
```

- Test-Publish auf das Messdaten-Topic → neue Zeile in `messung` mit korrekt aufgelöstem
  `zaehler_id` (`SELECT * FROM messung ORDER BY id DESC LIMIT 5;`). Inserts ohne passenden
  gültigen Zähler treffen `WHERE`/`ON CONFLICT` und schreiben nichts — Stammdaten zuerst pflegen.

---

## ⚠️ Dauerhaftigkeit (Drift-Warnung)

Die manuellen Änderungen überleben Container-**Restarts** (liegen im data-Volume), aber
**nicht** ein späteres proxvex reconfigure/reinstall:

- `pg_hba.conf` / `postgresql.conf` werden ggf. von `conf-enable-ssl-app.sh` überschrieben —
  v. a. wenn managed `pg_client_cert` weiterhin `false` ist (dann wird das stock-pg_hba /
  Passwort-Auth wiederhergestellt).
- Der UI-Flow wird vom `1-upload-flows-json`-Template überschrieben; der per UI installierte
  npm-Node geht bei reinstall verloren; settings.js wird aus `node-red-settings.js` neu geschrieben.

**Für Dauerhaftigkeit später nachziehen** (optional, nicht jetzt nötig):
- managed `pg_client_cert=true` für die Postgres-App,
- `production/node-red-flows.json` um diesen Flow erweitern,
- `production/node-red-settings.js` um den `pgSsl`/`functionGlobalContext`-Block erweitern,
- `node-red-contrib-postgresql` ins npm-Install-Muster (OIDC-Skripte) aufnehmen.
