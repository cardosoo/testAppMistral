-- db/01-demo-schema.sql — à exécuter DANS la base chatbot_demo :
--   psql -U postgres -h localhost -d chatbot_demo -f db/01-demo-schema.sql
-- Schéma + commentaires + droits read-only + données de démo (gestion des enseignements d'une UFR).

CREATE TABLE IF NOT EXISTS enseignant (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  statut TEXT NOT NULL,                          -- PR, MCF, MCF HDR, ATER, vacataire...
  charge_statutaire_heq INTEGER NOT NULL DEFAULT 192  -- charge statutaire en heures éq. TD
);

CREATE TABLE IF NOT EXISTS ue (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                     -- ex: INF101
  intitule TEXT NOT NULL,
  semestre TEXT NOT NULL,                        -- ex: S1, S2, S3
  credits_ects INTEGER NOT NULL,
  responsable_id INTEGER REFERENCES enseignant(id),
  heures_cm INTEGER NOT NULL DEFAULT 0,
  heures_td INTEGER NOT NULL DEFAULT 0,
  heures_tp INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS affectation (
  id SERIAL PRIMARY KEY,
  enseignant_id INTEGER NOT NULL REFERENCES enseignant(id),
  ue_id INTEGER NOT NULL REFERENCES ue(id),
  type_enseignement TEXT NOT NULL CHECK (type_enseignement IN ('CM', 'TD', 'TP')),
  groupe TEXT,                                   -- ex: TD-A, TP-2
  heures REAL NOT NULL                           -- volume horaire réel effectué
);

COMMENT ON TABLE enseignant IS 'Enseignants de l''UFR';
COMMENT ON COLUMN enseignant.statut IS 'Statut : PR, MCF, ATER, vacataire...';
COMMENT ON COLUMN enseignant.charge_statutaire_heq IS 'Charge statutaire en heures équivalent TD (192 = temps plein)';
COMMENT ON TABLE ue IS 'Unités d''enseignement (UE) proposées par semestre';
COMMENT ON COLUMN ue.code IS 'Code de l''UE, ex: INF101';
COMMENT ON COLUMN ue.semestre IS 'Semestre concerné : S1, S2, S3...';
COMMENT ON COLUMN ue.responsable_id IS 'Enseignant responsable de l''UE';
COMMENT ON TABLE affectation IS 'Affectations des enseignants aux UE (répartition des enseignements)';
COMMENT ON COLUMN affectation.type_enseignement IS 'Type : CM, TD ou TP';
COMMENT ON COLUMN affectation.heures IS 'Volume horaire réel effectué (heures éq. selon le type)';

-- Le chatbot ne voit que ces tables, en lecture seule :
GRANT USAGE ON SCHEMA public TO chatbot_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_read;

-- Données de démo
INSERT INTO enseignant (nom, prenom, email, statut, charge_statutaire_heq) VALUES
  ('Dupont', 'Marie', 'marie.dupont@univ.fr', 'PR', 192),
  ('Martin', 'Jean', 'jean.martin@univ.fr', 'MCF', 192),
  ('Bernard', 'Luc', 'luc.bernard@univ.fr', 'ATER', 192),
  ('Petit', 'Sophie', 'sophie.petit@univ.fr', 'MCF', 96),
  ('Durand', 'Paul', 'paul.durand@univ.fr', 'vacataire', 0);

INSERT INTO ue (code, intitule, semestre, credits_ects, responsable_id, heures_cm, heures_td, heures_tp) VALUES
  ('INF101', 'Bases de données', 'S1', 6, 1, 20, 20, 20),
  ('INF201', 'Algorithmique avancée', 'S2', 6, 2, 24, 24, 12),
  ('MAT101', 'Mathématiques pour l''informatique', 'S1', 6, 4, 30, 30, 0),
  ('PHY101', 'Physique des capteurs', 'S1', 4, 3, 16, 8, 12),
  ('INF301', 'Projet tutoré', 'S3', 4, 2, 0, 0, 48),
  ('STA201', 'Statistiques appliquées', 'S2', 5, 4, 20, 16, 0);

INSERT INTO affectation (enseignant_id, ue_id, type_enseignement, groupe, heures) VALUES
  (1, 1, 'CM', 'L1-info', 20),
  (1, 1, 'TD', 'TD-A', 10),
  (2, 2, 'CM', 'L2-info', 24),
  (2, 2, 'TP', 'TP-1', 6),
  (2, 5, 'TP', 'projet', 24),
  (3, 4, 'CM', 'L1-phy', 16),
  (3, 4, 'TP', 'TP-3', 6),
  (4, 3, 'CM', 'L1-math', 30),
  (4, 6, 'TD', 'TD-B', 8),
  (5, 1, 'TD', 'TD-B', 10),
  (5, 4, 'TD', 'TD-A', 8),
  (5, 6, 'TD', 'TD-C', 8);
