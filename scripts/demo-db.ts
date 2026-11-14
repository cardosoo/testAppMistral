/**
 * Démarre une petite base PostgreSQL de démo (embarquée, aucune install requise)
 * et y applique db/00-roles.sql (rôle read-only) + db/01-demo-schema.sql (tables + données).
 *
 *   npm run demo:db
 *
 * Puis configurez .env avec l'URL affichée (DATABASE_URL=...) et lancez `npm run dev`.
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PGPORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir: path.join(root, ".pgdata"),
  port,
  user: "postgres",
  password: "postgres",
  authMethod: "password",
  persistent: true,
});

const dataDir = path.join(root, ".pgdata");
if (existsSync(path.join(dataDir, "PG_VERSION"))) {
  console.log("Cluster .pgdata existant réutilisé");
} else {
  console.log("Initialisation du cluster PostgreSQL embarqué (dossier .pgdata)...");
  await pg.initialise();
}
await pg.start();
console.log(`PostgreSQL démarré sur le port ${port}`);

// 1) Rôle read-only + base de démo (équivalent de db/00-roles.sql)
const admin = pg.getPgClient("postgres");
await admin.connect();
await admin.query(
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatbot_read') THEN
       CREATE ROLE chatbot_read LOGIN PASSWORD 'chatbot_read_demo';
     END IF;
   END $$;`
);
await admin.query("ALTER ROLE chatbot_read SET default_transaction_read_only = on");
await admin.query("ALTER ROLE chatbot_read SET statement_timeout = '5s'");
await admin.query("ALTER ROLE chatbot_read SET idle_in_transaction_session_timeout = '10s'");
try {
  await pg.dropDatabase("chatbot_demo");
} catch {
  /* la base n'existe pas encore */
}
await pg.createDatabase("chatbot_demo");
await admin.end();

// 2) Schéma + données de démo (db/01-demo-schema.sql)
const demo = pg.getPgClient("chatbot_demo");
await demo.connect();
await demo.query(readFileSync(path.join(root, "db", "01-demo-schema.sql"), "utf8"));
await demo.end();

console.log("\n✅ Base de démo prête (rôle chatbot_read strictement read-only).");
console.log(`   admin  : postgres://postgres:postgres@localhost:${port}/postgres`);
console.log(`   NL2SQL : postgres://chatbot_read:chatbot_read_demo@localhost:${port}/chatbot_demo`);
console.log("\nAjoutez dans .env :");
console.log(`   DATABASE_URL=postgres://chatbot_read:chatbot_read_demo@localhost:${port}/chatbot_demo`);
console.log("\nDans un autre terminal :  npm run selftest  puis  npm run dev");
console.log("(Ctrl+C pour arrêter la base)\n");

// Garde le processus (et donc le cluster) vivant jusqu'à Ctrl+C
setInterval(() => {}, 60_000);
