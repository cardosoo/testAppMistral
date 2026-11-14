# Chat Mistral — app web minimale

Petite application web en TypeScript qui appelle l'API Mistral avec le SDK
TypeScript officiel [`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai),
avec une interface de chat simple (HTML/JS vanilla).

- Modèle utilisé : `mistral-small-latest`
- La clé `MISTRAL_API_KEY` n'existe que côté serveur (elle n'est jamais exposée au navigateur) :
  le frontend appelle uniquement la route locale `POST /api/chat`, qui fait l'appel à l'API Mistral.

## Prérequis

- Node.js 22.9+ (ou 20.18+), recommandé : Node 22, et npm
  (le chargement de `.env` repose sur le flag natif `--env-file-if-exists`, d'où cette version minimale)

## Installation

```bash
npm install
```

## Configuration

```bash
cp .env.example .env
```

Éditez `.env` et renseignez votre clé API Mistral (à créer sur
[console.mistral.ai](https://console.mistral.ai)) :

```bash
MISTRAL_API_KEY=mstrl_...
```

Le fichier `.env` est **chargé automatiquement au démarrage** du serveur (flag
`--env-file-if-exists=.env` dans les scripts npm) : aucun `export` n'est
nécessaire. Points d'attention :

- le fichier doit s'appeler exactement `.env` et se trouver à la racine du projet (à côté de `package.json`) ;
- la ligne doit être exactement `MISTRAL_API_KEY=mstrl_...` : pas d'espace autour du `=`, pas de guillemets ;
- après une modification de `.env`, **relancez** `npm run dev` (les variables d'environnement sont lues au démarrage du processus) ;
- alternative sans fichier `.env` : `export MISTRAL_API_KEY=mstrl_...` dans le shell, ou `MISTRAL_API_KEY=mstrl_... npm run dev`.

Le fichier `.env` est ignoré par git (voir `.gitignore`) : la clé ne doit jamais
être commitée ni embarquée dans le frontend.

## Exécution en local

```bash
npm run dev
```

Puis ouvrez <http://localhost:3000> dans votre navigateur.

Autres commandes utiles :

```bash
npm start        # lance le serveur sans rechargement à chaud (tsx server.ts)
npm run typecheck  # vérifie les types sans émettre de fichiers (tsc --noEmit)
```

## Structure

```
server.ts            # serveur Express : sert public/ + POST /api/chat + POST /api/ask-db (NL2SQL)
nl2sql.ts            # module NL2SQL générique : schéma pg_catalog, validation SQL, exécution read-only, orchestration LLM
public/index.html    # interface : chat libre + panneau "Interroger la base"
nl2sql.config.example.json # exemple de description métier des tables (copiez-le en nl2sql.config.json)
db/00-roles.sql      # rôle PostgreSQL chatbot_read strictement read-only + base chatbot_demo
db/01-demo-schema.sql# schéma de démo (enseignants, UE, affectations) + commentaires + données
scripts/demo-db.ts   # démarre une base Postgres de démo embarquée (npm run demo:db)
scripts/selftest.ts  # tests de sécurité NL2SQL sans appel LLM (npm run selftest)
.env.example         # modèle de fichier .env (sans secret)
```

## Fonctionnement

1. Le navigateur envoie l'historique de la conversation à `POST /api/chat`.
2. Le serveur (seul détenteur de `MISTRAL_API_KEY`) appelle
   `client.chat.complete({ model: "mistral-small-latest", messages })` via le SDK officiel.
3. Le serveur renvoie uniquement la réponse du modèle au navigateur.

## NL2SQL — interroger une base PostgreSQL en langage naturel

Le dépôt inclut un **prototype générique** (`nl2sql.ts` + route `POST /api/ask-db`) :
la question est traduite en SQL SELECT par le LLM (function calling), le SQL est
**validé** puis exécuté en **lecture seule**, et le résultat est reformulé en français.
L'UI affiche la réponse, la requête SQL générée et le tableau de résultats.

### Mise en route rapide (base de démo embarquée)

```bash
npm install
npm run demo:db          # démarre un PostgreSQL local (dossier .pgdata) + applique db/*.sql
# copiez la ligne DATABASE_URL affichée dans .env, avec votre MISTRAL_API_KEY
npm run dev              # http://localhost:3000 → panneau « Interroger la base »
npm run selftest         # vérifie la validation SQL + le blocage read-only (sans appel LLM)
```

Exemple de question : « Quels enseignants ont le plus d'heures d'enseignement ? »

Avec votre propre base : créez un **rôle read-only** (`db/00-roles.sql` en superuser),
appliquez votre schéma, puis `GRANT SELECT` à ce rôle, et mettez son URL dans `DATABASE_URL`.

### Sécurité (défense en profondeur)

1. **Validation applicative** (`node-sql-parser`) : un unique `SELECT`, uniquement sur les
   tables du schéma autorisé (whitelist), pas de `SELECT INTO`, fonctions dangereuses
   bloquées (`pg_sleep`, `dblink`, `lo_*`…).
2. **Exécution encadrée** : transaction `BEGIN READ ONLY`, `statement_timeout`,
   requête enveloppée dans `SELECT * FROM (...) LIMIT maxRows`.
3. **Rôle PostgreSQL read-only** : `default_transaction_read_only = on` + `statement_timeout`
   au niveau du rôle — même un SQL qui échapperait à la validation ne pourrait rien écrire.

### Variables d'environnement NL2SQL (optionnelles)

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | — | connexion du rôle read-only (active NL2SQL si définie) |
| `NL2SQL_SCHEMA` | `public` | schéma exposé au LLM |
| `NL2SQL_MAX_ROWS` | `200` | plafond de lignes retournées |
| `NL2SQL_TIMEOUT_MS` | `5000` | statement_timeout par requête |
| `NL2SQL_MODEL` | `mistral-small-latest` | modèle pour SQL + synthèse |
| `NL2SQL_MAX_SAMPLE_BYTES` | `20000` | taille max du JSON de résultats renvoyé au LLM |
| `NL2SQL_ALLOWED_TABLES` | toutes les tables du schéma | liste blanche de tables exposées au LLM (séparées par des virgules) |

> `npm run selftest` et `npm run demo:db` chargent aussi `.env` automatiquement
> (`--env-file-if-exists=.env`) : `DATABASE_URL` peut donc y être défini.
> Le selftest fonctionne sur n'importe quelle base (démo ou réelle) et n'effectue
> **aucune écriture persistante** (sonde dans une transaction annulée).
> Sur votre vraie base, utilisez impérativement un **rôle read-only**
> (`db/00-roles.sql` en superuser) dans `DATABASE_URL`.

### Endpoint

```bash
curl -X POST http://localhost:3000/api/ask-db \
  -H 'Content-Type: application/json' \
  -d '{"question": "Combien d''heures de CM au total au S1 ?"}'
# -> { "answer": "...", "sql": "SELECT ...", "columns": [...], "rows": [...], "rowCount": 1, "truncated": false }
```

Le schéma exposé au LLM est lu dans `pg_catalog` (tables, colonnes, commentaires
`COMMENT ON`, clés étrangères). **Deux façons de le rendre explicite**, complémentaires :

1. **`COMMENT ON TABLE/COLUMN` dans PostgreSQL** — définition stable des colonnes,
   voyage avec la base (visible dans `psql` avec `\d+`), lue automatiquement :
   ```sql
   COMMENT ON TABLE voeux IS 'Voeux des personnes : une ligne = une personne qui souhaite un enseignement';
   ```
2. **Fichier de configuration `nl2sql.config.json`** (copiez `nl2sql.config.example.json`,
   chemin surchargeable via `NL2SQL_CONFIG`) — pour le **vocabulaire métier**, les
   **chemins de jointure** et les **exemples question → SQL** (few-shot) :
   ```json
   {
     "databaseDescription": "Gestion des enseignements d'une UFR",
     "joinPaths": ["voeux.personne_id -> personne.id", "voeux.enseignement_id -> enseignement.id"],
     "tables": {
       "voeux": {
         "description": "Table CENTRALE : une ligne = une personne qui souhaite participer à un enseignement.",
         "aliases": ["voeux", "souhaits", "demandes"],
         "joins": ["personne -> voeux via voeux.personne_id, puis voeux -> enseignement via voeux.enseignement_id"]
       }
     },
     "rules": ["Pour relier une personne à ses enseignements, toujours passer par la table voeux."],
     "examples": [
       { "question": "À quels enseignements participe cardoso ?",
         "sql": "SELECT e.* FROM enseignement e JOIN voeux v ON v.enseignement_id = e.id JOIN personne p ON p.id = v.personne_id WHERE p.nom ILIKE '%cardoso%'" }
     ]
   }
   ```
   C'est typiquement ce qui corrige des jointures erronées : dites au LLM ce que signifie
   chaque table métier, quelles jointures utiliser, et donnez 2–3 exemples de vos
   questions habituelles. Réduisez aussi le bruit avec `NL2SQL_ALLOWED_TABLES`.

Sans `DATABASE_URL`, `/api/ask-db` renvoie 503 et seul le chat libre fonctionne.
