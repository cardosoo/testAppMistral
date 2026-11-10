# Chat Mistral — app web minimale

Petite application web en TypeScript qui appelle l'API Mistral avec le SDK
TypeScript officiel [`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai),
avec une interface de chat simple (HTML/JS vanilla).

- Modèle utilisé : `mistral-small-latest`
- La clé `MISTRAL_API_KEY` n'existe que côté serveur (elle n'est jamais exposée au navigateur) :
  le frontend appelle uniquement la route locale `POST /api/chat`, qui fait l'appel à l'API Mistral.

## Prérequis

- Node.js 18+ (testé avec Node 22) et npm

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
MISTRAL_API_KEY=votre_cle_api
```

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
server.ts          # serveur Express : sert public/ + route POST /api/chat (appelle l'API Mistral)
public/index.html  # interface de chat (HTML/CSS/JS vanilla)
.env.example       # modèle de fichier .env (sans secret)
```

## Fonctionnement

1. Le navigateur envoie l'historique de la conversation à `POST /api/chat`.
2. Le serveur (seul détenteur de `MISTRAL_API_KEY`) appelle
   `client.chat.complete({ model: "mistral-small-latest", messages })` via le SDK officiel.
3. Le serveur renvoie uniquement la réponse du modèle au navigateur.
