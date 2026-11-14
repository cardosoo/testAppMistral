-- db/00-roles.sql — à exécuter en TANT QUE SUPERUSER PostgreSQL, sur la base "postgres" :
--   psql -U postgres -h localhost -f db/00-roles.sql
-- Crée le rôle strictement read-only utilisé par le chatbot NL2SQL, puis la base de démo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatbot_read') THEN
    CREATE ROLE chatbot_read LOGIN PASSWORD 'chatbot_read_demo';
  END IF;
END
$$;

-- Défense en profondeur côté base : le rôle ne peut JAMAIS écrire,
-- et chaque requête est limitée dans le temps.
ALTER ROLE chatbot_read SET default_transaction_read_only = on;
ALTER ROLE chatbot_read SET statement_timeout = '5s';
ALTER ROLE chatbot_read SET idle_in_transaction_session_timeout = '10s';

-- Ignorer l'erreur si la base existe déjà.
CREATE DATABASE chatbot_demo;
